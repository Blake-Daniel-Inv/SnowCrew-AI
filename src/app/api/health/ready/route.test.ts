import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCredentialsKey, checkEnvVars } from './route';

/**
 * The route's GET handler stitches together three small checks; the
 * checks are independently exported so we can unit-test their decision
 * tables without spinning up the SQLite singleton. The full GET handler
 * is exercised by manual smoke tests post-deploy (curl + ready=200) and
 * the route itself is too thin to merit a vi.mock dance for the DB call.
 */

describe('checkEnvVars (local mode)', () => {
  beforeEach(() => {
    // Clear container-mode signals so the default branch is "local mode".
    vi.unstubAllEnvs();
  });

  it('passes when SNOWFLAKE_ACCOUNT_ID + SNOWFLAKE_PAT are set', () => {
    const result = checkEnvVars({
      SNOWFLAKE_ACCOUNT_ID: 'org-acct',
      SNOWFLAKE_PAT: 'pat/xxx',
    });
    expect(result).toBe('ok');
  });

  it('accepts SNOWFLAKE_JWT as an alternative to PAT', () => {
    const result = checkEnvVars({
      SNOWFLAKE_ACCOUNT_ID: 'org-acct',
      SNOWFLAKE_JWT: 'eyJ.x.y',
    });
    expect(result).toBe('ok');
  });

  it('reports missing SNOWFLAKE_ACCOUNT_ID when only credential is set', () => {
    const result = checkEnvVars({
      SNOWFLAKE_PAT: 'pat/xxx',
    });
    expect(result).toBe('missing:SNOWFLAKE_ACCOUNT_ID');
  });

  it('reports missing credential when only account id is set', () => {
    const result = checkEnvVars({
      SNOWFLAKE_ACCOUNT_ID: 'org-acct',
    });
    expect(result).toBe('missing:SNOWFLAKE_PAT|SNOWFLAKE_JWT');
  });

  it('reports both missing when nothing is set', () => {
    const result = checkEnvVars({});
    // We don't pin the exact ordering / separator — just assert it's the
    // missing-tagged form and names both required vars.
    expect(result).toMatch(/^missing:/);
    expect(result).toContain('SNOWFLAKE_ACCOUNT_ID');
    expect(result).toContain('SNOWFLAKE_PAT|SNOWFLAKE_JWT');
  });

  it('treats empty / whitespace-only env vars as missing', () => {
    const result = checkEnvVars({
      SNOWFLAKE_ACCOUNT_ID: '   ',
      SNOWFLAKE_PAT: '',
    });
    expect(result).toMatch(/^missing:/);
    expect(result).toContain('SNOWFLAKE_ACCOUNT_ID');
  });
});

describe('checkEnvVars (SPCS mode)', () => {
  it('passes when CONTAINER_MODE=1 and SNOWFLAKE_HOST is set', () => {
    const result = checkEnvVars({
      CONTAINER_MODE: '1',
      SNOWFLAKE_HOST: 'snowflake.internal',
    });
    expect(result).toBe('ok');
  });

  it('passes when NEXT_PUBLIC_CONTAINER_MODE=1 with SNOWFLAKE_HOST', () => {
    const result = checkEnvVars({
      NEXT_PUBLIC_CONTAINER_MODE: '1',
      SNOWFLAKE_HOST: 'snowflake.internal',
    });
    expect(result).toBe('ok');
  });

  it('passes when DATA_DIR is set (SPCS entrypoint signal) with SNOWFLAKE_HOST', () => {
    const result = checkEnvVars({
      DATA_DIR: '/data',
      SNOWFLAKE_HOST: 'snowflake.internal',
    });
    expect(result).toBe('ok');
  });

  it('reports missing SNOWFLAKE_HOST in SPCS mode', () => {
    const result = checkEnvVars({
      CONTAINER_MODE: '1',
    });
    expect(result).toBe('missing:SNOWFLAKE_HOST');
  });

  it('does NOT require SNOWFLAKE_ACCOUNT_ID or PAT in SPCS mode', () => {
    // SPCS uses the session-token mount, not env-based creds. The probe
    // must not 503 just because PAT/JWT are absent when CONTAINER_MODE=1.
    const result = checkEnvVars({
      CONTAINER_MODE: '1',
      SNOWFLAKE_HOST: 'snowflake.internal',
    });
    expect(result).toBe('ok');
  });

  it('reveals only var NAMES, never values, in the missing label', () => {
    // Defense in depth — the route surfaces this string in the 503 body,
    // and a future contributor accidentally including the actual env
    // value here would leak credentials.
    const env = {
      SNOWFLAKE_ACCOUNT_ID: '',
      SNOWFLAKE_PAT: 'pat/super-secret-NEVER-LEAK',
    };
    const result = checkEnvVars(env);
    expect(result).not.toContain('super-secret');
  });
});

describe('checkCredentialsKey', () => {
  it("returns 'ok' when CREDENTIALS_MASTER_KEY is set", () => {
    expect(
      checkCredentialsKey({
        CREDENTIALS_MASTER_KEY: 'some-32-byte-hex-or-base64-value',
      })
    ).toBe('ok');
  });

  it("returns 'missing' when CREDENTIALS_MASTER_KEY is absent", () => {
    expect(checkCredentialsKey({})).toBe('missing');
  });

  it("returns 'missing' when CREDENTIALS_MASTER_KEY is whitespace", () => {
    expect(
      checkCredentialsKey({
        CREDENTIALS_MASTER_KEY: '   ',
      })
    ).toBe('missing');
  });
});
