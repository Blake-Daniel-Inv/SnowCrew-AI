import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureDataDir } from './json-store';
import type {
  CrewRun,
  CrewRunSummary,
  RawRunMetrics,
  RawRunMetricsTotals,
  TraceEvent,
} from '@/types';

const DB_FILE = path.join(ensureDataDir('crew-studio'), 'runs.db');
const LEGACY_RUNS_FILE = path.join(ensureDataDir('crew-studio'), 'runs.json');

/* ------------------------------------------------------------------ */
/*  Connection                                                        */
/* ------------------------------------------------------------------ */

interface PreparedStatements {
  appendEvent: Statement;
  getNextSequenceEvents: Statement;
  updateRunStatus: Statement;
  appendOutputChunk: Statement;
  getRun: Statement;
  getRunEvents: Statement;
}

type GlobalWithDb = typeof globalThis & {
  __runsDb?: DatabaseType;
  __runsStmts?: { db: DatabaseType; stmts: PreparedStatements };
};
const g = globalThis as GlobalWithDb;

function openDb(): DatabaseType {
  const db = new Database(DB_FILE);
  // WAL gives us concurrent readers + a single writer with no `database
  // is locked` errors during long event-insert bursts. NORMAL sync is the
  // recommended balance: durable on OS crash, slightly less so on power
  // loss — fine for a dev/team tool.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Wait up to 5s for a contended writer instead of throwing SQLITE_BUSY
  // immediately — important when Next.js build workers all import the
  // module concurrently and try to run migrations.
  db.pragma('busy_timeout = 5000');
  return db;
}

export function getRunsDb(): DatabaseType {
  if (g.__runsDb) return g.__runsDb;
  const db = openDb();
  applyMigrations(db);
  migrateLegacyJson(db);
  // Scope the orphan sweep to this worker's PID/host. A sibling Next.js
  // worker booting while this one has live runs must not flip those rows
  // to errored — the per-process emitter map can't cross workers, but at
  // minimum we preserve the DB state.
  markOrphanedRunsErroredInternal(db, { pid: process.pid, host: os.hostname() });
  g.__runsDb = db;
  // The statements cache is gated on the DB handle identity below in
  // getStatements(), so it will be lazily (re)built on first use when the
  // handle changes (e.g., test teardown reassigns __runsDb).
  return db;
}

/**
 * Lazily build and cache prepared statements keyed off the singleton DB
 * handle. The cache is invalidated whenever the underlying DB handle is
 * reassigned (e.g., test teardown swaps `globalThis.__runsDb`), gated on
 * handle identity.
 */
function getStatements(): PreparedStatements {
  const db = getRunsDb();
  const cached = g.__runsStmts;
  if (cached && cached.db === db) return cached.stmts;
  const stmts: PreparedStatements = {
    appendEvent: db.prepare(
      `INSERT OR IGNORE INTO events
       (run_id, sequence, id, timestamp, type, title, detail,
        task_name, agent_name, tool_name, task_id, agent_id, node_id, phase, tokens,
        metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getNextSequenceEvents: db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS max FROM events WHERE run_id = ?'
    ),
    updateRunStatus: db.prepare(
      `UPDATE runs
       SET status = ?, completed_at = ?, exit_code = ?, error = ?, output = ?
       WHERE id = ?`
    ),
    appendOutputChunk: db.prepare(
      `UPDATE runs
       SET output = SUBSTR(output || ?, MAX(1, LENGTH(output || ?) - ? + 1))
       WHERE id = ?`
    ),
    getRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
    getRunEvents: db.prepare(
      'SELECT * FROM events WHERE run_id = ? ORDER BY sequence ASC'
    ),
  };
  g.__runsStmts = { db, stmts };
  return stmts;
}

/* ------------------------------------------------------------------ */
/*  Schema                                                            */
/* ------------------------------------------------------------------ */

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    crew_id       TEXT NOT NULL,
    crew_name     TEXT NOT NULL,
    status        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    exit_code     INTEGER,
    inputs_json   TEXT NOT NULL DEFAULT '{}',
    output        TEXT NOT NULL DEFAULT '',
    error         TEXT,
    owner_id      TEXT NOT NULL DEFAULT '__legacy__',
    owner_pid     INTEGER,
    owner_host    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_workspace_started
   ON runs(workspace_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started
   ON runs(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_owner
   ON runs(owner_id)`,
  // Partial index for the orphan sweep: only rows in 'running' or
  // 'queued' need to be searched by (owner_host, owner_pid). Keeps the
  // index small and fast versus a full-table index.
  `CREATE INDEX IF NOT EXISTS idx_runs_active_owner
     ON runs(owner_host, owner_pid)
     WHERE status IN ('running', 'queued')`,
  `CREATE TABLE IF NOT EXISTS events (
    run_id     TEXT NOT NULL,
    sequence   INTEGER NOT NULL,
    id         TEXT NOT NULL,
    timestamp  TEXT NOT NULL,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    detail     TEXT,
    task_name  TEXT,
    agent_name TEXT,
    tool_name  TEXT,
    task_id    TEXT,
    agent_id   TEXT,
    node_id    TEXT,
    phase      TEXT,
    tokens     INTEGER,
    -- PR γ: sub-crew nesting context. Always JSON; '{}' for top-level events.
    -- Populated for events emitted inside a SubCrewTool kickoff window so the
    -- UI can indent them under the parent invocation. See events.metadata
    -- migration block in applyMigrations() for the idempotent ALTER TABLE.
    metadata   TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  )`,
  // The Phase 2 placeholder table is replaced by per-call detail in
  // llm_calls. Drop is safe: nothing ever wrote to run_metrics.
  `DROP TABLE IF EXISTS run_metrics`,
  `CREATE TABLE IF NOT EXISTS llm_calls (
    run_id            TEXT NOT NULL,
    sequence          INTEGER NOT NULL,
    timestamp         TEXT NOT NULL,
    model             TEXT NOT NULL,
    agent_id          TEXT,
    agent_name        TEXT,
    task_id           TEXT,
    task_name         TEXT,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER,
    PRIMARY KEY (run_id, sequence),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  )`,
  // idx_llm_calls_run was redundant with the PK (run_id, sequence),
  // which already covers WHERE run_id = ? lookups. Drop it idempotently
  // — safe on fresh DBs where it never existed.
  `DROP INDEX IF EXISTS idx_llm_calls_run`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_run_agent
   ON llm_calls(run_id, agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_calls_run_task
   ON llm_calls(run_id, task_id)`,
  // Per-user encrypted credentials (PR 1: foundation only — no routes
  // yet). One row per (owner_id, provider) thanks to the UNIQUE
  // constraint, so re-connecting GitHub upserts the same row instead of
  // accumulating stale tokens. Ciphertext/IV/auth_tag/data_key_wrapped
  // are the AES-256-GCM envelope; see src/lib/crypto/envelope.ts.
  `CREATE TABLE IF NOT EXISTS user_credentials (
    id                TEXT PRIMARY KEY,
    owner_id          TEXT NOT NULL,
    provider          TEXT NOT NULL,
    account_login     TEXT,
    account_id        TEXT,
    scopes            TEXT NOT NULL DEFAULT '[]',
    ciphertext        TEXT NOT NULL,
    iv                TEXT NOT NULL,
    auth_tag          TEXT NOT NULL,
    data_key_wrapped  TEXT NOT NULL,
    connected_at      INTEGER NOT NULL,
    last_used_at      INTEGER,
    expires_at        INTEGER,
    metadata          TEXT NOT NULL DEFAULT '{}',
    UNIQUE(owner_id, provider)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_credentials_owner
   ON user_credentials(owner_id)`,
  // PR 15: workflow scheduling. One row per saved cron schedule.
  // The daemon (src/lib/scheduler/daemon.ts) polls every minute and
  // claims rows where enabled = 1 AND next_fire_at <= now() AND
  // running = 0 — see claimDueSchedules in src/lib/schedules-db.ts.
  // last_run_id is a soft FK to runs(id); we don't add ON DELETE
  // CASCADE because the schedule should survive its triggered run
  // being pruned (the MAX_STORED_RUNS sweep) — we just stop linking
  // back to a row that no longer exists. SQLite enforces the FK only
  // at INSERT/UPDATE time when foreign_keys=ON, so a pruned run won't
  // raise a constraint violation on the schedule row.
  `CREATE TABLE IF NOT EXISTS schedules (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL,
    workspace_id  TEXT NOT NULL,
    crew_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    cron_expr     TEXT NOT NULL,
    timezone      TEXT NOT NULL DEFAULT 'UTC',
    enabled       INTEGER NOT NULL DEFAULT 1,
    next_fire_at  INTEGER,
    last_fired_at INTEGER,
    last_run_id   TEXT REFERENCES runs(id),
    running       INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,
  // Composite index for the daemon's claim query:
  //   WHERE enabled = 1 AND running = 0 AND next_fire_at <= ?
  // Ordering (enabled, next_fire_at) matches the filter so SQLite
  // can binary-search; running is checked but low cardinality so we
  // leave it off the index key.
  `CREATE INDEX IF NOT EXISTS idx_schedules_due
   ON schedules(enabled, next_fire_at)`,
  // Owner-scoped listing index — every CRUD path filters by owner_id.
  `CREATE INDEX IF NOT EXISTS idx_schedules_owner
   ON schedules(owner_id)`,
  // PR 33 — append-only audit log for high-value mutations (credential
  // connect/disconnect, schedule CRUD + fire, email send). The table is
  // deliberately schema-light: a single TEXT id (UUID), a millisecond
  // timestamp, an actor_owner_id for HIPAA-style "who did what when",
  // and a JSON metadata blob for the action-specific fields. There is
  // NO delete path — audit rows are append-only by contract; no API
  // route exposes a DELETE handler.
  `CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT PRIMARY KEY,
    ts              INTEGER NOT NULL,
    actor_owner_id  TEXT,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}'
  )`,
  // Composite index for the "per-user history" query the runbook
  // documents. Ordering by ts within each owner is the common access
  // pattern; SQLite can binary-search via this index.
  `CREATE INDEX IF NOT EXISTS idx_audit_log_owner_ts
   ON audit_log(actor_owner_id, ts)`,
];

function applyMigrations(db: DatabaseType): void {
  db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
    // Lazy column add for databases created before owner_id existed.
    // CREATE TABLE IF NOT EXISTS won't touch the schema of an existing
    // table, so we have to inspect PRAGMA and ALTER in place. The NOT
    // NULL DEFAULT backfills every existing row to '__legacy__'.
    const cols = db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'owner_id')) {
      db.exec(
        `ALTER TABLE runs ADD COLUMN owner_id TEXT NOT NULL DEFAULT '__legacy__'`
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_owner ON runs(owner_id)`);
    }
    // owner_pid / owner_host are NULL-able by design: existing rows
    // pre-date multi-worker tracking and the sweep treats NULL as
    // "legacy / unknown" (eligible for orphan cleanup). Brand new rows
    // get stamped via insertRun.
    if (!cols.some((c) => c.name === 'owner_pid')) {
      db.exec(`ALTER TABLE runs ADD COLUMN owner_pid INTEGER`);
    }
    if (!cols.some((c) => c.name === 'owner_host')) {
      db.exec(`ALTER TABLE runs ADD COLUMN owner_host TEXT`);
    }
    // PR 12: per-credential metadata column. Holds non-secret JSON
    // context (e.g. GitHub org memberships) so the UI can surface it
    // without a decrypt round-trip. SQLite's `ALTER TABLE ... ADD COLUMN
    // ... NOT NULL DEFAULT` is metadata-only — it does not rewrite
    // existing rows, just records the default for backfill on read.
    //
    // Future schema migrations should follow this PRAGMA table_info gate
    // pattern; consider a dedicated migrations module if more than 2-3
    // accumulate.
    const credCols = db
      .prepare(`PRAGMA table_info(user_credentials)`)
      .all() as Array<{ name: string }>;
    if (!credCols.some((c) => c.name === 'metadata')) {
      db.exec(
        `ALTER TABLE user_credentials ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`
      );
    }
    // PR γ — events.metadata column for sub-crew nesting context. Mirrors
    // the PR 12 user_credentials.metadata pattern exactly: gate on
    // PRAGMA table_info, ALTER with NOT NULL DEFAULT so existing rows
    // backfill to '{}' on read without a row rewrite. Strictly additive
    // — pre-PR-γ callers that don't pass metadata continue to work.
    const eventCols = db
      .prepare(`PRAGMA table_info(events)`)
      .all() as Array<{ name: string }>;
    if (!eventCols.some((c) => c.name === 'metadata')) {
      db.exec(
        `ALTER TABLE events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`
      );
    }
  })();
}

/* ------------------------------------------------------------------ */
/*  Legacy JSON migration                                             */
/* ------------------------------------------------------------------ */

/**
 * One-shot migration from the old runs.json blob into SQLite. Safe to
 * call at every boot: only runs when the JSON exists and the runs table
 * is empty. After a successful import, the JSON is renamed (not deleted)
 * so the user can recover it manually if they want.
 */
function migrateLegacyJson(db: DatabaseType): void {
  if (!fs.existsSync(LEGACY_RUNS_FILE)) return;

  const existing = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
  if (existing.n > 0) return;

  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(LEGACY_RUNS_FILE, 'utf-8'));
  } catch {
    // Malformed JSON — skip, but don't block startup.
    return;
  }
  if (!Array.isArray(payload)) return;
  const runs = payload as CrewRun[];
  if (runs.length === 0) return;

  db.transaction(() => {
    for (const run of runs) {
      try {
        // Legacy JSON pre-dates the owner column. Stamp '__legacy__' so
        // these rows survive the migration but stay invisible to any
        // real authenticated caller.
        insertRun(db, { ...run, ownerId: '__legacy__' });
        for (const event of run.events || []) appendEvent(db, run.id, event);
      } catch {
        // Skip malformed individual entries; better to migrate what we
        // can than refuse to start.
      }
    }
  })();

  // Park the JSON so we don't re-import on next boot but the user can
  // still grab it if anything looks off.
  const archivePath = `${LEGACY_RUNS_FILE}.migrated-${Date.now()}`;
  try {
    fs.renameSync(LEGACY_RUNS_FILE, archivePath);
  } catch {
    // If the rename fails, we'll re-skip via the COUNT check next boot.
  }
}

/* ------------------------------------------------------------------ */
/*  Startup orphan handling                                           */
/* ------------------------------------------------------------------ */

/**
 * Sweep orphaned runs at worker boot. Scoped to this worker's PID/host so
 * a sibling Next.js worker booting while this one has live runs does NOT
 * flip those rows to errored.
 *
 * Marks as errored:
 *   (a) Legacy rows with NULL owner_pid/owner_host (no way to know if
 *       their subprocess survived — assume dead).
 *   (b) Rows from a different PID on the same host (this worker was
 *       restarted; the old subprocess is gone).
 *
 * Leaves alone:
 *   - Rows from the same PID (the current worker's own live runs).
 *   - Rows from a different host (some other machine owns those).
 */
export function markOrphanedRunsErrored(opts: { pid: number; host: string }): void {
  markOrphanedRunsErroredInternal(getRunsDb(), opts);
}

function markOrphanedRunsErroredInternal(
  db: DatabaseType,
  opts: { pid: number; host: string }
): void {
  const stmt = db.prepare(
    `UPDATE runs
     SET status = 'errored',
         completed_at = COALESCE(completed_at, ?),
         error = COALESCE(error, 'Process restarted')
     WHERE status IN ('running', 'queued')
       AND (
         owner_pid IS NULL
         OR (owner_host = ? AND owner_pid != ?)
       )`
  );
  stmt.run(new Date().toISOString(), opts.host, opts.pid);
}

/* ------------------------------------------------------------------ */
/*  Row mapping                                                       */
/* ------------------------------------------------------------------ */

interface RunRow {
  id: string;
  workspace_id: string;
  crew_id: string;
  crew_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  exit_code: number | null;
  inputs_json: string;
  output: string;
  error: string | null;
  owner_id: string;
  owner_pid: number | null;
  owner_host: string | null;
}

interface EventRow {
  run_id: string;
  sequence: number;
  id: string;
  timestamp: string;
  type: string;
  title: string;
  detail: string | null;
  task_name: string | null;
  agent_name: string | null;
  tool_name: string | null;
  task_id: string | null;
  agent_id: string | null;
  node_id: string | null;
  phase: string | null;
  tokens: number | null;
  // PR γ — JSON-encoded nesting context. NOT NULL DEFAULT '{}' at the
  // schema level so legacy rows backfill to an empty object on read.
  metadata: string;
}

function rowToRun(row: RunRow, events: TraceEvent[]): CrewRun {
  const run: CrewRun = {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    crewId: row.crew_id,
    crewName: row.crew_name,
    status: row.status as CrewRun['status'],
    startedAt: row.started_at,
    completedAt: row.completed_at,
    exitCode: row.exit_code,
    inputs: safeJson<Record<string, string>>(row.inputs_json, {}),
    output: row.output || '',
    error: row.error,
    events,
  };
  if (row.owner_pid !== null) run.ownerPid = row.owner_pid;
  if (row.owner_host !== null) run.ownerHost = row.owner_host;
  return run;
}

function rowToEvent(row: EventRow): TraceEvent {
  const event: TraceEvent = {
    id: row.id,
    timestamp: row.timestamp,
    sequence: row.sequence,
    type: row.type as TraceEvent['type'],
    title: row.title,
  };
  if (row.detail !== null) event.detail = row.detail;
  if (row.task_name !== null) event.taskName = row.task_name;
  if (row.agent_name !== null) event.agentName = row.agent_name;
  if (row.tool_name !== null) event.toolName = row.tool_name;
  if (row.task_id !== null) event.taskId = row.task_id;
  if (row.agent_id !== null) event.agentId = row.agent_id;
  if (row.node_id !== null) event.nodeId = row.node_id;
  if (row.phase !== null) event.phase = row.phase as TraceEvent['phase'];
  if (row.tokens !== null) event.tokens = row.tokens;
  // PR γ — parse metadata JSON. Safe-default to undefined on parse fail
  // or on the empty-object marker so the in-memory shape matches what
  // top-level events would have (i.e., absent rather than {}).
  if (row.metadata && row.metadata !== '{}') {
    const parsed = safeJson<TraceEvent['metadata']>(row.metadata, undefined);
    if (parsed && typeof parsed === 'object') {
      event.metadata = parsed;
    }
  }
  return event;
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/*  Read API                                                          */
/* ------------------------------------------------------------------ */

export function getRun(id: string): CrewRun | null {
  const stmts = getStatements();
  const row = stmts.getRun.get(id) as RunRow | undefined;
  if (!row) return null;

  const events = (stmts.getRunEvents.all(id) as EventRow[]).map(rowToEvent);

  return rowToRun(row, events);
}

export function listRunSummaries(workspaceId?: string, limit = 100): CrewRunSummary[] {
  const db = getRunsDb();
  const rows = (workspaceId
    ? db
        .prepare(
          `SELECT r.id, r.workspace_id, r.crew_id, r.crew_name, r.status,
                  r.started_at, r.completed_at,
                  COALESCE(e.cnt, 0) AS event_count
           FROM runs r
           LEFT JOIN (
             SELECT run_id, COUNT(*) AS cnt
             FROM events
             GROUP BY run_id
           ) e ON e.run_id = r.id
           WHERE r.workspace_id = ?
           ORDER BY r.started_at DESC
           LIMIT ?`
        )
        .all(workspaceId, limit)
    : db
        .prepare(
          `SELECT r.id, r.workspace_id, r.crew_id, r.crew_name, r.status,
                  r.started_at, r.completed_at,
                  COALESCE(e.cnt, 0) AS event_count
           FROM runs r
           LEFT JOIN (
             SELECT run_id, COUNT(*) AS cnt
             FROM events
             GROUP BY run_id
           ) e ON e.run_id = r.id
           ORDER BY r.started_at DESC
           LIMIT ?`
        )
        .all(limit)) as Array<{
    id: string;
    workspace_id: string;
    crew_id: string;
    crew_name: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    event_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    crewId: row.crew_id,
    crewName: row.crew_name,
    status: row.status as CrewRunSummary['status'],
    startedAt: row.started_at,
    completedAt: row.completed_at,
    eventCount: row.event_count,
  }));
}

export function listActiveRuns(): CrewRun[] {
  const db = getRunsDb();
  const stmts = getStatements();
  const rows = db
    .prepare(`SELECT * FROM runs WHERE status IN ('running', 'queued')`)
    .all() as RunRow[];
  return rows.map((row) => {
    const events = (stmts.getRunEvents.all(row.id) as EventRow[]).map(rowToEvent);
    return rowToRun(row, events);
  });
}

export function getNextSequence(runId: string): number {
  const stmts = getStatements();
  const row = stmts.getNextSequenceEvents.get(runId) as { max: number };
  return row.max + 1;
}

/* ------------------------------------------------------------------ */
/*  Write API                                                         */
/* ------------------------------------------------------------------ */

export function insertRun(db: DatabaseType, run: CrewRun): void {
  // UPSERT (not INSERT OR REPLACE): the latter DELETEs the existing row
  // before re-inserting, which cascades into events via the FK ON DELETE
  // CASCADE and wipes the run's trace history. ON CONFLICT DO UPDATE
  // preserves the row identity so child rows survive.
  db.prepare(
    `INSERT INTO runs
     (id, workspace_id, crew_id, crew_name, status, started_at,
      completed_at, exit_code, inputs_json, output, error, owner_id,
      owner_pid, owner_host)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       crew_id      = excluded.crew_id,
       crew_name    = excluded.crew_name,
       status       = excluded.status,
       started_at   = excluded.started_at,
       completed_at = excluded.completed_at,
       exit_code    = excluded.exit_code,
       inputs_json  = excluded.inputs_json,
       output       = excluded.output,
       error        = excluded.error,
       owner_id     = excluded.owner_id,
       owner_pid    = excluded.owner_pid,
       owner_host   = excluded.owner_host`
  ).run(
    run.id,
    run.workspaceId,
    run.crewId,
    run.crewName,
    run.status,
    run.startedAt,
    run.completedAt,
    run.exitCode,
    JSON.stringify(run.inputs || {}),
    run.output || '',
    run.error,
    run.ownerId || '__legacy__',
    run.ownerPid ?? null,
    run.ownerHost ?? null
  );
}

export function createRun(run: CrewRun): void {
  insertRun(getRunsDb(), run);
}

export function updateRunStatus(run: CrewRun): void {
  const stmts = getStatements();
  stmts.updateRunStatus.run(
    run.status,
    run.completedAt,
    run.exitCode,
    run.error,
    run.output || '',
    run.id
  );
}

export function appendOutputChunk(runId: string, chunk: string, maxBytes: number): void {
  const stmts = getStatements();
  // Concatenate then trim to last `maxBytes` so a runaway crew can't
  // grow the row unbounded. The SUBSTR trick keeps this server-side
  // (one round trip) instead of read-modify-write from Node.
  stmts.appendOutputChunk.run(chunk, chunk, maxBytes, runId);
}

export function appendEvent(db: DatabaseType, runId: string, event: TraceEvent): void {
  // When `db` matches the singleton, reuse the cached prepared statement;
  // otherwise fall back to a fresh prepare (callers that pass an
  // explicit db handle — e.g., migrations — should not depend on the
  // cache).
  const useCached = db === g.__runsDb;
  const stmt = useCached
    ? getStatements().appendEvent
    : db.prepare(
        `INSERT OR IGNORE INTO events
         (run_id, sequence, id, timestamp, type, title, detail,
          task_name, agent_name, tool_name, task_id, agent_id, node_id, phase, tokens,
          metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
  stmt.run(
    runId,
    event.sequence,
    event.id,
    event.timestamp,
    event.type,
    event.title,
    event.detail ?? null,
    event.taskName ?? null,
    event.agentName ?? null,
    event.toolName ?? null,
    event.taskId ?? null,
    event.agentId ?? null,
    event.nodeId ?? null,
    event.phase ?? null,
    event.tokens ?? null,
    // PR γ — serialize the nesting context. Empty object marker for
    // top-level events keeps the column NOT NULL and lets the row→event
    // mapper round-trip cleanly to absent. JSON.stringify(undefined) ===
    // undefined so we have to nullish-coalesce.
    event.metadata ? JSON.stringify(event.metadata) : '{}'
  );
}

export function appendEventToRun(runId: string, event: TraceEvent): void {
  appendEvent(getRunsDb(), runId, event);
}

/**
 * Batch insert multiple events for a run inside a single transaction,
 * reusing one prepared INSERT. Use this when the runner has N events to
 * flush at once — the prepared-statement + per-transaction overhead is
 * paid once rather than per event.
 *
 * This is the primitive; the runner side will be wired to it in a
 * separate change. Safe to call with an empty array.
 */
export function appendEventsBatch(runId: string, events: TraceEvent[]): void {
  if (events.length === 0) return;
  const db = getRunsDb();
  const stmt = getStatements().appendEvent;
  const insertMany = db.transaction((rows: TraceEvent[]) => {
    for (const event of rows) {
      stmt.run(
        runId,
        event.sequence,
        event.id,
        event.timestamp,
        event.type,
        event.title,
        event.detail ?? null,
        event.taskName ?? null,
        event.agentName ?? null,
        event.toolName ?? null,
        event.taskId ?? null,
        event.agentId ?? null,
        event.nodeId ?? null,
        event.phase ?? null,
        event.tokens ?? null,
        // PR γ — see appendEvent for the metadata serialization rationale.
        event.metadata ? JSON.stringify(event.metadata) : '{}'
      );
    }
  });
  insertMany(events);
}

/**
 * Trim oldest stored runs back down to `keepCount`. Active runs are
 * always preserved. Cascades into events via FK.
 */
export function pruneOldRuns(keepCount: number): void {
  const db = getRunsDb();
  db.prepare(
    `DELETE FROM runs
     WHERE id IN (
       SELECT id FROM runs
       WHERE status NOT IN ('running', 'queued')
       ORDER BY started_at DESC
       LIMIT -1 OFFSET ?
     )`
  ).run(keepCount);
}

/**
 * Insert a new run and prune older terminal runs in a single
 * transaction. Without this the runner does two sequential writes; a
 * crash between them can leave the row inserted but the prune undone
 * (or vice-versa). better-sqlite3 transactions are synchronous, so the
 * callback must not contain await.
 */
export function createRunWithPrune(run: CrewRun, maxStored: number): void {
  const db = getRunsDb();
  db.transaction(() => {
    insertRun(db, run);
    db.prepare(
      `DELETE FROM runs
       WHERE id IN (
         SELECT id FROM runs
         WHERE status NOT IN ('running', 'queued')
         ORDER BY started_at DESC
         LIMIT -1 OFFSET ?
       )`
    ).run(maxStored);
  })();
}

/* ------------------------------------------------------------------ */
/*  LLM call telemetry                                                */
/* ------------------------------------------------------------------ */

export interface LlmCall {
  /** Monotonic per-run; assigned by the runner so calls and trace events share an ordering. */
  sequence: number;
  timestamp: string;
  model: string;
  agentId?: string | null;
  agentName?: string | null;
  taskId?: string | null;
  taskName?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs?: number | null;
}

/**
 * Atomically assign the next sequence number for a run and insert the
 * LLM call row in a single transaction. The previous pattern
 * (getNextSequence followed by a separate insert) had a TOCTOU race:
 * two concurrent runners could read the same MAX(sequence) and the
 * second INSERT would silently clobber via INSERT OR REPLACE on the PK.
 *
 * Uses regular INSERT (no OR REPLACE) so a collision throws instead of
 * dropping a record. better-sqlite3 transactions are synchronous, so
 * the callback must not contain await.
 *
 * Returns the assigned sequence number.
 */
export function recordLlmCallAtomic(
  runId: string,
  call: Omit<LlmCall, 'sequence'>
): number {
  const db = getRunsDb();
  const stmts = getStatements();
  // Use a non-replacing INSERT inside the transaction so a PK collision
  // surfaces as an error rather than silently dropping a record. The
  // cached sequence-read statement is reused.
  const insertNoReplace = db.prepare(
    `INSERT INTO llm_calls
     (run_id, sequence, timestamp, model, agent_id, agent_name, task_id, task_name,
      prompt_tokens, completion_tokens, total_tokens, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return db.transaction(() => {
    const row = stmts.getNextSequenceEvents.get(runId) as { max: number };
    const sequence = row.max + 1;
    insertNoReplace.run(
      runId,
      sequence,
      call.timestamp,
      call.model,
      call.agentId ?? null,
      call.agentName ?? null,
      call.taskId ?? null,
      call.taskName ?? null,
      call.promptTokens,
      call.completionTokens,
      call.totalTokens,
      call.latencyMs ?? null
    );
    return sequence;
  })();
}

interface AggregateRow {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  call_count: number;
}

interface ModelAggregateRow extends AggregateRow {
  model: string;
}

interface AgentAggregateRow extends AggregateRow {
  agent_id: string | null;
  agent_name: string | null;
}

function rowToTotals(row: AggregateRow | undefined): RawRunMetricsTotals {
  return {
    promptTokens: row?.prompt_tokens || 0,
    completionTokens: row?.completion_tokens || 0,
    totalTokens: row?.total_tokens || 0,
    callCount: row?.call_count || 0,
    latencyMs: row?.latency_ms || 0,
  };
}

export function getRawRunMetrics(runId: string): RawRunMetrics {
  const db = getRunsDb();

  const totalsRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)      AS total_tokens,
         COALESCE(SUM(latency_ms), 0)        AS latency_ms,
         COUNT(*)                            AS call_count
       FROM llm_calls
       WHERE run_id = ?`
    )
    .get(runId) as AggregateRow | undefined;

  const modelRows = db
    .prepare(
      `SELECT
         model,
         COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)      AS total_tokens,
         COALESCE(SUM(latency_ms), 0)        AS latency_ms,
         COUNT(*)                            AS call_count
       FROM llm_calls
       WHERE run_id = ?
       GROUP BY model
       ORDER BY total_tokens DESC`
    )
    .all(runId) as ModelAggregateRow[];

  const agentRows = db
    .prepare(
      `SELECT
         agent_id,
         agent_name,
         COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)      AS total_tokens,
         COALESCE(SUM(latency_ms), 0)        AS latency_ms,
         COUNT(*)                            AS call_count
       FROM llm_calls
       WHERE run_id = ?
       GROUP BY agent_id, agent_name
       ORDER BY total_tokens DESC`
    )
    .all(runId) as AgentAggregateRow[];

  return {
    totals: rowToTotals(totalsRow),
    byModel: modelRows.map((row) => ({
      ...rowToTotals(row),
      model: row.model,
    })),
    byAgent: agentRows.map((row) => ({
      ...rowToTotals(row),
      agentId: row.agent_id,
      agentName: row.agent_name,
    })),
  };
}
