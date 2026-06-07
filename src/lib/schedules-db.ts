import { randomUUID } from 'node:crypto';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import { getRunsDb } from './runs-db';
import { nextFireTime } from './scheduler/cron';
import type { Schedule } from '@/types';

/**
 * Owner-scoped CRUD for the `schedules` table plus the daemon-internal
 * `claimDueSchedules` / `markScheduleFired` / `markScheduleFailed`
 * primitives. Mirrors the credentials-db.ts pattern:
 *
 *   - prepared statements cached against the singleton DB handle so
 *     test teardown that swaps `globalThis.__runsDb` invalidates the
 *     cache transparently;
 *   - every public read/write filters by owner_id (defense in depth
 *     against API-route bugs that forget to scope);
 *   - claimDueSchedules deliberately does NOT filter by owner — it is
 *     a system primitive the daemon calls across all owners, and is
 *     not exported through any route handler.
 *
 * Timestamps are unix epoch milliseconds throughout. The cron→UTC
 * conversion (timezone offset etc.) lives behind `nextFireTime`.
 */

/* ------------------------------------------------------------------ */
/*  Statement cache                                                   */
/* ------------------------------------------------------------------ */

interface ScheduleStatements {
  insert: Statement;
  selectByOwnerAndId: Statement;
  selectAllByOwner: Statement;
  selectAllByOwnerAndWorkspace: Statement;
  update: Statement;
  deleteByOwnerAndId: Statement;
  claimDue: Statement;
  markFired: Statement;
  markFailed: Statement;
}

type GlobalWithStmts = typeof globalThis & {
  __scheduleStmts?: { db: DatabaseType; stmts: ScheduleStatements };
};
const g = globalThis as GlobalWithStmts;

function getStatements(): ScheduleStatements {
  const db = getRunsDb();
  const cached = g.__scheduleStmts;
  if (cached && cached.db === db) return cached.stmts;
  const stmts: ScheduleStatements = {
    insert: db.prepare(
      `INSERT INTO schedules
         (id, owner_id, workspace_id, crew_id, name, cron_expr,
          timezone, enabled, next_fire_at, last_fired_at, last_run_id,
          running, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    selectByOwnerAndId: db.prepare(
      `SELECT * FROM schedules WHERE owner_id = ? AND id = ?`
    ),
    selectAllByOwner: db.prepare(
      `SELECT * FROM schedules WHERE owner_id = ? ORDER BY created_at DESC`
    ),
    selectAllByOwnerAndWorkspace: db.prepare(
      `SELECT * FROM schedules
       WHERE owner_id = ? AND workspace_id = ?
       ORDER BY created_at DESC`
    ),
    update: db.prepare(
      `UPDATE schedules
       SET name = ?, cron_expr = ?, timezone = ?, enabled = ?,
           next_fire_at = ?, updated_at = ?
       WHERE owner_id = ? AND id = ?`
    ),
    deleteByOwnerAndId: db.prepare(
      `DELETE FROM schedules WHERE owner_id = ? AND id = ?`
    ),
    // Atomic claim. The single-statement UPDATE ... RETURNING is the
    // safe form: SQLite serializes writes through the WAL so two
    // concurrent invocations can't both claim the same row even if the
    // event loop interleaves between them. The inner SELECT with LIMIT
    // 20 caps the per-tick batch so a long backlog can't monopolize a
    // single iteration. better-sqlite3 12.x supports RETURNING.
    claimDue: db.prepare(
      `UPDATE schedules
       SET running = 1
       WHERE id IN (
         SELECT id FROM schedules
         WHERE enabled = 1 AND running = 0 AND next_fire_at IS NOT NULL
           AND next_fire_at <= ?
         ORDER BY next_fire_at ASC
         LIMIT 20
       )
       RETURNING *`
    ),
    markFired: db.prepare(
      `UPDATE schedules
       SET last_fired_at = ?, last_run_id = ?, next_fire_at = ?,
           running = 0, updated_at = ?
       WHERE id = ?`
    ),
    markFailed: db.prepare(
      `UPDATE schedules
       SET next_fire_at = ?, running = 0, updated_at = ?
       WHERE id = ?`
    ),
  };
  g.__scheduleStmts = { db, stmts };
  return stmts;
}

/* ------------------------------------------------------------------ */
/*  Row mapping                                                       */
/* ------------------------------------------------------------------ */

interface ScheduleRow {
  id: string;
  owner_id: string;
  workspace_id: string;
  crew_id: string;
  name: string;
  cron_expr: string;
  timezone: string;
  enabled: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  last_run_id: string | null;
  running: number;
  created_at: number;
  updated_at: number;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    crewId: row.crew_id,
    name: row.name,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    lastRunId: row.last_run_id,
    running: row.running === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/*  Public CRUD                                                       */
/* ------------------------------------------------------------------ */

export interface CreateScheduleInput {
  ownerId: string;
  workspaceId: string;
  crewId: string;
  name: string;
  cronExpr: string;
  /** IANA timezone; falls through to 'UTC' when omitted. */
  timezone?: string;
  /** Defaults to true so the schedule is "live" on creation. */
  enabled?: boolean;
}

/**
 * Create a new schedule. Computes the initial `next_fire_at` via
 * `nextFireTime`; if the cron expr is unparseable the schedule is still
 * stored (the API layer rejects upstream) but `next_fire_at` stays
 * null so the daemon never claims it.
 *
 * Throws if any of the required string fields are missing — the API
 * layer's Zod schema enforces shape, but defense in depth keeps
 * malformed rows out of the DB.
 */
export function createSchedule(input: CreateScheduleInput): Schedule {
  if (!input.ownerId) throw new Error('createSchedule: ownerId is required');
  if (!input.workspaceId) {
    throw new Error('createSchedule: workspaceId is required');
  }
  if (!input.crewId) throw new Error('createSchedule: crewId is required');
  if (!input.name?.trim()) throw new Error('createSchedule: name is required');
  if (!input.cronExpr?.trim()) {
    throw new Error('createSchedule: cronExpr is required');
  }

  const stmts = getStatements();
  const id = randomUUID();
  const tz = input.timezone?.trim() || 'UTC';
  const enabled = input.enabled !== false; // default true
  const now = Date.now();
  const nextFireDate = enabled
    ? nextFireTime(input.cronExpr, tz, new Date(now))
    : null;
  const nextFireAt = nextFireDate ? nextFireDate.getTime() : null;

  stmts.insert.run(
    id,
    input.ownerId,
    input.workspaceId,
    input.crewId,
    input.name.trim(),
    input.cronExpr.trim(),
    tz,
    enabled ? 1 : 0,
    nextFireAt,
    null,
    null,
    0,
    now,
    now
  );

  // Re-read so the returned row matches what listSchedules/getSchedule
  // would return for the same id — keeps every code path aligned on the
  // same Schedule shape.
  const row = stmts.selectByOwnerAndId.get(input.ownerId, id) as
    | ScheduleRow
    | undefined;
  if (!row) {
    throw new Error('createSchedule: row vanished after insert');
  }
  return rowToSchedule(row);
}

/**
 * List schedules owned by `ownerId`. When `workspaceId` is supplied the
 * result is further narrowed; otherwise every schedule the caller owns
 * is returned, ordered newest-first.
 */
export function listSchedules(
  ownerId: string,
  workspaceId?: string
): Schedule[] {
  if (!ownerId) return [];
  const stmts = getStatements();
  const rows = workspaceId
    ? (stmts.selectAllByOwnerAndWorkspace.all(ownerId, workspaceId) as ScheduleRow[])
    : (stmts.selectAllByOwner.all(ownerId) as ScheduleRow[]);
  return rows.map(rowToSchedule);
}

export function getSchedule(ownerId: string, id: string): Schedule | null {
  if (!ownerId || !id) return null;
  const stmts = getStatements();
  const row = stmts.selectByOwnerAndId.get(ownerId, id) as
    | ScheduleRow
    | undefined;
  return row ? rowToSchedule(row) : null;
}

export interface UpdateScheduleInput {
  name?: string;
  cronExpr?: string;
  timezone?: string;
  enabled?: boolean;
}

/**
 * Patch a schedule. Owner-scoped: returns null if no row matches
 * (caller never sees rows it doesn't own).
 *
 * Triggers `next_fire_at` recomputation when the cron expr, timezone,
 * or enabled flag changes. Toggling `enabled = false` clears
 * next_fire_at to null so the daemon's claim query can't pick it up;
 * toggling back to true recomputes from "now".
 *
 * Re-reads after the UPDATE so the returned row reflects the
 * (possibly recomputed) next_fire_at instead of asking the caller to
 * issue a second GET.
 */
export function updateSchedule(
  ownerId: string,
  id: string,
  update: UpdateScheduleInput
): Schedule | null {
  if (!ownerId || !id) return null;
  const existing = getSchedule(ownerId, id);
  if (!existing) return null;

  const nextName = update.name?.trim() ?? existing.name;
  const nextCronExpr = update.cronExpr?.trim() ?? existing.cronExpr;
  const nextTimezone = update.timezone?.trim() || existing.timezone;
  const nextEnabled = update.enabled ?? existing.enabled;

  // Recompute next_fire_at when the firing logic could have changed.
  // Pure rename / re-disabled-to-still-disabled keeps the cached value
  // (or null) so we don't pointlessly thrash the daemon's claim plan.
  const shouldRecompute =
    update.cronExpr != null ||
    update.timezone != null ||
    (update.enabled != null && update.enabled !== existing.enabled);

  let nextFireAt: number | null = existing.nextFireAt;
  if (shouldRecompute) {
    if (!nextEnabled) {
      nextFireAt = null;
    } else {
      const computed = nextFireTime(nextCronExpr, nextTimezone, new Date());
      nextFireAt = computed ? computed.getTime() : null;
    }
  }

  const stmts = getStatements();
  const now = Date.now();
  stmts.update.run(
    nextName,
    nextCronExpr,
    nextTimezone,
    nextEnabled ? 1 : 0,
    nextFireAt,
    now,
    ownerId,
    id
  );
  return getSchedule(ownerId, id);
}

/**
 * Delete a schedule by id. Owner-scoped: returns false if no row was
 * matched (already deleted, never existed, or belongs to another
 * caller — we never distinguish those externally).
 */
export function deleteSchedule(ownerId: string, id: string): boolean {
  if (!ownerId || !id) return false;
  const stmts = getStatements();
  const info = stmts.deleteByOwnerAndId.run(ownerId, id);
  return info.changes > 0;
}

/* ------------------------------------------------------------------ */
/*  Daemon-internal primitives                                        */
/* ------------------------------------------------------------------ */

/**
 * Atomically claim schedules whose `next_fire_at <= now()`. NOT
 * owner-scoped — only the daemon calls this, and it must operate
 * across every owner. Returns the claimed rows (with `running = 1`
 * already set in the DB) so the caller can fan out the actual run
 * spawns without a second round-trip.
 *
 * Concurrency: SQLite serializes writes, so two simultaneous calls on
 * the same DB handle can't both claim the same row. The earlier writer
 * flips `running` to 1 first; the later writer's inner SELECT no
 * longer matches `running = 0` so the row is excluded from its
 * RETURNING set.
 */
export function claimDueSchedules(now: number): Schedule[] {
  const stmts = getStatements();
  const rows = stmts.claimDue.all(now) as ScheduleRow[];
  return rows.map(rowToSchedule);
}

/**
 * Daemon callback after a scheduled run successfully started. Stamps
 * `last_fired_at` / `last_run_id` / `next_fire_at` and clears the
 * `running` claim flag in a single UPDATE so a crash between the
 * actions can't leave the schedule poisoned.
 */
export function markScheduleFired(
  id: string,
  runId: string,
  nextFireAt: number | null
): void {
  const stmts = getStatements();
  const now = Date.now();
  stmts.markFired.run(now, runId, nextFireAt, now, id);
}

/**
 * Daemon callback when starting a scheduled run failed. We still
 * advance `next_fire_at` to the next cycle so a permanently broken
 * schedule doesn't fire-storm every tick, but we deliberately DON'T
 * touch `last_fired_at` or `last_run_id` — those should reflect the
 * last *successful* fire so the UI can show "last successful run".
 */
export function markScheduleFailed(
  id: string,
  nextFireAt: number | null
): void {
  const stmts = getStatements();
  stmts.markFailed.run(nextFireAt, Date.now(), id);
}

/**
 * Boot-time sweep that clears the `running = 1` flag on every row.
 *
 * Why: `claimDueSchedules` only picks up rows where `running = 0`. If
 * the container crashes (or is rescheduled by SPCS) between `claimDue`
 * setting `running = 1` and `markScheduleFired` / `markScheduleFailed`
 * clearing it, the row is stuck at `running = 1` FOREVER and is
 * silently excluded from every future tick. The schedule appears
 * enabled in the UI but never fires.
 *
 * The fix mirrors the orphan sweep in runs-db.ts (which clears
 * `running`/`queued` rows whose owning PID is gone). A single UPDATE
 * across all owners is the simplest safe choice: nobody is mid-fire at
 * boot (the daemon hasn't started yet by the time `start()` calls
 * this), so resetting the flag globally cannot stomp a live claim.
 *
 * Returns the number of rows that were stuck so the daemon can log the
 * count at info level — silence on the happy path, audit trail on the
 * occasional restart-with-stuck-rows.
 */
export function resetStuckSchedules(): number {
  const db = getRunsDb();
  const info = db.prepare(`UPDATE schedules SET running = 0 WHERE running = 1`).run();
  return info.changes;
}
