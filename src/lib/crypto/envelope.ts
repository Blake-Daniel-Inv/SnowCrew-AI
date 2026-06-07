import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

/**
 * AES-256-GCM envelope encryption for per-user credentials.
 *
 * Threat model: the SQLite file holds long-lived secrets (OAuth tokens,
 * PATs). A backup or stolen disk should not yield plaintext tokens.
 * Storing AES-GCM ciphertext + a per-row wrapped data key gives us:
 *   - Defense in depth: rotating the master key (future work) only
 *     requires re-wrapping the per-row data keys, not re-encrypting
 *     every ciphertext.
 *   - Tamper detection: GCM's auth tag is verified on decrypt, so a
 *     modified row throws instead of silently returning garbage.
 *
 * Master key contract: `CREDENTIALS_MASTER_KEY` is base64-encoded 32
 * bytes. We load it once per process and reuse. If unset in non-test
 * mode, the first call throws with a clear remediation pointer.
 *
 * No new dependencies: everything here is built into Node ≥ 20.
 */

/** Bytes for AES-256 keys. */
const KEY_BYTES = 32;
/** GCM standard IV size — 96 bits / 12 bytes. */
const IV_BYTES = 12;
/** GCM auth tag size — 128 bits / 16 bytes. */
const AUTH_TAG_BYTES = 16;

const ENV_VAR = 'CREDENTIALS_MASTER_KEY';

/**
 * Wire format for a single encrypted credential. All fields are
 * base64-encoded. `ciphertext`/`iv`/`authTag` belong to the payload
 * encryption; `dataKeyWrapped` carries its own IV+tag bundled into a
 * single base64 string (iv || ciphertext || authTag).
 */
export interface CredentialEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  dataKeyWrapped: string;
}

let cachedMasterKey: Buffer | null = null;

/**
 * Decode and cache the master key. Throws with a clear remediation
 * pointer if the env var is missing in non-test mode. Tests that need
 * a key without one in the env may call `__setMasterKeyForTests`.
 */
export function getCredentialsMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const raw = process.env[ENV_VAR];
  if (!raw || raw.length === 0) {
    // Inside vitest/jest we let the test set the key explicitly via
    // __setMasterKeyForTests; never throw just because the runner
    // didn't export it.
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      throw new Error(
        `${ENV_VAR} is not set. In tests, call __setMasterKeyForTests() before invoking envelope crypto.`
      );
    }
    throw new Error(
      `${ENV_VAR} is required for credential encryption but is not set. ` +
        `Generate one with \`openssl rand -base64 32\` and add it to your ` +
        `.env file. See .env.example for the canonical entry.`
    );
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    throw new Error(
      `${ENV_VAR} is not valid base64. Generate a fresh key with \`openssl rand -base64 32\`.`
    );
  }

  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `${ENV_VAR} must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        `Regenerate with \`openssl rand -base64 32\`.`
    );
  }

  cachedMasterKey = decoded;
  return cachedMasterKey;
}

/**
 * Test-only override. Bypasses the env var and seeds the per-process
 * cache. Exposed so unit tests can run without polluting process.env.
 */
export function __setMasterKeyForTests(key: Buffer | null): void {
  cachedMasterKey = key;
}

/**
 * Wrap a 32-byte data key under the master key using AES-256-GCM.
 * Output layout (all base64): iv (12 B) || ciphertext (32 B) || tag (16 B)
 * concatenated and base64-encoded as a single field — keeps the storage
 * column count small and lets us rotate the master key in a single
 * pass per row in a future migration.
 */
function wrapDataKey(dataKey: Buffer): string {
  const master = getCredentialsMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', master, iv) as CipherGCM;
  const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, wrapped, tag]).toString('base64');
}

/**
 * Reverse wrapDataKey. Throws on tag mismatch (tamper detection) or on
 * a malformed payload (wrong length).
 */
function unwrapDataKey(packed: string): Buffer {
  const master = getCredentialsMasterKey();
  const buf = Buffer.from(packed, 'base64');
  // iv (12) + ciphertext (32) + tag (16) = 60 bytes exactly.
  const expectedLen = IV_BYTES + KEY_BYTES + AUTH_TAG_BYTES;
  if (buf.length !== expectedLen) {
    throw new Error(
      `wrapped data key has wrong length: expected ${expectedLen}, got ${buf.length}`
    );
  }
  const iv = buf.subarray(0, IV_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, IV_BYTES + KEY_BYTES);
  const tag = buf.subarray(IV_BYTES + KEY_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', master, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a plaintext credential under a fresh per-row data key, then
 * wrap that data key under the master key. Outputs are base64 so they
 * slot directly into TEXT columns.
 */
export function encrypt(plaintext: string): CredentialEnvelope {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string plaintext');
  }
  const dataKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv) as CipherGCM;
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const dataKeyWrapped = wrapDataKey(dataKey);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    dataKeyWrapped,
  };
}

/**
 * Decrypt an envelope. Throws on tamper (auth-tag mismatch) or on a
 * malformed wrapped data key. Callers should treat any thrown error
 * here as a hard failure — do NOT fall back to "no token" silently,
 * because that hides on-disk corruption.
 */
export function decrypt(envelope: CredentialEnvelope): string {
  const dataKey = unwrapDataKey(envelope.dataKeyWrapped);
  const iv = Buffer.from(envelope.iv, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');

  if (iv.length !== IV_BYTES) {
    throw new Error(`envelope.iv has wrong length: ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`envelope.authTag has wrong length: ${authTag.length}`);
  }

  const decipher = createDecipheriv('aes-256-gcm', dataKey, iv) as DecipherGCM;
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
