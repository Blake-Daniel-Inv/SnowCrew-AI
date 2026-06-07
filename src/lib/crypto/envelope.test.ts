import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  __setMasterKeyForTests,
  decrypt,
  encrypt,
  getCredentialsMasterKey,
  type CredentialEnvelope,
} from './envelope';

const TEST_KEY = randomBytes(32);

describe('envelope crypto', () => {
  beforeEach(() => {
    __setMasterKeyForTests(TEST_KEY);
  });

  afterEach(() => {
    __setMasterKeyForTests(null);
  });

  it('round-trips a plaintext token', () => {
    const plaintext = 'ghp_aaaabbbbccccddddeeeeffffgggghhhhiiii';
    const env = encrypt(plaintext);
    expect(decrypt(env)).toBe(plaintext);
  });

  it('produces fresh IV / data key on every call', () => {
    const a = encrypt('hello');
    const b = encrypt('hello');
    // Same plaintext, different ciphertext envelopes — proves the data
    // key + IV are not reused.
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.dataKeyWrapped).not.toBe(b.dataKeyWrapped);
  });

  it('detects tampering with ciphertext', () => {
    const env = encrypt('secret');
    const buf = Buffer.from(env.ciphertext, 'base64');
    buf[0] = buf[0] ^ 0x01; // flip a single bit
    const tampered: CredentialEnvelope = {
      ...env,
      ciphertext: buf.toString('base64'),
    };
    expect(() => decrypt(tampered)).toThrow();
  });

  it('detects tampering with the auth tag', () => {
    const env = encrypt('secret');
    const buf = Buffer.from(env.authTag, 'base64');
    buf[0] = buf[0] ^ 0x01;
    const tampered: CredentialEnvelope = {
      ...env,
      authTag: buf.toString('base64'),
    };
    expect(() => decrypt(tampered)).toThrow();
  });

  it('detects tampering with the wrapped data key', () => {
    const env = encrypt('secret');
    const buf = Buffer.from(env.dataKeyWrapped, 'base64');
    // Flip a byte inside the wrapped ciphertext region (after the 12-B IV).
    buf[15] = buf[15] ^ 0x01;
    const tampered: CredentialEnvelope = {
      ...env,
      dataKeyWrapped: buf.toString('base64'),
    };
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects a wrapped data key of the wrong length', () => {
    const env = encrypt('secret');
    const truncated: CredentialEnvelope = {
      ...env,
      dataKeyWrapped: Buffer.from('too short').toString('base64'),
    };
    expect(() => decrypt(truncated)).toThrow(/wrapped data key/);
  });

  it('round-trips multi-byte unicode', () => {
    const plaintext = 'ghp_token_with_emoji_🦊_and_中文';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips empty string', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('outputs valid base64 in every field', () => {
    const env = encrypt('hello');
    const isB64 = (s: string) => Buffer.from(s, 'base64').toString('base64') === s;
    expect(isB64(env.ciphertext)).toBe(true);
    expect(isB64(env.iv)).toBe(true);
    expect(isB64(env.authTag)).toBe(true);
    expect(isB64(env.dataKeyWrapped)).toBe(true);
    // IV must decode to 12 bytes, auth tag to 16 bytes.
    expect(Buffer.from(env.iv, 'base64').length).toBe(12);
    expect(Buffer.from(env.authTag, 'base64').length).toBe(16);
  });
});

describe('getCredentialsMasterKey', () => {
  const previousKey = process.env.CREDENTIALS_MASTER_KEY;

  afterEach(() => {
    __setMasterKeyForTests(null);
    if (previousKey === undefined) {
      delete process.env.CREDENTIALS_MASTER_KEY;
    } else {
      process.env.CREDENTIALS_MASTER_KEY = previousKey;
    }
  });

  it('throws a helpful error when the env var is missing (test mode)', () => {
    __setMasterKeyForTests(null);
    delete process.env.CREDENTIALS_MASTER_KEY;
    expect(() => getCredentialsMasterKey()).toThrow(
      /CREDENTIALS_MASTER_KEY is not set/
    );
  });

  it('throws when the master key is the wrong length', () => {
    __setMasterKeyForTests(null);
    // 16 random bytes — wrong size for AES-256.
    process.env.CREDENTIALS_MASTER_KEY = randomBytes(16).toString('base64');
    expect(() => getCredentialsMasterKey()).toThrow(/exactly 32 bytes/);
  });

  it('caches the parsed key across calls', () => {
    __setMasterKeyForTests(null);
    process.env.CREDENTIALS_MASTER_KEY = randomBytes(32).toString('base64');
    const a = getCredentialsMasterKey();
    const b = getCredentialsMasterKey();
    expect(a).toBe(b); // identity, not just equality
  });
});
