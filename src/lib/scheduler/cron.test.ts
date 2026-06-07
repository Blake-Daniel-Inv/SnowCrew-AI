import { describe, expect, it } from 'vitest';
import { humanizeCron, nextFireTime, parseCron } from './cron';

describe('parseCron', () => {
  it('accepts a valid 5-field cron expression', () => {
    const result = parseCron('0 9 * * *', 'UTC');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects an obvious garbage expression with a message', () => {
    const result = parseCron('bogus', 'UTC');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/.+/); // non-empty message
  });

  it('rejects an empty expression', () => {
    expect(parseCron('', 'UTC').valid).toBe(false);
    expect(parseCron('   ', 'UTC').valid).toBe(false);
  });

  it('rejects a missing timezone', () => {
    expect(parseCron('0 9 * * *', '').valid).toBe(false);
  });

  it('accepts a known IANA timezone', () => {
    const result = parseCron('0 9 * * *', 'America/New_York');
    expect(result.valid).toBe(true);
  });

  it('rejects an obviously fake timezone', () => {
    const result = parseCron('0 9 * * *', 'Not/A/Zone');
    expect(result.valid).toBe(false);
  });
});

describe('nextFireTime', () => {
  it('returns the next 09:00 UTC for "0 9 * * *"', () => {
    // 2026-05-12T00:00:00Z → next 09:00 UTC is the same day at 09:00.
    const after = new Date('2026-05-12T00:00:00Z');
    const next = nextFireTime('0 9 * * *', 'UTC', after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-12T09:00:00.000Z');
  });

  it('returns next Monday 09:00 UTC for "0 9 * * 1"', () => {
    // 2026-05-12T00:00:00Z is a Tuesday → next Monday is 2026-05-18.
    const after = new Date('2026-05-12T00:00:00Z');
    const next = nextFireTime('0 9 * * 1', 'UTC', after);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-05-18T09:00:00.000Z');
  });

  it('honors timezones — "0 9 * * *" differs between UTC and America/New_York', () => {
    const after = new Date('2026-05-12T00:00:00Z');
    const utc = nextFireTime('0 9 * * *', 'UTC', after);
    const ny = nextFireTime('0 9 * * *', 'America/New_York', after);
    expect(utc).not.toBeNull();
    expect(ny).not.toBeNull();
    expect(utc!.toISOString()).not.toBe(ny!.toISOString());
  });

  it('returns null on parse error', () => {
    expect(nextFireTime('not-a-cron', 'UTC', new Date())).toBeNull();
  });

  it('returns null when "after" is invalid', () => {
    expect(
      nextFireTime('0 9 * * *', 'UTC', new Date('not-a-date'))
    ).toBeNull();
  });

  it('does NOT return the cursor when "after" equals an exact fire time', () => {
    // currentDate is exclusive — at 09:00 we should get the NEXT day's
    // 09:00, not the cursor itself. This is critical for the daemon's
    // post-fire next_fire_at computation: we want the future window,
    // not "right now".
    const at = new Date('2026-05-12T09:00:00Z');
    const next = nextFireTime('0 9 * * *', 'UTC', at);
    expect(next!.toISOString()).toBe('2026-05-13T09:00:00.000Z');
  });
});

describe('humanizeCron', () => {
  it('renders "Every minute" for * * * * *', () => {
    expect(humanizeCron('* * * * *')).toBe('Every minute');
  });

  it('renders "Every hour at 30 minutes past" for 30 * * * *', () => {
    expect(humanizeCron('30 * * * *')).toBe('Every hour at 30 minutes past');
  });

  it('renders "Every day at <time>" for daily fixed-hour patterns', () => {
    expect(humanizeCron('0 9 * * *')).toBe('Every day at 9:00 AM');
    expect(humanizeCron('30 14 * * *')).toBe('Every day at 2:30 PM');
    expect(humanizeCron('0 0 * * *')).toBe('Every day at 12:00 AM');
  });

  it('renders "Every <Day> at <time>" for weekly patterns', () => {
    expect(humanizeCron('0 9 * * 1')).toBe('Every Monday at 9:00 AM');
    expect(humanizeCron('0 9 * * 0')).toBe('Every Sunday at 9:00 AM');
  });

  it('renders "On day N of each month" for monthly patterns', () => {
    expect(humanizeCron('0 9 15 * *')).toBe(
      'On day 15 of each month at 9:00 AM'
    );
  });

  it('falls back to "Custom schedule" for anything not recognized', () => {
    expect(humanizeCron('*/15 * * * *')).toBe('Custom schedule');
    expect(humanizeCron('0 9,17 * * *')).toBe('Custom schedule');
    expect(humanizeCron('0 9 * * 1-5')).toBe('Custom schedule');
    expect(humanizeCron('')).toBe('Custom schedule');
    expect(humanizeCron('not a cron')).toBe('Custom schedule');
  });
});
