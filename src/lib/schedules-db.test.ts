import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import {
  claimDueSchedules,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  markScheduleFailed,
  markScheduleFired,
  resetStuckSchedules,
  updateSchedule,
} from './schedules-db';

/**
 * Mirrors the credentials-db.test setup: swap the runs-db singleton
 * with an in-memory handle that already has the schedules table so
 * runs-db.ts:applyMigrations doesn't re-run against a hand-rolled
 * schema. The schema below intentionally matches SCHEMA_STATEMENTS in
 * runs-db.ts — if PR 15's table shape changes there, mirror the
 * change here.
 */
type GlobalWithDb = typeof globalThis & {
  __runsDb?: DatabaseType;
  __runsStmts?: unknown;
  __scheduleStmts?: unknown;
};
const g = globalThis as GlobalWithDb;

function freshDb(): DatabaseType {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      crew_id TEXT NOT NULL,
      crew_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      exit_code INTEGER,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      owner_id TEXT NOT NULL DEFAULT '__legacy__',
      owner_pid INTEGER,
      owner_host TEXT
    );
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      crew_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled INTEGER NOT NULL DEFAULT 1,
      next_fire_at INTEGER,
      last_fired_at INTEGER,
      last_run_id TEXT REFERENCES runs(id),
      running INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_schedules_due ON schedules(enabled, next_fire_at);
    CREATE INDEX idx_schedules_owner ON schedules(owner_id);
  `);
  return db;
}

beforeEach(() => {
  g.__runsDb = freshDb();
  g.__runsStmts = undefined;
  g.__scheduleStmts = undefined;
});

afterEach(() => {
  g.__runsDb?.close();
  g.__runsDb = undefined;
  g.__runsStmts = undefined;
  g.__scheduleStmts = undefined;
});

describe('createSchedule', () => {
  it('stores a schedule and computes next_fire_at via cron-parser', () => {
    const created = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'Nightly summary',
      cronExpr: '0 9 * * *',
      timezone: 'UTC',
    });
    expect(created.ownerId).toBe('user-a');
    expect(created.cronExpr).toBe('0 9 * * *');
    expect(created.timezone).toBe('UTC');
    expect(created.enabled).toBe(true);
    expect(created.running).toBe(false);
    // The cron 0 9 * * * fires at the next 09:00 UTC — must be in
    // the future from the test's "now".
    expect(created.nextFireAt).not.toBeNull();
    expect(created.nextFireAt!).toBeGreaterThan(Date.now() - 1_000);
  });

  it('defaults timezone to UTC and enabled to true', () => {
    const created = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'Hourly',
      cronExpr: '0 * * * *',
    });
    expect(created.timezone).toBe('UTC');
    expect(created.enabled).toBe(true);
  });

  it('stores the schedule with null next_fire_at when disabled', () => {
    const created = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'Paused',
      cronExpr: '0 * * * *',
      enabled: false,
    });
    expect(created.enabled).toBe(false);
    expect(created.nextFireAt).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(() =>
      createSchedule({
        ownerId: '',
        workspaceId: 'ws-1',
        crewId: 'crew-1',
        name: 'x',
        cronExpr: '* * * * *',
      })
    ).toThrow(/ownerId/);
    expect(() =>
      createSchedule({
        ownerId: 'user-a',
        workspaceId: 'ws-1',
        crewId: 'crew-1',
        name: '',
        cronExpr: '* * * * *',
      })
    ).toThrow(/name/);
  });
});

describe('owner isolation', () => {
  it('hides schedules across owners', () => {
    const a = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'A1',
      cronExpr: '0 * * * *',
    });
    createSchedule({
      ownerId: 'user-b',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'B1',
      cronExpr: '0 * * * *',
    });
    // listSchedules
    const listA = listSchedules('user-a');
    expect(listA).toHaveLength(1);
    expect(listA[0].name).toBe('A1');
    // getSchedule by cross-owner id returns null
    expect(getSchedule('user-b', a.id)).toBeNull();
    // updateSchedule by cross-owner returns null
    expect(updateSchedule('user-b', a.id, { name: 'hijacked' })).toBeNull();
    // deleteSchedule by cross-owner returns false
    expect(deleteSchedule('user-b', a.id)).toBe(false);
    // Original row survives untouched
    const after = getSchedule('user-a', a.id);
    expect(after?.name).toBe('A1');
  });
});

describe('listSchedules', () => {
  it('filters by workspaceId when provided', () => {
    createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'W1',
      cronExpr: '0 * * * *',
    });
    createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-2',
      crewId: 'crew-2',
      name: 'W2',
      cronExpr: '0 * * * *',
    });
    const ws1 = listSchedules('user-a', 'ws-1');
    expect(ws1.map((s) => s.name).sort()).toEqual(['W1']);
    const all = listSchedules('user-a');
    expect(all.map((s) => s.name).sort()).toEqual(['W1', 'W2']);
  });
});

describe('updateSchedule', () => {
  it('recomputes next_fire_at when cron_expr changes', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'orig',
      cronExpr: '0 9 * * *',
      timezone: 'UTC',
    });
    const before = s.nextFireAt;
    // Change to every minute; next fire should be much sooner.
    const updated = updateSchedule('user-a', s.id, {
      cronExpr: '* * * * *',
    });
    expect(updated).not.toBeNull();
    expect(updated!.cronExpr).toBe('* * * * *');
    expect(updated!.nextFireAt).not.toBeNull();
    expect(updated!.nextFireAt!).toBeLessThan(before!);
  });

  it('recomputes next_fire_at when timezone changes', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'orig',
      cronExpr: '0 9 * * *',
      timezone: 'UTC',
    });
    const utcFire = s.nextFireAt;
    const updated = updateSchedule('user-a', s.id, {
      timezone: 'America/Los_Angeles',
    });
    expect(updated).not.toBeNull();
    // LA is UTC-7/-8 so the next 09:00 local lands at a different UTC
    // instant than the UTC schedule did. (Equality would mean the
    // timezone was ignored.)
    expect(updated!.nextFireAt).not.toEqual(utcFire);
  });

  it('clears next_fire_at when disabled and re-arms when re-enabled', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'orig',
      cronExpr: '0 9 * * *',
    });
    expect(s.nextFireAt).not.toBeNull();
    const disabled = updateSchedule('user-a', s.id, { enabled: false });
    expect(disabled!.enabled).toBe(false);
    expect(disabled!.nextFireAt).toBeNull();
    const re = updateSchedule('user-a', s.id, { enabled: true });
    expect(re!.enabled).toBe(true);
    expect(re!.nextFireAt).not.toBeNull();
  });

  it('preserves next_fire_at when only the name changes', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'orig',
      cronExpr: '0 9 * * *',
    });
    const before = s.nextFireAt;
    const renamed = updateSchedule('user-a', s.id, { name: 'renamed' });
    expect(renamed!.name).toBe('renamed');
    expect(renamed!.nextFireAt).toBe(before);
  });
});

describe('claimDueSchedules', () => {
  it('returns only enabled, not-running rows with next_fire_at <= now', () => {
    const past = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'past',
      cronExpr: '* * * * *',
    });
    // Force past next_fire_at directly (createSchedule always computes
    // a future fire time, which would otherwise hide the row).
    const db = g.__runsDb!;
    db.prepare('UPDATE schedules SET next_fire_at = ? WHERE id = ?').run(
      Date.now() - 60_000,
      past.id
    );
    // A disabled schedule should NOT be claimed even when due.
    const disabled = createSchedule({
      ownerId: 'user-b',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'disabled',
      cronExpr: '* * * * *',
      enabled: false,
    });
    db.prepare('UPDATE schedules SET next_fire_at = ? WHERE id = ?').run(
      Date.now() - 60_000,
      disabled.id
    );

    const claimed = claimDueSchedules(Date.now());
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(past.id);
    expect(claimed[0].running).toBe(true);
  });

  it('is atomic — concurrent claims do not double-claim the same row', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'race',
      cronExpr: '* * * * *',
    });
    const db = g.__runsDb!;
    db.prepare('UPDATE schedules SET next_fire_at = ? WHERE id = ?').run(
      Date.now() - 60_000,
      s.id
    );
    // better-sqlite3 is synchronous so we can't truly interleave at
    // the OS level. Instead we simulate the race by calling claim
    // twice in a row and asserting the second call sees nothing —
    // the running = 1 flip from the first call must be visible.
    const first = claimDueSchedules(Date.now());
    const second = claimDueSchedules(Date.now());
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('respects the 20-row batch cap', () => {
    const db = g.__runsDb!;
    for (let i = 0; i < 25; i++) {
      const s = createSchedule({
        ownerId: 'user-a',
        workspaceId: 'ws-1',
        crewId: 'crew-1',
        name: `s${i}`,
        cronExpr: '* * * * *',
      });
      db.prepare('UPDATE schedules SET next_fire_at = ? WHERE id = ?').run(
        Date.now() - 60_000 - i,
        s.id
      );
    }
    const claimed = claimDueSchedules(Date.now());
    expect(claimed).toHaveLength(20);
  });

  it('skips rows with null next_fire_at', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'paused',
      cronExpr: '0 9 * * *',
      enabled: false,
    });
    expect(s.nextFireAt).toBeNull();
    const claimed = claimDueSchedules(Date.now() + 86_400_000);
    expect(claimed).toHaveLength(0);
  });
});

describe('markScheduleFired / markScheduleFailed', () => {
  it('mark fired stamps the run id, advances next_fire_at, and clears running', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 's',
      cronExpr: '* * * * *',
    });
    const db = g.__runsDb!;
    db.prepare('UPDATE schedules SET running = 1 WHERE id = ?').run(s.id);
    // last_run_id is a real FK now (schedules.last_run_id REFERENCES
    // runs.id), so we have to seed a runs row before stamping it.
    db.prepare(
      `INSERT INTO runs (id, workspace_id, crew_id, crew_name, status, started_at, owner_id)
       VALUES ('run-xyz', 'ws-1', 'crew-1', 'crew', 'completed', '2026-05-12T00:00:00Z', 'user-a')`
    ).run();

    const future = Date.now() + 60_000;
    markScheduleFired(s.id, 'run-xyz', future);

    const after = getSchedule('user-a', s.id)!;
    expect(after.lastRunId).toBe('run-xyz');
    expect(after.lastFiredAt).not.toBeNull();
    expect(after.nextFireAt).toBe(future);
    expect(after.running).toBe(false);
  });

  it('mark failed advances next_fire_at without setting last_run_id', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 's',
      cronExpr: '* * * * *',
    });
    const db = g.__runsDb!;
    db.prepare('UPDATE schedules SET running = 1 WHERE id = ?').run(s.id);

    const future = Date.now() + 60_000;
    markScheduleFailed(s.id, future);

    const after = getSchedule('user-a', s.id)!;
    expect(after.lastRunId).toBeNull();
    expect(after.lastFiredAt).toBeNull();
    expect(after.nextFireAt).toBe(future);
    expect(after.running).toBe(false);
  });
});

describe('deleteSchedule', () => {
  it('removes the row and returns true', () => {
    const s = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 's',
      cronExpr: '* * * * *',
    });
    expect(deleteSchedule('user-a', s.id)).toBe(true);
    expect(getSchedule('user-a', s.id)).toBeNull();
  });

  it('returns false for non-existent ids', () => {
    expect(deleteSchedule('user-a', 'no-such-id')).toBe(false);
  });
});

describe('resetStuckSchedules (boot-time sweep)', () => {
  it('clears running=1 across all rows and returns the count', () => {
    // Three schedules, all with running=1 simulating mid-claim crash
    // across multiple owners. The sweep is owner-agnostic by design —
    // only the daemon calls it at startup, before any tick.
    const a = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'A',
      cronExpr: '0 * * * *',
    });
    const b = createSchedule({
      ownerId: 'user-b',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'B',
      cronExpr: '0 * * * *',
    });
    const c = createSchedule({
      ownerId: 'user-c',
      workspaceId: 'ws-2',
      crewId: 'crew-2',
      name: 'C',
      cronExpr: '0 * * * *',
    });
    // Mark all three as "claimed but never released".
    g.__runsDb!
      .prepare(`UPDATE schedules SET running = 1 WHERE id IN (?, ?, ?)`)
      .run(a.id, b.id, c.id);

    const cleared = resetStuckSchedules();
    expect(cleared).toBe(3);

    // After the sweep, every row's running flag is back to 0 so the
    // daemon's claim query can pick them up again.
    const rows = g.__runsDb!
      .prepare(`SELECT id, running FROM schedules ORDER BY name`)
      .all() as Array<{ id: string; running: number }>;
    for (const row of rows) expect(row.running).toBe(0);
  });

  it('returns 0 when no rows are stuck (happy-path startup)', () => {
    createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'Happy',
      cronExpr: '0 * * * *',
    });
    // No mutation of running flag — leave it at the default 0.
    expect(resetStuckSchedules()).toBe(0);
  });

  it('only touches the running column (leaves siblings intact)', () => {
    // Insert a real run row so we can set last_run_id without
    // tripping the schedules.last_run_id FK to runs.id.
    g.__runsDb!
      .prepare(
        `INSERT INTO runs (id, workspace_id, crew_id, crew_name, status,
            started_at, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('run-xyz', 'ws-1', 'crew-1', 'Survivor', 'completed',
        new Date().toISOString(), 'user-a');

    const created = createSchedule({
      ownerId: 'user-a',
      workspaceId: 'ws-1',
      crewId: 'crew-1',
      name: 'Survivor',
      cronExpr: '0 * * * *',
    });
    g.__runsDb!
      .prepare(`UPDATE schedules SET running = 1, last_run_id = ? WHERE id = ?`)
      .run('run-xyz', created.id);

    resetStuckSchedules();

    const row = g.__runsDb!
      .prepare(`SELECT * FROM schedules WHERE id = ?`)
      .get(created.id) as {
        running: number;
        enabled: number;
        next_fire_at: number | null;
        last_run_id: string | null;
      };
    expect(row.running).toBe(0);
    expect(row.enabled).toBe(1);
    expect(row.next_fire_at).not.toBeNull();
    expect(row.last_run_id).toBe('run-xyz');
  });
});
