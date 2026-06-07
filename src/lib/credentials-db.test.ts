import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { __setMasterKeyForTests } from './crypto/envelope';
import {
  deleteCredential,
  getCredentialMetadata,
  getCredentialToken,
  listCredentials,
  upsertCredential,
} from './credentials-db';

// We can't easily isolate the data file under test, so we swap the
// globalThis-cached singleton from runs-db.ts with an in-memory handle.
// runs-db.ts itself reads `globalThis.__runsDb` first, so seeding it
// before the first import sidesteps the disk-backed open. The schema
// statements below mirror runs-db.ts:SCHEMA_STATEMENTS exactly so
// migrations don't run a second time.

type GlobalWithDb = typeof globalThis & {
  __runsDb?: DatabaseType;
  __runsStmts?: unknown;
  __credStmts?: unknown;
};
const g = globalThis as GlobalWithDb;

const TEST_MASTER_KEY = randomBytes(32);

function freshDb(): DatabaseType {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.pragma('foreign_keys = ON');
  // Minimal schema: the user_credentials table is the only one this
  // suite needs, but include `runs` so any incidental references in
  // runs-db.ts wouldn't error on startup.
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      crew_id TEXT NOT NULL,
      crew_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      exit_code INTEGER,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      owner_id TEXT NOT NULL DEFAULT '__legacy__',
      owner_pid INTEGER,
      owner_host TEXT
    );
    CREATE TABLE user_credentials (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_login TEXT,
      account_id TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      data_key_wrapped TEXT NOT NULL,
      connected_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(owner_id, provider)
    );
    CREATE INDEX idx_user_credentials_owner ON user_credentials(owner_id);
  `);
  return db;
}

beforeAll(() => {
  __setMasterKeyForTests(TEST_MASTER_KEY);
});

beforeEach(() => {
  // Reset both the DB singleton and the prepared-statement caches so
  // each test gets a clean slate. credentials-db.ts gates its cache on
  // DB-handle identity, so swapping the handle is sufficient to bust it.
  g.__runsDb = freshDb();
  g.__runsStmts = undefined;
  g.__credStmts = undefined;
});

afterEach(() => {
  g.__runsDb?.close();
  g.__runsDb = undefined;
  g.__runsStmts = undefined;
  g.__credStmts = undefined;
});

describe('upsertCredential', () => {
  it('stores a new credential and returns the public view', async () => {
    const result = await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: ['repo', 'read:user'],
      token: 'ghp_secret_token_value',
    });
    expect(result.provider).toBe('github');
    expect(result.accountLogin).toBe('octocat');
    expect(result.accountId).toBe('42');
    expect(result.scopes).toEqual(['repo', 'read:user']);
    expect(result.lastUsedAt).toBeNull();
    expect(typeof result.connectedAt).toBe('number');
    // Public view must not include any secret material.
    const keys = Object.keys(result);
    for (const forbidden of ['token', 'ciphertext', 'iv', 'authTag', 'dataKeyWrapped']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('overwrites the previous credential for the same (owner, provider)', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: ['repo'],
      token: 'old-token',
    });
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: ['repo', 'workflow'],
      token: 'new-token',
    });

    const fetched = await getCredentialToken('user-a', 'github');
    expect(fetched).toBe('new-token');

    const list = await listCredentials('user-a');
    expect(list).toHaveLength(1);
    expect(list[0].scopes).toEqual(['repo', 'workflow']);
  });

  it('rejects empty ownerId or empty token', async () => {
    await expect(
      upsertCredential({
        ownerId: '',
        provider: 'github',
        accountLogin: null,
        accountId: null,
        scopes: [],
        token: 'x',
      })
    ).rejects.toThrow();
    await expect(
      upsertCredential({
        ownerId: 'user-a',
        provider: 'github',
        accountLogin: null,
        accountId: null,
        scopes: [],
        token: '',
      })
    ).rejects.toThrow();
  });
});

describe('getCredentialToken', () => {
  it('returns null for a missing row', async () => {
    expect(await getCredentialToken('nobody', 'github')).toBeNull();
  });

  it('decrypts a stored token', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: 'ghp_roundtrip',
    });
    expect(await getCredentialToken('user-a', 'github')).toBe('ghp_roundtrip');
  });

  it('updates last_used_at after a successful decrypt', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: 'ghp_stamp',
    });
    // Sanity: fresh credential has null last_used_at.
    const before = await listCredentials('user-a');
    expect(before[0].lastUsedAt).toBeNull();

    await getCredentialToken('user-a', 'github');

    const after = await listCredentials('user-a');
    expect(after[0].lastUsedAt).not.toBeNull();
    expect(typeof after[0].lastUsedAt).toBe('number');
  });

  it('enforces owner isolation — user A cannot read user B token', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'alice',
      accountId: '1',
      scopes: [],
      token: 'alice-token',
    });
    await upsertCredential({
      ownerId: 'user-b',
      provider: 'github',
      accountLogin: 'bob',
      accountId: '2',
      scopes: [],
      token: 'bob-token',
    });

    expect(await getCredentialToken('user-a', 'github')).toBe('alice-token');
    expect(await getCredentialToken('user-b', 'github')).toBe('bob-token');
    // Wrong owner returns null even though the provider matches.
    expect(await getCredentialToken('user-c', 'github')).toBeNull();
  });
});

describe('listCredentials', () => {
  it('returns no secret material', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: ['repo'],
      token: 'do-not-leak',
    });
    const list = await listCredentials('user-a');
    expect(list).toHaveLength(1);
    const cred = list[0] as unknown as Record<string, unknown>;
    expect(cred.ciphertext).toBeUndefined();
    expect(cred.iv).toBeUndefined();
    expect(cred.authTag).toBeUndefined();
    expect(cred.dataKeyWrapped).toBeUndefined();
    expect(cred.token).toBeUndefined();
    // And the serialized form must not contain the plaintext token.
    expect(JSON.stringify(list)).not.toContain('do-not-leak');
  });

  it('returns empty array for an unknown owner', async () => {
    expect(await listCredentials('nobody')).toEqual([]);
  });

  it('lists only the caller-owned rows', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'alice',
      accountId: '1',
      scopes: [],
      token: 't-a',
    });
    await upsertCredential({
      ownerId: 'user-b',
      provider: 'github',
      accountLogin: 'bob',
      accountId: '2',
      scopes: [],
      token: 't-b',
    });
    const aList = await listCredentials('user-a');
    expect(aList).toHaveLength(1);
    expect(aList[0].accountLogin).toBe('alice');
  });
});

describe('deleteCredential', () => {
  it('returns false for a non-existent row', async () => {
    expect(await deleteCredential('nobody', 'github')).toBe(false);
  });

  it('returns true and removes the row when one exists', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: 'gone-soon',
    });
    expect(await deleteCredential('user-a', 'github')).toBe(true);
    expect(await getCredentialToken('user-a', 'github')).toBeNull();
    expect(await listCredentials('user-a')).toEqual([]);
  });

  it('does not touch another owner row', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'alice',
      accountId: '1',
      scopes: [],
      token: 't-a',
    });
    await upsertCredential({
      ownerId: 'user-b',
      provider: 'github',
      accountLogin: 'bob',
      accountId: '2',
      scopes: [],
      token: 't-b',
    });
    expect(await deleteCredential('user-a', 'github')).toBe(true);
    expect(await getCredentialToken('user-b', 'github')).toBe('t-b');
  });
});

/* ------------------------------------------------------------------ */
/*  metadata (PR 12)                                                  */
/* ------------------------------------------------------------------ */

describe('metadata', () => {
  it('roundtrips metadata through upsertCredential -> listCredentials', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: ['repo'],
      token: 't',
      metadata: {
        organizations: [
          {
            login: 'acme',
            id: 1,
            description: 'Acme Inc',
            avatarUrl: 'https://example.test/a.png',
          },
        ],
      },
    });
    const list = await listCredentials('user-a');
    expect(list).toHaveLength(1);
    expect(list[0].metadata).toEqual({
      organizations: [
        {
          login: 'acme',
          id: 1,
          description: 'Acme Inc',
          avatarUrl: 'https://example.test/a.png',
        },
      ],
    });
  });

  it('defaults metadata to {} when omitted on upsert', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: 't',
    });
    const list = await listCredentials('user-a');
    expect(list[0].metadata).toEqual({});
  });

  it('getCredentialMetadata returns parsed object', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: 't',
      metadata: { foo: 'bar', nested: { n: 1 } },
    });
    const meta = await getCredentialMetadata('user-a', 'github');
    expect(meta).toEqual({ foo: 'bar', nested: { n: 1 } });
  });

  it('getCredentialMetadata returns null when no row exists', async () => {
    expect(await getCredentialMetadata('nobody', 'github')).toBeNull();
  });

  it('enforces owner isolation on metadata reads', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'alice',
      accountId: '1',
      scopes: [],
      token: 't-a',
      metadata: { organizations: [{ login: 'alice-org', id: 1, description: null, avatarUrl: null }] },
    });
    await upsertCredential({
      ownerId: 'user-b',
      provider: 'github',
      accountLogin: 'bob',
      accountId: '2',
      scopes: [],
      token: 't-b',
      metadata: { organizations: [{ login: 'bob-org', id: 2, description: null, avatarUrl: null }] },
    });
    // A sees only A's metadata; B sees only B's. No cross-owner leak.
    const aMeta = await getCredentialMetadata('user-a', 'github');
    const bMeta = await getCredentialMetadata('user-b', 'github');
    expect(aMeta).toEqual({
      organizations: [{ login: 'alice-org', id: 1, description: null, avatarUrl: null }],
    });
    expect(bMeta).toEqual({
      organizations: [{ login: 'bob-org', id: 2, description: null, avatarUrl: null }],
    });
    // listCredentials also stays owner-scoped for the metadata field.
    const aList = await listCredentials('user-a');
    expect(aList[0].metadata).toEqual(aMeta);
    expect(JSON.stringify(aList)).not.toContain('bob-org');
  });

  it('does not leak the plaintext token into the metadata column', async () => {
    // The metadata column lives alongside the encrypted envelope but
    // must never receive secret material. Probe the raw row to confirm
    // the plaintext token only appears in the (decrypted) token path.
    const SECRET = 'ghp_super_secret_xyz';
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: SECRET,
      metadata: { hint: 'this should not contain the token' },
    });
    const row = g.__runsDb!
      .prepare(
        'SELECT metadata, ciphertext FROM user_credentials WHERE owner_id = ?'
      )
      .get('user-a') as { metadata: string; ciphertext: string };
    expect(row.metadata).not.toContain(SECRET);
    // And the ciphertext is base64 of the envelope, definitely not the plaintext.
    expect(row.ciphertext).not.toContain(SECRET);
    // The public projection's metadata also stays clear of the secret.
    const list = await listCredentials('user-a');
    expect(JSON.stringify(list[0].metadata)).not.toContain(SECRET);
  });

  it('overwrites previous metadata on re-upsert (replace, not merge)', async () => {
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: 't1',
      metadata: { organizations: [{ login: 'old', id: 1, description: null, avatarUrl: null }] },
    });
    await upsertCredential({
      ownerId: 'user-a',
      provider: 'github',
      accountLogin: 'octocat',
      accountId: '42',
      scopes: [],
      token: 't2',
      metadata: { organizations: [{ login: 'new', id: 2, description: null, avatarUrl: null }] },
    });
    const meta = await getCredentialMetadata('user-a', 'github');
    expect(meta).toEqual({
      organizations: [{ login: 'new', id: 2, description: null, avatarUrl: null }],
    });
  });
});
