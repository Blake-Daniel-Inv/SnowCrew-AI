import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limit';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to capacity within a single burst', () => {
    const limiter = createRateLimiter({
      tokensPerInterval: 5,
      intervalMs: 60_000,
    });
    for (let i = 0; i < 5; i += 1) {
      const r = limiter.check('user-1');
      expect(r.allowed, `attempt ${i + 1}`).toBe(true);
      expect(r.retryAfterSec).toBe(0);
    }
  });

  it('rejects the (capacity + 1)th request with a positive Retry-After', () => {
    const limiter = createRateLimiter({
      tokensPerInterval: 3,
      intervalMs: 60_000,
    });
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(true);
    const rejected = limiter.check('u');
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSec).toBeGreaterThan(0);
    // With tokensPerInterval=3 and interval=60s, a single token regens
    // every 20s, so the Retry-After should be roughly 20s. Allow ±1 for
    // ceiling rounding.
    expect(rejected.retryAfterSec).toBeLessThanOrEqual(20);
    expect(rejected.retryAfterSec).toBeGreaterThanOrEqual(19);
  });

  it('refills tokens linearly as time passes', () => {
    const limiter = createRateLimiter({
      tokensPerInterval: 2,
      intervalMs: 1_000,
    });
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(false);

    // After 500ms we have refilled tokensPerInterval * 0.5 = 1 token.
    vi.advanceTimersByTime(500);
    expect(limiter.check('u').allowed).toBe(true);
    // And the bucket is empty again.
    expect(limiter.check('u').allowed).toBe(false);

    // After a full interval from now we should be back at capacity.
    vi.advanceTimersByTime(1_000);
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(true);
    expect(limiter.check('u').allowed).toBe(false);
  });

  it('isolates buckets per key', () => {
    const limiter = createRateLimiter({
      tokensPerInterval: 2,
      intervalMs: 60_000,
    });
    expect(limiter.check('alice').allowed).toBe(true);
    expect(limiter.check('alice').allowed).toBe(true);
    expect(limiter.check('alice').allowed).toBe(false);
    // Bob's bucket is untouched.
    expect(limiter.check('bob').allowed).toBe(true);
    expect(limiter.check('bob').allowed).toBe(true);
    expect(limiter.check('bob').allowed).toBe(false);
  });

  it('caps tracked keys via LRU eviction (oldest lastRefillMs evicted)', () => {
    const limiter = createRateLimiter({
      tokensPerInterval: 1,
      intervalMs: 60_000,
      maxKeys: 3,
    });

    limiter.check('a'); // lastRefillMs = T0
    vi.advanceTimersByTime(10);
    limiter.check('b'); // T0 + 10
    vi.advanceTimersByTime(10);
    limiter.check('c'); // T0 + 20
    expect(limiter._size()).toBe(3);

    // Adding 'd' should evict 'a' (oldest lastRefillMs).
    vi.advanceTimersByTime(10);
    limiter.check('d');
    expect(limiter._size()).toBe(3);

    // 'a' was forgotten — its bucket re-creates at full capacity.
    const aReborn = limiter.check('a');
    expect(aReborn.allowed).toBe(true);
    // But size is still capped (because adding 'a' back evicted someone).
    expect(limiter._size()).toBe(3);
  });

  it('rejects invalid config', () => {
    expect(() =>
      createRateLimiter({ tokensPerInterval: 0, intervalMs: 1000 })
    ).toThrow(/tokensPerInterval/);
    expect(() =>
      createRateLimiter({ tokensPerInterval: 1, intervalMs: 0 })
    ).toThrow(/intervalMs/);
    expect(() =>
      createRateLimiter({
        tokensPerInterval: 1,
        intervalMs: 1000,
        maxKeys: 0,
      })
    ).toThrow(/maxKeys/);
  });

  it('returns retryAfterSec >= 1 when rejecting (Retry-After is in whole seconds)', () => {
    const limiter = createRateLimiter({
      tokensPerInterval: 1,
      intervalMs: 30_000,
    });
    limiter.check('u');
    const r = limiter.check('u');
    expect(r.allowed).toBe(false);
    expect(Number.isInteger(r.retryAfterSec)).toBe(true);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});
