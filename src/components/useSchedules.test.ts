import { describe, expect, it } from 'vitest';
import {
  COMMON_TIMEZONES,
  formatRelativeFuture,
  formatRelativePast,
  looksLikeValidCron,
} from './useSchedules';

describe('formatRelativeFuture', () => {
  const now = Date.parse('2026-05-13T12:00:00Z');

  it('renders "Paused" for null timestamps', () => {
    expect(formatRelativeFuture(null, now)).toBe('Paused');
  });

  it('renders "Due now" for past timestamps', () => {
    expect(
      formatRelativeFuture('2026-05-13T11:59:00Z', now)
    ).toBe('Due now');
  });

  it('renders "in <1 min" inside the first minute', () => {
    expect(
      formatRelativeFuture('2026-05-13T12:00:30Z', now)
    ).toBe('in <1 min');
  });

  it('renders minutes / hours / days appropriately', () => {
    expect(formatRelativeFuture('2026-05-13T12:30:00Z', now)).toBe('in 30 min');
    expect(formatRelativeFuture('2026-05-13T15:00:00Z', now)).toBe('in 3 hr');
    expect(formatRelativeFuture('2026-05-16T12:00:00Z', now)).toBe('in 3 days');
    expect(formatRelativeFuture('2026-05-14T12:00:00Z', now)).toBe('in 24 hr');
  });

  it('handles unparseable input gracefully', () => {
    expect(formatRelativeFuture('not-a-date', now)).toBe('Unknown');
  });
});

describe('formatRelativePast', () => {
  const now = Date.parse('2026-05-13T12:00:00Z');

  it('renders "Never" for null', () => {
    expect(formatRelativePast(null, now)).toBe('Never');
  });

  it('renders minutes / hours / days', () => {
    expect(formatRelativePast('2026-05-13T11:30:00Z', now)).toBe('30 min ago');
    expect(formatRelativePast('2026-05-13T09:00:00Z', now)).toBe('3 hr ago');
    expect(formatRelativePast('2026-05-10T12:00:00Z', now)).toBe('3 days ago');
  });

  it('renders "just now" for sub-minute deltas', () => {
    expect(formatRelativePast('2026-05-13T11:59:30Z', now)).toBe('just now');
  });
});

describe('looksLikeValidCron', () => {
  it('accepts the common 5-field shapes', () => {
    expect(looksLikeValidCron('* * * * *')).toBe(true);
    expect(looksLikeValidCron('0 9 * * *')).toBe(true);
    expect(looksLikeValidCron('*/15 * * * *')).toBe(true);
    expect(looksLikeValidCron('0 9 * * 1-5')).toBe(true);
    expect(looksLikeValidCron('0 9,17 * * *')).toBe(true);
  });

  it('rejects non-5-field inputs', () => {
    expect(looksLikeValidCron('* * * *')).toBe(false);
    expect(looksLikeValidCron('* * * * * *')).toBe(false);
    expect(looksLikeValidCron('')).toBe(false);
    expect(looksLikeValidCron('   ')).toBe(false);
  });

  it('rejects fields containing illegal characters', () => {
    expect(looksLikeValidCron('@ * * * *')).toBe(false);
    expect(looksLikeValidCron('0 9 * * <')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(looksLikeValidCron(null as unknown as string)).toBe(false);
    expect(looksLikeValidCron(undefined as unknown as string)).toBe(false);
    expect(looksLikeValidCron(42 as unknown as string)).toBe(false);
  });
});

describe('COMMON_TIMEZONES', () => {
  it('starts with UTC and contains a handful of canonical zones', () => {
    expect(COMMON_TIMEZONES[0]).toBe('UTC');
    expect(COMMON_TIMEZONES).toContain('America/New_York');
    expect(COMMON_TIMEZONES).toContain('Europe/London');
  });

  it('contains no duplicates', () => {
    const set = new Set(COMMON_TIMEZONES);
    expect(set.size).toBe(COMMON_TIMEZONES.length);
  });
});
