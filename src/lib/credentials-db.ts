import { randomUUID } from 'node:crypto';
import { getRunsDb } from './runs-db';
import { decrypt, encrypt } from './crypto/envelope';
import type {
  CredentialProvider,
  UserCredentialPublic,
} from '@/types';

/**
 * Owner-scoped CRUD for encrypted per-user credentials. All decryption
 * happens inside this module — callers receive either `UserCredentialPublic`
 * (no secret material) or a plaintext token string, never the wire-format
 * envelope.
 *
 * The UNIQUE(owner_id, provider) constraint enforces "one provider per
 * user" at the DB layer, so upsert is the only correct way to store a
 * new token: re-connecting GitHub overwrites the previous row instead of
 * leaving stale ciphertext around.
 *
 * Every query is owner-scoped — there is no path through this module
 * that lets caller A read caller B's credentials. The credentials-db
 * tests exercise that isolation directly.
 */

/** Re-export of UserCredentialPublic for callers who want a single import. */
export type { UserCredentialPublic } from '@/types';

/* ------------------------------------------------------------------ */
/*  Input / row types                                                 */
/* ------------------------------------------------------------------ */

export interface UpsertCredentialInput {
  ownerId: string;
  provider: CredentialProvider;
  accountLogin: string | null;
  accountId: string | null;
  scopes: string[];
  /** Plaintext token. Encrypted before persistence; never logged. */
  token: string;
  /** Unix epoch ms; null/undefined means no known expiry. */
  expiresAt?: number | null;
  /**
   * Optional non-secret per-credential context (e.g. GitHub org
   * memberships). Stored UNENCRYPTED in the `metadata` JSON column
   * because (a) the values are already exposed by the upstream API to
   * anyone with the token and (b) querying / surfacing them in the UI
   * without a decrypt round-trip is the point. Defaults to `{}`.
   *
   * Note: while the column itself is not encrypted, every read path is
   * still owner-scoped — getCredentialMetadata and listCredentials both
   * gate on owner_id, so caller A cannot read caller B's metadata.
   */
  metadata?: Record<string, unknown>;
}

interface CredentialRow {
  id: string;
  owner_id: string;
  provider: string;
  account_login: string | null;
  account_id: string | null;
  scopes: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  data_key_wrapped: string;
  connected_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  /** JSON-encoded blob; parsed via safeJsonObject when projected. */
  metadata: string;
}

/* ------------------------------------------------------------------ */
/*  Prepared statement cache (mirrors runs-db.ts pattern)             */
/* ------------------------------------------------------------------ */

import type { Database as DatabaseType, Statement } from 'better-sqlite3';

interface CredentialStatements {
  selectByOwnerProvider: Statement;
  selectAllByOwner: Statement;
  selectMetadataByOwnerProvider: Statement;
  upsert: Statement;
  updateLastUsed: Statement;
  deleteByOwnerProvider: Statement;
}

type GlobalWithStmts = typeof globalThis & {
  __credStmts?: { db: DatabaseType; stmts: CredentialStatements };
};
const g = globalThis as GlobalWithStmts;

/**
 * Lazily build and cache prepared statements keyed off the singleton DB
 * handle (same pattern as runs-db.ts:getStatements). The cache is
 * invalidated when the underlying handle is reassigned — important for
 * tests that rebuild the DB between cases.
 */
function getStatements(): CredentialStatements {
  const db = getRunsDb();
  const cached = g.__credStmts;
  if (cached && cached.db === db) return cached.stmts;
  const stmts: CredentialStatements = {
    selectByOwnerProvider: db.prepare(
      `SELECT * FROM user_credentials WHERE owner_id = ? AND provider = ?`
    ),
    selectAllByOwner: db.prepare(
      `SELECT * FROM user_credentials WHERE owner_id = ? ORDER BY connected_at DESC`
    ),
    // Owner-scoped metadata fetch — projects only the JSON blob so the
    // decrypt path isn't exercised when callers only want non-secret
    // context (e.g. cached org list for the UI).
    selectMetadataByOwnerProvider: db.prepare(
      `SELECT metadata FROM user_credentials WHERE owner_id = ? AND provider = ?`
    ),
    // UPSERT by (owner_id, provider) — the table's UNIQUE constraint
    // makes this the natural conflict target. id is preserved on update
    // so any future foreign keys pointing at the row remain stable.
    // `metadata` is JSON-stringified before binding; on conflict we
    // overwrite the previous blob so a re-connect replaces (not merges)
    // the prior context.
    upsert: db.prepare(
      `INSERT INTO user_credentials
        (id, owner_id, provider, account_login, account_id, scopes,
         ciphertext, iv, auth_tag, data_key_wrapped,
         connected_at, last_used_at, expires_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, provider) DO UPDATE SET
         account_login    = excluded.account_login,
         account_id       = excluded.account_id,
         scopes           = excluded.scopes,
         ciphertext       = excluded.ciphertext,
         iv               = excluded.iv,
         auth_tag         = excluded.auth_tag,
         data_key_wrapped = excluded.data_key_wrapped,
         connected_at     = excluded.connected_at,
         expires_at       = excluded.expires_at,
         metadata         = excluded.metadata,
         last_used_at     = NULL`
    ),
    updateLastUsed: db.prepare(
      `UPDATE user_credentials SET last_used_at = ? WHERE owner_id = ? AND provider = ?`
    ),
    deleteByOwnerProvider: db.prepare(
      `DELETE FROM user_credentials WHERE owner_id = ? AND provider = ?`
    ),
  };
  g.__credStmts = { db, stmts };
  return stmts;
}

/* ------------------------------------------------------------------ */
/*  Row mapping                                                       */
/* ------------------------------------------------------------------ */

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return parsed as string[];
    }
  } catch {
    // fall through to empty
  }
  return [];
}

/**
 * Parse a JSON blob expected to be a plain object. Anything else
 * (array, primitive, malformed) collapses to `{}` so a corrupt
 * metadata column can never crash a caller that just wants "the
 * blob".
 */
function safeJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

function rowToPublic(row: CredentialRow): UserCredentialPublic {
  return {
    provider: row.provider as CredentialProvider,
    accountLogin: row.account_login,
    accountId: row.account_id,
    scopes: safeJsonArray(row.scopes),
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    metadata: safeJsonObject(row.metadata) as UserCredentialPublic['metadata'],
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Upsert a credential. The previous token (if any) is overwritten in
 * place: same row id is preserved on conflict, but ciphertext/IV/auth
 * tag/wrapped key all get fresh values. `last_used_at` resets to NULL
 * on update so a stale "last used" doesn't carry over to a new token.
 *
 * Returns the public view of the stored row. The plaintext token never
 * leaves this function.
 */
export async function upsertCredential(
  input: UpsertCredentialInput
): Promise<UserCredentialPublic> {
  if (!input.ownerId) {
    throw new Error('upsertCredential: ownerId is required');
  }
  if (!input.token) {
    throw new Error('upsertCredential: token is required');
  }

  const envelope = encrypt(input.token);
  const now = Date.now();
  const id = randomUUID();
  const stmts = getStatements();

  // Metadata defaults to `{}` so the column's NOT NULL constraint is
  // satisfied even when the caller doesn't pass anything.
  const metadataJson = JSON.stringify(input.metadata ?? {});

  stmts.upsert.run(
    id,
    input.ownerId,
    input.provider,
    input.accountLogin,
    input.accountId,
    JSON.stringify(input.scopes || []),
    envelope.ciphertext,
    envelope.iv,
    envelope.authTag,
    envelope.dataKeyWrapped,
    now,
    null, // last_used_at — fresh credential has not been used yet
    input.expiresAt ?? null,
    metadataJson
  );

  // Re-read so the caller gets the canonical view (including the
  // preserved connected_at if this was a true update).
  const row = stmts.selectByOwnerProvider.get(
    input.ownerId,
    input.provider
  ) as CredentialRow | undefined;
  if (!row) {
    throw new Error('upsertCredential: row vanished after upsert');
  }
  return rowToPublic(row);
}

/**
 * Decrypt and return the token for (ownerId, provider). Updates
 * last_used_at on a successful read so the integrations UI can show
 * "last used 2 hours ago". Returns null if no row exists. Throws if
 * the row exists but decryption fails (tamper / wrong master key).
 */
export async function getCredentialToken(
  ownerId: string,
  provider: CredentialProvider
): Promise<string | null> {
  if (!ownerId) return null;
  const stmts = getStatements();
  const row = stmts.selectByOwnerProvider.get(ownerId, provider) as
    | CredentialRow
    | undefined;
  if (!row) return null;

  const plaintext = decrypt({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    dataKeyWrapped: row.data_key_wrapped,
  });

  // Only stamp last_used_at after a successful decrypt — we don't want
  // tamper attempts to look like usage. Best-effort; if this UPDATE
  // fails for some unrelated reason we still return the token (the
  // surface area for the caller is "did I get a token", not "did
  // telemetry succeed").
  try {
    stmts.updateLastUsed.run(Date.now(), ownerId, provider);
  } catch {
    // swallow; non-fatal
  }

  return plaintext;
}

/**
 * Owner-scoped read of the non-secret `metadata` JSON column. Returns
 * the parsed object, or `null` when no (owner, provider) row exists.
 * Never throws on malformed JSON — corrupt blobs collapse to `{}`.
 *
 * Cheap relative to getCredentialToken because there is no decrypt /
 * AES-GCM round trip — the metadata column is plaintext JSON.
 */
export async function getCredentialMetadata(
  ownerId: string,
  provider: CredentialProvider
): Promise<Record<string, unknown> | null> {
  if (!ownerId) return null;
  const stmts = getStatements();
  const row = stmts.selectMetadataByOwnerProvider.get(ownerId, provider) as
    | { metadata: string }
    | undefined;
  if (!row) return null;
  return safeJsonObject(row.metadata);
}

/**
 * List the caller's stored credentials. Returns the public view only —
 * no ciphertext, IV, auth tag, wrapped data key, or plaintext token.
 */
export async function listCredentials(
  ownerId: string
): Promise<UserCredentialPublic[]> {
  if (!ownerId) return [];
  const stmts = getStatements();
  const rows = stmts.selectAllByOwner.all(ownerId) as CredentialRow[];
  return rows.map(rowToPublic);
}

/**
 * Delete a credential. Returns true when a row was actually removed,
 * false otherwise — the route layer can use this to distinguish 404
 * from 204.
 */
export async function deleteCredential(
  ownerId: string,
  provider: CredentialProvider
): Promise<boolean> {
  if (!ownerId) return false;
  const stmts = getStatements();
  const info = stmts.deleteByOwnerProvider.run(ownerId, provider);
  return info.changes > 0;
}
