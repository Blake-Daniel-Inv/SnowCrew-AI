/**
 * Next.js 16 instrumentation hook. The exported `register` is called
 * once per worker at server startup — both in `next dev --webpack`
 * and `next start` — making it the right seam to start a singleton
 * background daemon.
 *
 * Why here and not, say, a route module's top-level side effect:
 *   - Routes are tree-shaken / lazy-loaded; we have no guarantee the
 *     schedules route is the first thing imported.
 *   - The runner manager already lazy-instantiates inside
 *     globalThis-cached state, but it doesn't poll — it reacts to
 *     POST /api/runs. The scheduler is the opposite: it must poll
 *     even when no UI is open.
 *
 * Guard rails:
 *   - NEXT_RUNTIME === 'nodejs' check skips the edge runtime, which
 *     can't host the daemon's setInterval / better-sqlite3 stack.
 *   - The daemon's own `isDisabled()` covers NODE_ENV === 'test' and
 *     the SCHEDULER_DISABLED escape hatch; we still call `start()`
 *     so logs make the gate explicit.
 *   - Dynamic import keeps better-sqlite3 / cron-parser out of the
 *     edge bundle even if the file is statically analyzed.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Lazy import: avoids pulling Node-only deps into the edge runtime
  // graph during the `next build` analysis pass.
  const { scheduleDaemon } = await import('@/lib/scheduler/daemon');
  // start() is idempotent and short-circuits when the daemon is
  // already running or disabled via env. Fire-and-forget — we never
  // want the daemon to block server boot.
  scheduleDaemon.start();
}
