import { describe, it, expect } from 'vitest';
import {
  classifyCounterTone,
  isOverLimit,
  isPatternInvalid,
} from './FieldHints';
import { FIELD_LIMITS, FIELD_PATTERNS } from '@/lib/schemas/field-limits';

describe('classifyCounterTone', () => {
  it('returns muted below 75% of the cap', () => {
    expect(classifyCounterTone(0, 100)).toBe('muted');
    expect(classifyCounterTone(50, 100)).toBe('muted');
    expect(classifyCounterTone(74, 100)).toBe('muted');
  });

  it('returns warn from 75% to 94% inclusive', () => {
    expect(classifyCounterTone(75, 100)).toBe('warn');
    expect(classifyCounterTone(90, 100)).toBe('warn');
    expect(classifyCounterTone(94, 100)).toBe('warn');
  });

  it('returns error at 95% and above (including over-cap)', () => {
    expect(classifyCounterTone(95, 100)).toBe('error');
    expect(classifyCounterTone(99, 100)).toBe('error');
    expect(classifyCounterTone(100, 100)).toBe('error');
    expect(classifyCounterTone(101, 100)).toBe('error');
    expect(classifyCounterTone(1_000_000, 100)).toBe('error');
  });

  it('treats non-positive max as muted (no counter)', () => {
    expect(classifyCounterTone(5, 0)).toBe('muted');
    expect(classifyCounterTone(5, -1)).toBe('muted');
    expect(classifyCounterTone(5, NaN)).toBe('muted');
  });

  it('clamps negative current to zero', () => {
    expect(classifyCounterTone(-50, 100)).toBe('muted');
  });

  it('uses real FIELD_LIMITS bounds correctly', () => {
    // 1,500 chars of a 2,000-cap MEDIUM field is 75% → warn.
    expect(classifyCounterTone(1_500, FIELD_LIMITS.MEDIUM)).toBe('warn');
    expect(classifyCounterTone(1_900, FIELD_LIMITS.MEDIUM)).toBe('error');
    // 14,999 chars of a 20,000-cap LONG field is still muted (74.99%).
    expect(classifyCounterTone(14_999, FIELD_LIMITS.LONG)).toBe('muted');
  });
});

describe('isOverLimit', () => {
  it('is false at or below the cap', () => {
    expect(isOverLimit(99, 100)).toBe(false);
    expect(isOverLimit(100, 100)).toBe(false);
  });

  it('is true past the cap', () => {
    expect(isOverLimit(101, 100)).toBe(true);
  });

  it('is false when the cap is non-positive', () => {
    expect(isOverLimit(5, 0)).toBe(false);
    expect(isOverLimit(5, -1)).toBe(false);
  });
});

describe('isPatternInvalid', () => {
  const { regex: account } = FIELD_PATTERNS.snowflakeAccount;
  const { regex: envVar } = FIELD_PATTERNS.passwordEnvVar;

  it('returns false for a missing pattern', () => {
    expect(isPatternInvalid('whatever', undefined)).toBe(false);
  });

  it('returns false for empty input even when pattern is set', () => {
    // Empty input is the "leave default" signal; never flag it as
    // invalid. Mirrors the `^$|...` clause baked into every schema.
    expect(isPatternInvalid('', account)).toBe(false);
    expect(isPatternInvalid('', envVar)).toBe(false);
  });

  it('flags a malformed env var', () => {
    expect(isPatternInvalid('snowflake_pat', envVar)).toBe(true);
    expect(isPatternInvalid('AWS_KEY', envVar)).toBe(true);
  });

  it('passes a well-formed env var', () => {
    expect(isPatternInvalid('SNOWFLAKE_PAT', envVar)).toBe(false);
    expect(isPatternInvalid('SNOWFLAKE_PAT_PROD', envVar)).toBe(false);
  });

  it('flags a URL-shaped account locator', () => {
    expect(isPatternInvalid('evil.com/path', account)).toBe(true);
  });

  it('passes a real account locator', () => {
    expect(isPatternInvalid('acme-prod', account)).toBe(false);
    expect(isPatternInvalid('acme.us-east-1.aws', account)).toBe(false);
  });
});
