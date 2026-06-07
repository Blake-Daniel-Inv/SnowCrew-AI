/**
 * Per-key async mutex used to serialize read-modify-write operations
 * on the same resource (typically a file path).
 *
 *  - Callers for the same key run one at a time, in FIFO order.
 *  - Callers for different keys run in parallel.
 *  - One caller's error NEVER leaks to other waiters — each caller
 *    resolves or rejects with its own outcome.
 *  - An optional timeout guards against a hung operation holding the
 *    lock forever (a deadlock would silently block all future writes).
 *
 * NOT re-entrant. Calling withFileLock for the same key from inside
 * a holder's callback deadlocks until the 30s timeout fires, which
 * is itself buggy under that load (two writers racing on rename).
 * Run dependent file ops outside the lock or refactor the holder.
 */

export interface FileLockOptions {
  /** Milliseconds to wait before treating the operation as stuck. */
  timeoutMs?: number;
}

type ReleaseFn = () => void;

/**
 * Internal lock chain. Each map entry is a promise that resolves when
 * the current holder releases the lock. We intentionally type it as
 * Promise<void> (never rejecting) so subsequent waiters can await it
 * without inheriting a prior caller's error.
 */
const locks = new Map<string, Promise<void>>();

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  // Acquire: chain after the previous holder (if any) but isolate failures.
  const previous = locks.get(key) ?? Promise.resolve();
  const { promise: held, release } = createReleaseController();
  locks.set(key, held);

  try {
    await previous;
    return await runWithTimeout(fn, timeoutMs, key);
  } finally {
    release();
    // Only clear the map entry if we're still the current holder.
    // A later caller may have chained after us and taken ownership.
    if (locks.get(key) === held) {
      locks.delete(key);
    }
  }
}

function createReleaseController(): { promise: Promise<void>; release: ReleaseFn } {
  let release!: ReleaseFn;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function runWithTimeout<T>(
  fn: () => Promise<T> | T,
  timeoutMs: number,
  key: string
): Promise<T> {
  if (timeoutMs <= 0) return fn();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`File lock timed out after ${timeoutMs}ms for "${key}"`)),
      timeoutMs
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([Promise.resolve().then(fn), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
