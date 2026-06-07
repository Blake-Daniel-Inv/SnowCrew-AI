/**
 * In-memory token-bucket rate limiter.
 *
 * Scope: this implementation is per-process. SnowCrewAI deploys in
 * Snowpark Container Services with a single container per service, so
 * "per-process" matches the rate-limit semantics a user would expect.
 * If we ever scale horizontally (multiple replicas behind a load
 * balancer), every replica will see only its own slice of traffic and
 * the effective limit becomes `tokensPerInterval * replica_count`. At
 * that point this should move to a shared store (Redis / SQLite WAL /
 * Snowflake table); the API surface here is intentionally compatible
 * with such a swap.
 *
 * Algorithm: classic token bucket. Each `key` has a bucket holding up
 * to `tokensPerInterval` tokens. Tokens refill linearly at the rate of
 * `tokensPerInterval / intervalMs` tokens per millisecond. A `check`
 * call consumes one token; if there is none, the call is rejected and
 * `retryAfterSec` reports how long until one token regenerates.
 *
 * Memory: the bucket Map is bounded by `maxKeys` (default 10_000). When
 * the cap is exceeded we evict the entry with the oldest `lastRefillMs`
 * — that is, the bucket nobody has touched for the longest time. This
 * is a simple O(n) eviction, not a true LRU, but with `maxKeys` in the
 * 10k–100k range and eviction running only on overflow, the cost is
 * negligible compared to the cost of getting wrong-sized.
 */

export interface RateLimiterConfig {
  /** Bucket capacity AND refill rate (tokens) per `intervalMs` window. */
  tokensPerInterval: number;
  /** Window length in milliseconds for the `tokensPerInterval` refill. */
  intervalMs: number;
  /** Hard cap on the number of tracked keys. Defaults to 10_000. */
  maxKeys?: number;
}

export interface RateLimiterCheckResult {
  allowed: boolean;
  /**
   * Seconds the caller should wait before the next allowed request.
   * Always > 0 when allowed=false; rounded up to the nearest second so
   * the value can be used directly in a `Retry-After` header.
   * 0 when allowed=true.
   */
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string): RateLimiterCheckResult;
  /** Internal: number of keys currently tracked. Test-only. */
  _size(): number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const tokensPerInterval = config.tokensPerInterval;
  const intervalMs = config.intervalMs;
  const maxKeys = config.maxKeys ?? DEFAULT_MAX_KEYS;

  if (tokensPerInterval <= 0) {
    throw new Error('createRateLimiter: tokensPerInterval must be > 0');
  }
  if (intervalMs <= 0) {
    throw new Error('createRateLimiter: intervalMs must be > 0');
  }
  if (maxKeys <= 0) {
    throw new Error('createRateLimiter: maxKeys must be > 0');
  }

  const buckets = new Map<string, Bucket>();
  const refillRatePerMs = tokensPerInterval / intervalMs;

  function evictOldestIfFull(): void {
    if (buckets.size < maxKeys) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, b] of buckets) {
      if (b.lastRefillMs < oldestTime) {
        oldestTime = b.lastRefillMs;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) buckets.delete(oldestKey);
  }

  function check(key: string): RateLimiterCheckResult {
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket) {
      // New key. Evict before inserting so we never exceed the cap.
      evictOldestIfFull();
      bucket = { tokens: tokensPerInterval, lastRefillMs: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.lastRefillMs);
      // Linear refill, capped at capacity.
      const refilled = elapsed * refillRatePerMs;
      bucket.tokens = Math.min(tokensPerInterval, bucket.tokens + refilled);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }

    // Tokens < 1; compute the wait time to reach 1 token.
    const needed = 1 - bucket.tokens;
    const waitMs = needed / refillRatePerMs;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)),
    };
  }

  return {
    check,
    _size: () => buckets.size,
  };
}
