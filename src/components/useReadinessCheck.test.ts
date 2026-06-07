// Pure-function tests for parseReadiness — the response-shape helper
// pulled out of useReadinessCheck so the parsing logic is testable
// without a React render surface. vitest.config.ts pins us to the
// `node` environment (no jsdom), which is also why we test the parser
// rather than the hook.
//
// Cases mirror the contract documented in src/app/api/health/ready/route.ts:
//   - 200 with all ok
//   - 503 with db failed
//   - 503 with envVars missing a single var
//   - 503 with envVars missing two groups (the `|` separator)
//   - 503 with credentialsKey missing
//   - malformed payload (null, wrong shape, missing checks)
//   - network error simulation (callers pass `null` when fetch fails)

import { describe, expect, it } from 'vitest';
import { parseReadiness } from './useReadinessCheck';

describe('parseReadiness', () => {
  it('parses a 200 all-ok payload', () => {
    const r = parseReadiness({
      status: 'ok',
      service: 'snowcrewai',
      checks: { db: 'ok', envVars: 'ok', credentialsKey: 'ok' },
      mode: 'local',
    });
    expect(r.status).toBe('ready');
    expect(r.checks.db).toBe('ok');
    expect(r.checks.envVars).toBe('ok');
    expect(r.checks.credentialsKey).toBe('ok');
    expect(r.mode).toBe('local');
  });

  it('parses a 503 with db failed', () => {
    const r = parseReadiness({
      status: 'not_ready',
      checks: { db: 'failed', envVars: 'ok', credentialsKey: 'ok' },
      mode: 'spcs',
    });
    expect(r.status).toBe('not_ready');
    expect(r.checks.db).toBe('failed');
    expect(r.checks.envVars).toBe('ok');
    expect(r.mode).toBe('spcs');
  });

  it('parses a 503 with envVars missing one variable', () => {
    const r = parseReadiness({
      status: 'not_ready',
      checks: {
        db: 'ok',
        envVars: 'missing:SNOWFLAKE_ACCOUNT_ID',
        credentialsKey: 'ok',
      },
      mode: 'local',
    });
    expect(r.status).toBe('not_ready');
    expect(r.checks.envVars).toEqual({ missing: ['SNOWFLAKE_ACCOUNT_ID'] });
  });

  it('parses a 503 with envVars missing two groups using `|`', () => {
    // Server emits `missing:SNOWFLAKE_ACCOUNT_ID,SNOWFLAKE_PAT|SNOWFLAKE_JWT`
    // — comma separates entries, `|` is an either-of group. The UI wants
    // every variable name to surface individually so users see the
    // complete fix list.
    const r = parseReadiness({
      status: 'not_ready',
      checks: {
        db: 'ok',
        envVars: 'missing:SNOWFLAKE_ACCOUNT_ID,SNOWFLAKE_PAT|SNOWFLAKE_JWT',
        credentialsKey: 'ok',
      },
      mode: 'local',
    });
    expect(r.status).toBe('not_ready');
    expect(r.checks.envVars).toEqual({
      missing: ['SNOWFLAKE_ACCOUNT_ID', 'SNOWFLAKE_PAT', 'SNOWFLAKE_JWT'],
    });
  });

  it('dedupes repeated tokens inside the missing list', () => {
    const r = parseReadiness({
      status: 'not_ready',
      checks: {
        db: 'ok',
        envVars: 'missing:FOO,FOO|BAR,BAR',
        credentialsKey: 'ok',
      },
      mode: 'local',
    });
    expect(r.checks.envVars).toEqual({ missing: ['FOO', 'BAR'] });
  });

  it('parses a 503 with credentialsKey missing', () => {
    const r = parseReadiness({
      status: 'not_ready',
      checks: { db: 'ok', envVars: 'ok', credentialsKey: 'missing' },
      mode: 'local',
    });
    expect(r.status).toBe('not_ready');
    expect(r.checks.credentialsKey).toBe('missing');
  });

  it('treats null / undefined payload as unknown status', () => {
    expect(parseReadiness(null).status).toBe('unknown');
    expect(parseReadiness(undefined).status).toBe('unknown');
  });

  it('treats malformed payload (no checks block) as unknown without crashing', () => {
    const r = parseReadiness({ status: 'whatever' });
    expect(r.status).toBe('unknown');
    expect(r.checks.db).toBe('unknown');
    expect(r.checks.envVars).toBe('ok');
    expect(r.checks.credentialsKey).toBe('unknown');
    expect(r.mode).toBe('unknown');
  });

  it('treats a malformed envVars value as ok (parent status carries the signal)', () => {
    // If the server emitted something unexpected, we don't want to
    // false-positive a "missing" banner. The outer `status: 'not_ready'`
    // tells the user something is wrong; envVars='ok' just means our
    // parser couldn't decode this specific check.
    const r = parseReadiness({
      status: 'not_ready',
      checks: { db: 'failed', envVars: 42, credentialsKey: 'ok' },
      mode: 'local',
    });
    expect(r.status).toBe('not_ready');
    expect(r.checks.envVars).toBe('ok');
  });

  it('simulates network error: callers pass null on fetch failure', () => {
    // performFetch() in the hook calls .json().catch(() => null) and
    // then parseReadiness(null). That path must yield 'unknown' so the
    // UI renders the yellow "cannot verify" banner.
    const r = parseReadiness(null);
    expect(r.status).toBe('unknown');
    expect(r.mode).toBe('unknown');
  });
});
