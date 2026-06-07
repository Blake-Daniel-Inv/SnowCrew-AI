import { logger as rootLogger } from '@/lib/logger';
import { crewRunner } from '@/lib/crew-runner';
import { getCrewStudioWorkspace } from '@/lib/crew-studio-store';
import {
  claimDueSchedules,
  markScheduleFailed,
  markScheduleFired,
  resetStuckSchedules,
} from '@/lib/schedules-db';
import { writeAuditEvent } from '@/lib/audit';
import { nextFireTime } from './cron';
import type { Schedule } from '@/types';

/**
 * In-process cron daemon. Runs once per Node container — never
 * distributed (SnowCrewAI is single-container in SPCS). On each tick
 * it asks the DB for schedules whose `next_fire_at` has passed,
 * claims them atomically via `claimDueSchedules`, and fans out the
 * actual run-spawn through the regular `crewRunner.startRun` flow.
 *
 * Design choices (see PR 15 description for full rationale):
 *
 *   - Polling interval: 60s by default; clamped to [10s, 300s] via
 *     the SCHEDULER_POLL_MS env. Lower bound prevents accidental
 *     hammering; upper bound caps the worst-case "how stale is my
 *     schedule" drift.
 *
 *   - No backfill. If we missed a tick because the container was
 *     down, we don't re-fire — `next_fire_at` is recomputed forward
 *     from "now" via `nextFireTime`. Backfill could trigger surprise
 *     compute costs and is rarely what users want.
 *
 *   - DB-backed idempotency. The claim is a single UPDATE ...
 *     RETURNING gated on `running = 0`, so even a runaway event loop
 *     that re-enters `tick()` before the previous finished can't
 *     fire the same row twice.
 *
 *   - Lazy start. The daemon is started by instrumentation.ts on
 *     first request; we use a module-level boolean to make `start()`
 *     idempotent across HMR. We deliberately skip start in the test
 *     environment so vitest doesn't spawn a background timer that
 *     outlives the suite.
 */

/** Bounds on the poll interval. Values outside the range get clamped. */
const MIN_POLL_MS = 10_000;
const MAX_POLL_MS = 300_000;
const DEFAULT_POLL_MS = 60_000;

/** Hard cap on schedules processed per tick — matches the LIMIT in
 *  claimDueSchedules so a long backlog can't monopolize one tick. */
const MAX_PER_TICK = 20;

function resolvePollMs(): number {
  const raw = process.env.SCHEDULER_POLL_MS;
  if (!raw) return DEFAULT_POLL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_MS;
  if (parsed < MIN_POLL_MS) return MIN_POLL_MS;
  if (parsed > MAX_POLL_MS) return MAX_POLL_MS;
  return parsed;
}

/**
 * Returns true when the daemon should NOT actually start. Encoded
 * here so both the auto-start guard and the test path consult the
 * same logic. Kill switches:
 *
 *   - NODE_ENV === 'test'      → never start under vitest.
 *   - SCHEDULER_DISABLED='1'   → operator escape hatch.
 *   - NEXT_RUNTIME === 'edge'  → daemon is Node-only; edge has no
 *                                 setInterval semantics we rely on.
 */
function isDisabled(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.SCHEDULER_DISABLED === '1') return true;
  if (process.env.NEXT_RUNTIME === 'edge') return true;
  return false;
}

const log = rootLogger.child({ module: 'scheduler' });

/**
 * Injected dependencies. The daemon defaults to the real
 * crew-runner / DB / workspace store, but tests pass mocks so they
 * don't have to spin up SQLite or a Python subprocess. Strictly an
 * internal extension point — never exported from the module's public
 * surface.
 */
export interface ScheduleDaemonDeps {
  claim: (now: number) => Schedule[];
  markFired: (id: string, runId: string, nextFireAt: number | null) => void;
  markFailed: (id: string, nextFireAt: number | null) => void;
  getWorkspace: (id: string, ownerId: string) => ReturnType<typeof getCrewStudioWorkspace>;
  startRun: typeof crewRunner.startRun;
  nextFire: typeof nextFireTime;
  /** Read "now" through this so tests can use fake timers. */
  now: () => number;
}

const defaultDeps: ScheduleDaemonDeps = {
  claim: claimDueSchedules,
  markFired: markScheduleFired,
  markFailed: markScheduleFailed,
  getWorkspace: getCrewStudioWorkspace,
  startRun: crewRunner.startRun.bind(crewRunner),
  nextFire: nextFireTime,
  now: () => Date.now(),
};

export class ScheduleDaemon {
  private started = false;
  private interval: NodeJS.Timeout | null = null;
  private deps: ScheduleDaemonDeps;

  constructor(deps: Partial<ScheduleDaemonDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  isRunning(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    if (isDisabled()) {
      log.info('scheduler daemon disabled (env)');
      return;
    }
    // Clear any rows that were claimed (running=1) but never released
    // because a previous container exited between claim and markFired.
    // The orphan-sweep pattern mirrors runs-db.ts:markOrphanedRunsErrored.
    // Strictly additive: log only when we actually reset something so
    // the happy-path startup log stays quiet.
    try {
      const stuck = resetStuckSchedules();
      if (stuck > 0) {
        log.info({ stuckCount: stuck }, 'Reset stuck schedules on startup');
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler stuck-row sweep failed'
      );
    }
    const pollMs = resolvePollMs();
    this.started = true;
    log.info({ pollMs }, 'scheduler daemon started');
    // Schedule the recurring tick first, then kick off the initial
    // tick async so the daemon picks up overdue schedules right away
    // without blocking the caller (instrumentation.register).
    this.interval = setInterval(() => {
      void this.tick().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'scheduler tick failed');
      });
    }, pollMs);
    this.interval.unref?.();
    void this.tick().catch((err) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler initial tick failed'
      );
    });
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.started = false;
  }

  /**
   * One iteration of the polling loop. Public so tests can drive it
   * deterministically without touching real timers. Returns the
   * number of schedules processed so tests can assert on it.
   */
  async tick(): Promise<number> {
    const now = this.deps.now();
    let claimed: Schedule[];
    try {
      claimed = this.deps.claim(now);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler claim failed'
      );
      return 0;
    }
    if (claimed.length === 0) return 0;
    // The claim query already LIMITs to 20, but defense-in-depth so
    // a future change to the SQL doesn't silently blow this cap.
    const batch = claimed.slice(0, MAX_PER_TICK);
    let processed = 0;
    for (const schedule of batch) {
      try {
        await this.processOne(schedule);
        processed += 1;
      } catch (err) {
        // processOne always wraps its own errors and marks the
        // schedule failed; this catch is for truly unexpected
        // failures that escape that path (e.g. logger blew up).
        log.error(
          {
            scheduleId: schedule.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'scheduler processOne crashed unexpectedly'
        );
      }
    }
    return processed;
  }

  private async processOne(schedule: Schedule): Promise<void> {
    // Compute the next fire BEFORE attempting to start the run so
    // even a permanently-failing crew advances forward each cycle.
    // The conservative "no backfill" choice means we just compute
    // from "now" — we don't try to catch up missed ticks.
    const computed = this.deps.nextFire(
      schedule.cronExpr,
      schedule.timezone,
      new Date(this.deps.now())
    );
    const nextFireAt = computed ? computed.getTime() : null;

    // Defense in depth: the workspace store is owner-scoped, so this
    // mismatch should never happen for a row we inserted via
    // createSchedule — but a tampered DB or a deleted workspace
    // would slip through otherwise.
    const workspace = this.deps.getWorkspace(
      schedule.workspaceId,
      schedule.ownerId
    );
    if (!workspace) {
      log.warn(
        {
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId,
          ownerId: schedule.ownerId,
        },
        'scheduled run skipped: workspace not found for owner'
      );
      this.deps.markFailed(schedule.id, nextFireAt);
      return;
    }
    const crew = workspace.crews.find((c) => c.id === schedule.crewId);
    if (!crew) {
      log.warn(
        {
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId,
          crewId: schedule.crewId,
        },
        'scheduled run skipped: crew missing from workspace'
      );
      this.deps.markFailed(schedule.id, nextFireAt);
      return;
    }

    try {
      const run = await this.deps.startRun(
        workspace,
        crew,
        {}, // no per-fire inputs for now; inputs live on the schedule's crew config
        schedule.ownerId,
        { triggerKind: 'scheduled', scheduleId: schedule.id }
      );
      this.deps.markFired(schedule.id, run.id, nextFireAt);
      // Audit AFTER markFired so a successful fire is durably recorded.
      // The ownerId comes from the schedule row (not the request, which
      // doesn't exist — the daemon runs out-of-band) so the audit shows
      // who owns the firing schedule, not "system".
      writeAuditEvent({
        ownerId: schedule.ownerId,
        action: 'schedule.fired',
        targetType: 'schedule',
        targetId: schedule.id,
        metadata: {
          runId: run.id,
          scheduleName: schedule.name,
          nextFireAt,
        },
      });
      log.info(
        {
          scheduleId: schedule.id,
          runId: run.id,
          nextFireAt,
        },
        'scheduled run started'
      );
    } catch (err) {
      log.error(
        {
          scheduleId: schedule.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'scheduled run failed to start'
      );
      this.deps.markFailed(schedule.id, nextFireAt);
    }
  }
}

/**
 * Module-singleton daemon. Lives across HMR by stashing on globalThis
 * so a dev-mode reload doesn't accumulate orphan setInterval handles.
 */
type GlobalWithDaemon = typeof globalThis & {
  __scheduleDaemon?: ScheduleDaemon;
};
const g = globalThis as GlobalWithDaemon;
if (!g.__scheduleDaemon) {
  g.__scheduleDaemon = new ScheduleDaemon();
}
export const scheduleDaemon: ScheduleDaemon = g.__scheduleDaemon;
