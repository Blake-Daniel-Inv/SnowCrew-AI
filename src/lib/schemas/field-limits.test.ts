import { describe, it, expect } from 'vitest';
import { FIELD_LIMITS, FIELD_PATTERNS } from './field-limits';

describe('FIELD_LIMITS', () => {
  it('exposes the canonical cap set', () => {
    // If any of these keys are removed, downstream Zod schemas + the
    // NodeConfigPanel counters will fail to import — this test guards
    // the surface so a careless rename gets caught here first.
    expect(Object.keys(FIELD_LIMITS).sort()).toEqual([
      'ARR',
      'LONG',
      'MEDIUM',
      'PROMPT_MAX',
      'RECIPIENTS_MAX',
      'SHORT',
    ]);
  });

  it('preserves the pre-consolidation values', () => {
    // Before PR 17 these were declared three times across schemas with
    // identical values. Lock the values in so a typo in this central
    // module is caught against the previously-deployed behavior.
    expect(FIELD_LIMITS.SHORT).toBe(200);
    expect(FIELD_LIMITS.MEDIUM).toBe(2_000);
    expect(FIELD_LIMITS.LONG).toBe(20_000);
    expect(FIELD_LIMITS.PROMPT_MAX).toBe(50_000);
    expect(FIELD_LIMITS.ARR).toBe(200);
    expect(FIELD_LIMITS.RECIPIENTS_MAX).toBe(50);
  });

  it('keeps the cap ordering monotonic', () => {
    expect(FIELD_LIMITS.SHORT).toBeLessThan(FIELD_LIMITS.MEDIUM);
    expect(FIELD_LIMITS.MEDIUM).toBeLessThan(FIELD_LIMITS.LONG);
    expect(FIELD_LIMITS.LONG).toBeLessThan(FIELD_LIMITS.PROMPT_MAX);
  });
});

describe('FIELD_PATTERNS.snowflakeAccount', () => {
  const { regex, examples } = FIELD_PATTERNS.snowflakeAccount;

  it('accepts the documented example strings', () => {
    for (const sample of examples) {
      expect(regex.test(sample)).toBe(true);
    }
  });

  it('accepts realistic Snowflake locators', () => {
    expect(regex.test('acme-prod')).toBe(true);
    expect(regex.test('acme.us-east-1.aws')).toBe(true);
    expect(regex.test('ACME_PROD')).toBe(true);
    expect(regex.test('acme123')).toBe(true);
  });

  it('rejects URL-injection attempts', () => {
    // Locator-as-URL would let an attacker redirect the bearer-token
    // header to an attacker-controlled host; the regex must reject
    // anything containing a slash, scheme, or whitespace.
    expect(regex.test('evil.com/path')).toBe(false);
    expect(regex.test('https://evil.com')).toBe(false);
    expect(regex.test('acme prod')).toBe(false);
    expect(regex.test('acme..prod')).toBe(false);
  });
});

describe('FIELD_PATTERNS.passwordEnvVar', () => {
  const { regex, examples } = FIELD_PATTERNS.passwordEnvVar;

  it('accepts the documented example strings', () => {
    for (const sample of examples) {
      expect(regex.test(sample)).toBe(true);
    }
  });

  it('rejects env-var enumeration attempts', () => {
    // The runner reads process.env[passwordEnvVar]; allowing arbitrary
    // names would let a malicious workspace exfiltrate AWS/OPENAI keys.
    expect(regex.test('AWS_SECRET_ACCESS_KEY')).toBe(false);
    expect(regex.test('OPENAI_API_KEY')).toBe(false);
    expect(regex.test('snowflake_pat')).toBe(false); // lowercase
    expect(regex.test('SNOWFLAKE_')).toBe(false); // regex requires at least one char after the underscore
    expect(regex.test('SNOWFLAKE')).toBe(false); // missing _
  });
});

describe('FIELD_PATTERNS help/regex alignment', () => {
  // Smoke test that the user-facing help text doesn't lie about the
  // regex. If a future contributor changes the regex without updating
  // the examples (or vice versa), this fires.
  for (const key of Object.keys(FIELD_PATTERNS) as Array<keyof typeof FIELD_PATTERNS>) {
    it(`${key}: every example matches the regex`, () => {
      const { regex, examples } = FIELD_PATTERNS[key];
      for (const sample of examples) {
        expect(regex.test(sample)).toBe(true);
      }
    });

    it(`${key}: help string mentions the constraint`, () => {
      // A weak coupling test — the help string should reference either
      // the prefix or the character class. Catches an empty/truncated
      // help when someone forgets to fill it in.
      expect(FIELD_PATTERNS[key].help.length).toBeGreaterThan(20);
    });
  }
});
