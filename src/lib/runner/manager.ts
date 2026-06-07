// CrewRunner manager: orchestrates subprocess lifecycle, queueing, per-run emitters, and DB persistence.

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { resolveCrewClassName } from '@/lib/crew-studio';
import type {
  CrewRun,
  CrewRunSummary,
  CrewStudioCrew,
  CrewStudioWorkspace,
  TraceEvent,
} from '@/types';
import {
  appendEventToRun,
  appendOutputChunk,
  createRunWithPrune,
  getRun as dbGetRun,
  getRunsDb,
  getNextSequence,
  getRawRunMetrics,
  listRunSummaries,
  recordLlmCallAtomic,
  updateRunStatus,
} from '@/lib/runs-db';
import { enrichRunMetricsWithCost } from '@/lib/cortex-pricing';
import { logger as rootLogger } from '@/lib/logger';
import { getSnowflakeAuth, resolveLiteLlmJwt } from '@/lib/snowflake-auth';
import { materializeRun } from './materialize';
import {
  createSubCrewContextStack,
  handleTraceLine,
  type SubCrewContextStack,
} from './trace-parser';
import { executeEmailActions } from './email-actions';
import { collectGitHubTokenForwards } from './github-env';

/**
 * How many completed runs we keep in the database. Active runs are
 * always preserved; only terminal runs past this count get pruned.
 */
const MAX_STORED_RUNS = 100;
/** Cap events per run so a runaway crew can't blow up memory. */
const MAX_EVENTS_PER_RUN = 2_000;
/** How much stdout/stderr we keep per run. */
const MAX_OUTPUT_BYTES_PER_RUN = 1_000_000;
/**
 * Cap on the unflushed stdout line buffer. A python runner that emits no
 * newlines (corrupt output, binary blob) could otherwise grow this without
 * bound until Node OOMs. 1 MB is well above any sane single trace line.
 */
const MAX_STDOUT_BUFFER_BYTES = 1_000_000;

/**
 * Build a child-process env that only forwards an allowlist of the parent
 * env, plus the explicit `extras` we want set. The default subprocess env
 * inherits the entire parent env, which leaks unrelated secrets (AWS_*,
 * GITHUB_TOKEN, etc.) into the python runner. We forward only what the
 * runner actually needs.
 */
function subprocessEnv(extras: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // TLS / proxy / locale env vars need to propagate so the Python child
  // can honor corporate CA bundles and egress proxies. VIRTUAL_ENV is
  // useful when the host is running under a venv. We do NOT forward
  // arbitrary process.env — that would leak unrelated secrets to a
  // subprocess running LLM-generated code.
  const allow = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'PYTHONPATH',
    'VIRTUAL_ENV',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    // GitHub tool token forwarded by collectGitHubTokenForwards.
    // Stays inside the subprocess; never logged or surfaced in traces.
    'GITHUB_TOKEN',
    'GITHUB_TOKEN_AVAILABLE',
    // SPCS token-refresh daemon knobs. Forwarded only when set by the
    // operator; the Python helper uses sane defaults (300s interval,
    // refresher enabled when /snowflake/session/token exists) when
    // these are absent. SPCS_TOKEN_REFRESH_ENABLED=0 is the operator
    // kill switch for the refresher.
    'SPCS_TOKEN_REFRESH_ENABLED',
    'SPCS_TOKEN_REFRESH_INTERVAL_SECS',
  ];
  const out: Record<string, string | undefined> = {};
  for (const k of allow) if (process.env[k] != null) out[k] = process.env[k];
  for (const [k, v] of Object.entries(extras)) if (v != null) out[k] = v;
  return out as NodeJS.ProcessEnv;
}

/**
 * Build the set of per-workspace passwordEnvVar values to forward to
 * the Python subprocess so the embedded CrewStudioSnowflakeTool can read
 * `os.getenv(self.password_env)` in local mode. Restricted to
 * SNOWFLAKE_* names by the schema/normalizer; we re-check here as
 * defense in depth.
 */
function collectPasswordEnvForwards(
  workspace: { connections?: { passwordEnvVar?: string }[] }
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const re = /^SNOWFLAKE_[A-Z0-9_]+$/;
  for (const c of workspace.connections ?? []) {
    const name = c.passwordEnvVar?.trim();
    if (!name || !re.test(name)) continue;
    if (process.env[name] != null) out[name] = process.env[name];
  }
  return out;
}
/**
 * Cap on simultaneously running crews. Each run is a python subprocess
 * that holds a Cortex connection open and pulls tokens — running 20 in
 * parallel by accident (rapid-clicking "Run") will eat the box. Override
 * via CREW_MAX_CONCURRENT_RUNS for larger machines.
 */
const MAX_CONCURRENT_RUNS = Math.max(
  1,
  Number(process.env.CREW_MAX_CONCURRENT_RUNS) || 4
);

/** Lifecycle events emitted per run. */
export type RunnerEvent =
  | { type: 'event'; runId: string; event: TraceEvent }
  | { type: 'status'; runId: string; run: CrewRun }
  | { type: 'output'; runId: string; chunk: string }
  | { type: 'metrics'; runId: string; metrics: ReturnType<typeof enrichRunMetricsWithCost> };

/** Grace period between SIGTERM and SIGKILL when cancelling a run. */
const CANCEL_GRACE_MS = 3_000;

/**
 * Version stamp for the HMR-cached singleton. Bump this whenever the
 * manager's runtime shape changes in a way that makes reusing a stale
 * instance dangerous (new fields, changed lifecycle invariants, etc.).
 * Cached instances with a mismatched version are discarded on reload.
 */
const RUNNER_VERSION = 'wave-6-runner-v1';

/** Terminal run statuses — emitter cleanup is only safe after one of these. */
const TERMINAL_STATUSES: ReadonlySet<CrewRun['status']> = new Set([
  'completed',
  'errored',
  'cancelled',
]);

/**
 * Discriminated outcome from awaiting a subprocess. We need to keep the
 * spawn-error message intact (ENOENT / EACCES / permission failures all
 * surface here), instead of flattening to an exit code and losing the
 * original cause.
 */
type ExitOutcome =
  | { kind: 'exit'; code: number }
  | { kind: 'spawn-error'; message: string };

class CrewRunnerManager {
  /**
   * In-memory cache for ACTIVE runs (running/queued plus the just-finished
   * tail until the SSE listeners drop). This is what emitEvent/emitOutput
   * mutate so we don't round-trip the DB to merge a single new event into
   * the in-memory run shape.
   *
   * The DB is the source of truth — anything not in this map is read
   * straight from SQLite via getRun().
   */
  private active = new Map<string, CrewRun>();
  private processes = new Map<string, ChildProcess>();
  private killTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Counter for runs that have passed the concurrency gate but not yet
   * registered in `processes`. Closes the race where two concurrent
   * `startRun` calls both observe `processes.size < cap` before either
   * has had a chance to spawn its subprocess.
   */
  private pendingStarts = 0;

  /**
   * Run IDs that have been asked to cancel via `cancelRun` but whose
   * subprocess hasn't yet finalized. The exit-handling path consults this
   * set to decide whether to finalize as 'cancelled' vs 'errored'. Using
   * an intent set (not a status mutation) avoids the race where the
   * cancel handler emits a terminal status BEFORE the trailing stdout has
   * drained and reaped the emitter prematurely.
   */
  private cancelIntents = new Set<string>();

  /**
   * Run IDs whose terminal status has been emitted but whose detached
   * post-terminal side effects (executeEmailActions) are still in flight.
   * The emitter must NOT be reaped while this set contains the runId, or
   * the email completion/failure events get fan-out to no listeners.
   */
  private postTerminalInFlight = new Set<string>();

  /**
   * Pending dropFromActive timers keyed by runId. We track these so a
   * second terminal emission for the same run (defensive paths, retried
   * cleanups) doesn't schedule overlapping drops and shorten the SSE
   * close window.
   */
  private dropTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Per-run latch that prevents `executeRun`'s `finally` from
   * double-emitting a terminal status after the in-line exit branch has
   * already done so. Cleared automatically when the run is dropped from
   * active.
   */
  private terminalEmitted = new Set<string>();

  /**
   * Per-run EventEmitter map. Replaces the previous global EventEmitter
   * fan-out: each runId gets its own emitter so SSE listeners only see
   * events for the run they subscribed to. The emitter is created lazily
   * on the first subscribe (or first emit) and reaped when the run is
   * terminal AND no listeners remain.
   */
  private runEmitters = new Map<string, EventEmitter>();

  constructor() {
    // DB initialization (migrations, orphan cleanup, prune) runs lazily
    // on the first request that calls getRunsDb(). Doing it here would
    // trigger the migration UPDATE during Next.js build's page-data
    // collection, where multiple workers race for the write lock.
  }

  private nextSequence(runId: string): number {
    return getNextSequence(runId);
  }

  /**
   * Returns the per-run emitter, creating it on demand. Per-emitter
   * listener cap is small (50) because fan-out is now scoped to a single
   * run — even a hot run with many tabs won't approach that limit.
   */
  private getOrCreateEmitter(runId: string): EventEmitter {
    let emitter = this.runEmitters.get(runId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(50);
      this.runEmitters.set(runId, emitter);
    }
    return emitter;
  }

  /**
   * Emit a RunnerEvent to subscribers of a specific run. No-op if no
   * emitter exists (i.e. nobody is currently streaming this run).
   */
  private emitToRun(runId: string, ev: RunnerEvent): void {
    this.runEmitters.get(runId)?.emit('event', ev);
  }

  /**
   * Reap a run's emitter once it has no listeners AND the run has reached
   * a terminal state. Called after each unsubscribe and after every
   * terminal status emit; whichever happens last actually frees the slot.
   */
  private maybeReapEmitter(runId: string): void {
    const emitter = this.runEmitters.get(runId);
    if (!emitter) return;
    if (emitter.listenerCount('event') > 0) return;
    // Hold the emitter open while detached post-terminal work (email
    // actions, etc.) is still in flight — those side effects emit
    // log/warning events the SSE consumer cares about.
    if (this.postTerminalInFlight.has(runId)) return;
    // We only consult the cached run — once a run has been dropped from
    // `active` (via dropFromActive 1s after terminal), there's nothing
    // left to emit anyway, so it's safe to reap regardless.
    const cached = this.active.get(runId);
    if (cached && !TERMINAL_STATUSES.has(cached.status)) return;
    this.runEmitters.delete(runId);
  }

  /**
   * Subscribe to events for a single run. Returns an unsubscribe function
   * the caller MUST invoke when the stream tears down (client disconnect,
   * controller close, etc.) — otherwise the emitter leaks.
   */
  subscribe(runId: string, listener: (ev: RunnerEvent) => void): () => void {
    const emitter = this.getOrCreateEmitter(runId);
    emitter.on('event', listener);
    return () => {
      emitter.off('event', listener);
      this.maybeReapEmitter(runId);
    };
  }

  listRuns(opts: { workspaceId: string; ownerId: string }): CrewRunSummary[] {
    const summaries = listRunSummaries(opts.workspaceId, MAX_STORED_RUNS);
    if (summaries.length === 0) return summaries;
    // CrewRunSummary doesn't carry owner_id yet (sibling stream owns the
    // type/SQL change). Filter via a single keyed lookup against the runs
    // table so we don't N+1 the DB.
    const db = getRunsDb();
    const ids = summaries.map((s) => s.id);
    const placeholders = ids.map(() => '?').join(',');
    const ownerRows = db
      .prepare(
        `SELECT id, owner_id FROM runs WHERE id IN (${placeholders})`
      )
      .all(...ids) as Array<{ id: string; owner_id: string }>;
    const owners = new Map(ownerRows.map((r) => [r.id, r.owner_id]));
    return summaries.filter((s) => owners.get(s.id) === opts.ownerId);
  }

  getRun(id: string, ownerId: string): CrewRun | null {
    const cached = this.active.get(id);
    const base = cached || dbGetRun(id);
    if (!base) return null;
    // Treat ownership mismatch as not-found — never leak the existence
    // of a run that belongs to someone else.
    if (base.ownerId !== ownerId) return null;
    return { ...base, metrics: this.computeMetrics(id) };
  }

  private computeMetrics(runId: string) {
    const raw = getRawRunMetrics(runId);
    if (raw.totals.callCount === 0) return undefined;
    return enrichRunMetricsWithCost(raw);
  }

  /** Count of runs currently consuming a python subprocess slot. */
  private activeRunCount(): number {
    return this.processes.size + this.pendingStarts;
  }

  private dropFromActive(runId: string): void {
    // Hold the run in memory briefly so the SSE listener's terminal-status
    // close (~100ms after status fires) still sees the latest payload.
    // Track + dedupe the timer so repeated terminal emissions for the same
    // run don't stack overlapping drops (each new one would otherwise reset
    // the 1-second close window unpredictably).
    const existing = this.dropTimers.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.dropTimers.delete(runId);
      this.active.delete(runId);
      this.terminalEmitted.delete(runId);
    }, 1_000);
    timer.unref?.();
    this.dropTimers.set(runId, timer);
  }

  private recordLlmCall(
    runId: string,
    call: {
      model: string;
      agentId?: string;
      agentName?: string;
      taskId?: string;
      taskName?: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      latencyMs?: number | null;
    }
  ): void {
    // Bind to the same monotonic sequence as the trace event we'll emit
    // next, so the call ordering matches what the user sees in the
    // timeline. emitEvent will bump the sequence again — that's fine,
    // we just want the llm_call to come first. recordLlmCallAtomic reads
    // MAX(sequence) and inserts inside a single transaction so two
    // concurrent runners can't collide on the same sequence number.
    recordLlmCallAtomic(runId, {
      timestamp: new Date().toISOString(),
      model: call.model,
      agentId: call.agentId,
      agentName: call.agentName,
      taskId: call.taskId,
      taskName: call.taskName,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      totalTokens: call.totalTokens,
      latencyMs: call.latencyMs ?? null,
    });

    const metrics = this.computeMetrics(runId);
    if (metrics) {
      this.emitToRun(runId, { type: 'metrics', runId, metrics } satisfies RunnerEvent);
    }
  }

  async startRun(
    workspace: CrewStudioWorkspace,
    crew: CrewStudioCrew,
    inputs: Record<string, string>,
    ownerId: string,
    // PR 15: optional trigger metadata. Defaults to a manual trigger
    // when omitted, so every existing caller (POST /api/runs, etc.)
    // continues to work unchanged. The scheduler daemon passes
    // { triggerKind: 'scheduled', scheduleId } so the trace can show
    // "Triggered by schedule X" in the run history.
    trigger: { triggerKind?: 'manual' | 'scheduled'; scheduleId?: string } = {}
  ): Promise<CrewRun> {
    if (this.activeRunCount() >= MAX_CONCURRENT_RUNS) {
      const err = new Error(
        `At concurrent run limit (${MAX_CONCURRENT_RUNS}). Wait for an active run to finish or set CREW_MAX_CONCURRENT_RUNS to allow more.`
      );
      // Tag so the API route can return 429 instead of 500.
      (err as Error & { statusCode?: number }).statusCode = 429;
      throw err;
    }
    // Reserve a slot synchronously before any awaits so concurrent startRun
    // callers don't all squeeze through the gate; decremented in executeRun's
    // finally block.
    this.pendingStarts += 1;
    const run: CrewRun = {
      id: uuid(),
      workspaceId: workspace.id,
      ownerId,
      // Stamp the worker identity so the next worker boot's orphan sweep
      // can tell our live runs apart from rows left over from a crashed
      // sibling. PID alone is ambiguous across hosts; host alone is
      // ambiguous across workers on the same machine. We need both.
      ownerPid: process.pid,
      ownerHost: os.hostname(),
      crewId: crew.id,
      crewName: crew.name,
      status: 'queued',
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      inputs,
      output: '',
      error: null,
      events: [],
    };
    this.active.set(run.id, run);
    createRunWithPrune(run, MAX_STORED_RUNS);
    this.emitStatus(run);

    // Kick off async (don't await - caller returns immediately)
    void this.executeRun(run, workspace, crew, inputs, trigger);
    return run;
  }

  cancelRun(id: string, ownerId: string): boolean {
    // Ownership gate: pretend the run doesn't exist if the caller isn't
    // its owner. Mirrors getRun()'s not-found behaviour to avoid leaking
    // run-id existence to other authenticated users.
    const owned = this.getRun(id, ownerId);
    if (!owned) return false;

    const proc = this.processes.get(id);
    if (!proc) return false;

    // Bail if the run is already in a terminal state, or if a previous
    // cancel intent is still being processed. Without this guard a
    // rapid-clicking user can stack SIGTERMs and double-emit the cancel
    // warning.
    const run = this.active.get(id);
    if (run && TERMINAL_STATUSES.has(run.status)) return false;
    if (this.cancelIntents.has(id)) return false;

    // Record the intent FIRST so the exit branch can finalize as cancelled
    // even if the subprocess races us to close. Then emit a non-terminal
    // warning so the UI shows immediate feedback — terminal status is
    // emitted by the normal exit path after the subprocess actually
    // finalizes (this avoids reaping the emitter before trailing stdout
    // has flushed).
    this.cancelIntents.add(id);
    this.emitEvent(id, { type: 'warning', title: 'Cancelled by user' });

    try {
      proc.kill('SIGTERM');
    } catch {
      /* process may have already exited */
    }

    // Escalate to SIGKILL if the child hasn't exited within the grace period.
    // The timer is tracked in killTimers and cleared by the close handler
    // when the process exits cleanly.
    const existingTimer = this.killTimers.get(id);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.killTimers.delete(id);
      const stillRunning = this.processes.get(id);
      if (!stillRunning) return;
      try {
        stillRunning.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, CANCEL_GRACE_MS);
    timer.unref?.();
    this.killTimers.set(id, timer);
    return true;
  }

  private clearKillTimer(runId: string): void {
    const timer = this.killTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.killTimers.delete(runId);
  }

  private emitStatus(run: CrewRun) {
    updateRunStatus(run);
    this.emitToRun(run.id, { type: 'status', runId: run.id, run } satisfies RunnerEvent);
    // Terminal status may free the emitter if all listeners have already
    // detached. If listeners are still attached, the unsubscribe path
    // will reap it once they leave.
    if (TERMINAL_STATUSES.has(run.status)) {
      // Latch so executeRun's `finally` knows not to double-emit.
      this.terminalEmitted.add(run.id);
      this.maybeReapEmitter(run.id);
    }
  }

  private emitEvent(runId: string, ev: Omit<TraceEvent, 'id' | 'sequence' | 'timestamp'>) {
    const run = this.active.get(runId);
    if (!run) return;
    const event: TraceEvent = {
      id: uuid(),
      timestamp: new Date().toISOString(),
      sequence: this.nextSequence(runId),
      ...ev,
    };
    appendEventToRun(runId, event);
    run.events.push(event);
    if (run.events.length > MAX_EVENTS_PER_RUN) {
      // Trim the in-memory copy so a runaway crew doesn't blow up Node
      // heap. The DB still has every event — clients can query history
      // for the full trace if needed.
      const head = run.events.slice(0, 1);
      const tail = run.events.slice(-Math.floor(MAX_EVENTS_PER_RUN / 2));
      run.events = [...head, ...tail];
    }
    this.emitToRun(runId, { type: 'event', runId, event } satisfies RunnerEvent);
  }

  private emitOutput(runId: string, chunk: string) {
    const run = this.active.get(runId);
    if (!run) return;
    run.output += chunk;
    if (run.output.length > MAX_OUTPUT_BYTES_PER_RUN) {
      // Keep the tail — the most recent output is almost always what matters.
      run.output = run.output.slice(-MAX_OUTPUT_BYTES_PER_RUN);
    }
    appendOutputChunk(runId, chunk, MAX_OUTPUT_BYTES_PER_RUN);
    this.emitToRun(runId, { type: 'output', runId, chunk } satisfies RunnerEvent);
  }

  private async executeEmailActions(
    run: CrewRun,
    workspace: CrewStudioWorkspace,
    crew: CrewStudioCrew
  ): Promise<void> {
    await executeEmailActions(run, workspace, crew, (ev) => this.emitEvent(run.id, ev));
  }

  private async executeRun(
    run: CrewRun,
    workspace: CrewStudioWorkspace,
    crew: CrewStudioCrew,
    inputs: Record<string, string>,
    // PR 15: trigger metadata so the run-started trace event can
    // surface "Triggered by schedule X" / "Triggered manually".
    trigger: { triggerKind?: 'manual' | 'scheduled'; scheduleId?: string } = {}
  ) {
    run.status = 'running';
    this.emitStatus(run);
    this.emitEvent(run.id, {
      type: 'run_started',
      title: `Starting crew "${crew.name}"`,
      detail: `${crew.taskIds.length} task${crew.taskIds.length !== 1 ? 's' : ''} · ${crew.agentIds.length} agent${crew.agentIds.length !== 1 ? 's' : ''}`,
      nodeId: 'trigger',
      phase: 'running',
    });
    // PR 15: surface the trigger kind so the run history can show
    // "Triggered by schedule X" without joining against the schedules
    // table at read time. We emit this as a 'log' event because
    // TraceEventType doesn't (yet) include a dedicated 'trigger' type
    // and we don't want to widen the union outside this PR's surface.
    const triggerKind = trigger.triggerKind || 'manual';
    if (triggerKind === 'scheduled') {
      this.emitEvent(run.id, {
        type: 'log',
        title: 'Triggered by schedule',
        detail: trigger.scheduleId
          ? `scheduleId=${trigger.scheduleId}`
          : 'auto-scheduled run',
        nodeId: 'trigger',
        phase: 'running',
      });
    }

    let tmpDir: string | null = null;
    try {
      const candidate = process.env.CREW_PYTHON_BIN;
      if (candidate && !path.isAbsolute(candidate)) {
        throw new Error('CREW_PYTHON_BIN must be absolute');
      }
      const pythonBin = candidate || 'python3';
      // Build a temp project directory with the exports (after the env
      // check, so a bad CREW_PYTHON_BIN doesn't leak a tmp dir).
      tmpDir = materializeRun(run.id, workspace, inputs);
      const expectedClassName = resolveCrewClassName(workspace, crew);

      // Resolve Snowflake auth via the central helper:
      //   - In SPCS: reads the auto-mounted /snowflake/session/token,
      //     pairs it with SNOWFLAKE_HOST. No PAT needed.
      //   - Locally: SNOWFLAKE_PAT (or SNOWFLAKE_JWT) + the connection's
      //     account identifier.
      const workspaceAccount = workspace.connections.find(
        (c) => c.mode === 'snowflake-api' && c.enabled && c.account.trim()
      )?.account.trim();
      const auth = getSnowflakeAuth({
        fallbackAccount: workspaceAccount || process.env.SNOWFLAKE_ACCOUNT_ID,
      });

      if (!auth) {
        this.emitEvent(run.id, {
          type: 'warning',
          title: 'No Snowflake credentials available',
          detail:
            'In SPCS the session token mount (/snowflake/session/token) is missing; locally set SNOWFLAKE_PAT (or SNOWFLAKE_JWT) and SNOWFLAKE_ACCOUNT_ID, then retry.',
        });
      } else if (auth.source === 'spcs-session') {
        this.emitEvent(run.id, {
          type: 'log',
          title: 'Using SPCS session token',
          detail: `Calling Snowflake at ${auth.host} (internal route).`,
        });
      }

      // LiteLLM's Snowflake provider reads SNOWFLAKE_JWT. It accepts
      // OAuth/keypair JWTs as-is and PATs when prefixed with "pat/".
      // The auth helper may return null for OAuth flows where no
      // forwardable JWT is available — in that case we leave the env
      // var unset entirely rather than setting it to "".
      const rawJwt = auth ? resolveLiteLlmJwt(auth) : null;
      const resolvedSnowflakeJwt: string | undefined =
        typeof rawJwt === 'string' && rawJwt.length > 0 ? rawJwt : undefined;
      // Account identifier for tooling that wants the bare account
      // (not the full host). SNOWFLAKE_ACCOUNT is auto-injected in SPCS.
      const resolvedAccount =
        process.env.SNOWFLAKE_ACCOUNT?.trim() ||
        workspaceAccount ||
        process.env.SNOWFLAKE_ACCOUNT_ID ||
        '';

      // Resolve the per-user GitHub credential (if any agent declares the
      // `github` tool). Strictly additive: when no agent uses the tool
      // the helper returns an empty env map and the warning path is
      // skipped. When an agent declares it but no credential is stored,
      // we emit a non-terminal warning so the user sees the explanation
      // in the trace instead of a silent tool failure inside the crew.
      const githubForward = await collectGitHubTokenForwards(run.ownerId, workspace);
      if (githubForward.missingTokenButNeeded) {
        this.emitEvent(run.id, {
          type: 'warning',
          title: 'GitHub credential not connected',
          detail:
            'Crew uses GitHub tool but no credential is connected. Connect at /settings, then re-run.',
        });
      }

      const proc = spawn(pythonBin, ['run.py'], {
        cwd: tmpDir,
        env: subprocessEnv({
          ...collectPasswordEnvForwards(workspace),
          ...githubForward.env,
          PYTHONUNBUFFERED: '1',
          CREW_RUN_ID: run.id,
          CREW_CLASS_NAME: expectedClassName,
          OTEL_SDK_DISABLED: 'true',
          CREWAI_DISABLE_TELEMETRY: 'true',
          CREWAI_DISABLE_TRACKING: 'true',
          CREWAI_TRACING_ENABLED: 'false',
          CREWAI_STUDIO_ALLOW_HUMAN_INPUT: 'false',
          CREWAI_STORAGE_DIR: process.env.CREWAI_STORAGE_DIR,
          SNOWFLAKE_ACCOUNT_ID: resolvedAccount,
          SNOWFLAKE_HOST: process.env.SNOWFLAKE_HOST,
          SNOWFLAKE_ROLE: process.env.SNOWFLAKE_ROLE,
          // This is the INITIAL token only. The Python child runs a
          // daemon thread (snowflake_token_refresh.py) that re-reads
          // /snowflake/session/token every ~5min in SPCS and mutates
          // os.environ['SNOWFLAKE_JWT'] in-process so long crews don't
          // 401 when SPCS rotates the mount. Local PAT/JWT mode is a
          // pure no-op (the mount file is absent).
          SNOWFLAKE_JWT: resolvedSnowflakeJwt,
        }),
        // PR 33: open FD 3 as an additional pipe for the dedicated trace
        // stream. The Python sub-crew tool writes structured @@TRACE@@
        // lines via os.write(3, ...) so LLM-authored stdout can't
        // inject phantom frames. ['ignore','pipe','pipe','pipe'] = stdin
        // discarded, stdout + stderr captured, FD 3 captured as a 4th
        // pipe accessible at proc.stdio[3].
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      this.processes.set(run.id, proc);

      let buffer = '';
      // PR γ — sub-crew nesting context. Per-run, per-runner-instance
      // (this closure captures it so concurrent runs can't bleed into
      // each other). The stack is mutated by handleTraceLine as
      // subcrew_call / subcrew_complete frames go by.
      const subcrewContext: SubCrewContextStack = createSubCrewContextStack();
      // PR 33: handleLine is now channel-aware. Stdout lines flow as
      // the legacy fallback (silent pass-through), FD 3 lines flow as
      // the authoritative trace stream.
      const handleLine = (line: string, source: 'fd3' | 'stdout' = 'stdout') => {
        handleTraceLine(
          line,
          {
            recordLlmCall: (call) => this.recordLlmCall(run.id, call),
            emitEvent: (ev) => this.emitEvent(run.id, ev),
            emitOutput: (chunk) => this.emitOutput(run.id, chunk),
          },
          subcrewContext,
          source
        );
      };

      proc.stdout!.setEncoding('utf-8');
      proc.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) handleLine(line);
        if (buffer.length > MAX_STDOUT_BUFFER_BYTES) {
          this.emitEvent(run.id, {
            type: 'warning',
            title: 'Dropping unbounded stdout line',
            detail: `Runner emitted >${MAX_STDOUT_BUFFER_BYTES} bytes without a newline; buffer cleared to protect memory.`,
          });
          buffer = '';
        }
      });
      proc.stderr!.setEncoding('utf-8');
      proc.stderr!.on('data', (chunk: string) => {
        this.emitOutput(run.id, chunk);
      });

      // PR 33: dedicated FD 3 trace stream. proc.stdio is a tuple of
      // streams matching the spawn `stdio` option; index 3 is the FD 3
      // pipe we requested. better-sqlite3-style spawn typing returns
      // unknown for indexes past 2, so we narrow defensively.
      let fd3Buffer = '';
      const fd3Stream = (proc.stdio as Array<unknown>)[3] as
        | NodeJS.ReadableStream
        | undefined;
      if (fd3Stream && typeof fd3Stream === 'object' && 'on' in fd3Stream) {
        fd3Stream.setEncoding?.('utf-8');
        fd3Stream.on('data', (chunk: string | Buffer) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
          fd3Buffer += text;
          const lines = fd3Buffer.split(/\r?\n/);
          fd3Buffer = lines.pop() || '';
          for (const line of lines) handleLine(line, 'fd3');
          // Defensive: cap FD 3 buffer too. Python emits one trace per
          // line and flushes immediately, so a multi-MB unflushed
          // buffer means something is broken.
          if (fd3Buffer.length > MAX_STDOUT_BUFFER_BYTES) {
            this.emitEvent(run.id, {
              type: 'warning',
              title: 'Dropping unbounded FD 3 trace buffer',
              detail: `Trace stream emitted >${MAX_STDOUT_BUFFER_BYTES} bytes without a newline; buffer cleared.`,
            });
            fd3Buffer = '';
          }
        });
        // When the subprocess closes, flush any half-line so we don't
        // lose a final trace event that lacked a trailing newline.
        fd3Stream.on('end', () => {
          if (fd3Buffer.length > 0) {
            handleLine(fd3Buffer, 'fd3');
            fd3Buffer = '';
          }
        });
        // The FD 3 pipe is closed automatically when the subprocess
        // exits (Node tears down the child stdio tuple). We don't need
        // an explicit destroy here, but if the read stream errors
        // (rare — usually means the child closed FD 3 prematurely) we
        // log and move on. The exit-handling path is the authoritative
        // teardown.
        fd3Stream.on('error', (err) => {
          rootLogger.warn(
            { runId: run.id, err: err instanceof Error ? err.message : String(err) },
            'FD 3 trace stream errored'
          );
        });
      }

      // Use a discriminated outcome so spawn-error (ENOENT/EACCES/etc.)
      // survives to the exit-handling branch and lands in run.error, rather
      // than being flattened to "exit code 1" with the real cause lost in
      // the stdout tail.
      const outcome: ExitOutcome = await new Promise<ExitOutcome>((resolve) => {
        proc.once('close', (code) => resolve({ kind: 'exit', code: code ?? 1 }));
        proc.once('error', (err) => {
          this.emitOutput(run.id, `\n[runner error] ${err.message}\n`);
          resolve({ kind: 'spawn-error', message: err.message });
        });
      });
      if (buffer.length > 0) handleLine(buffer);
      this.processes.delete(run.id);
      this.clearKillTimer(run.id);

      if (outcome.kind === 'spawn-error') {
        run.status = 'errored';
        run.exitCode = null;
        run.completedAt = new Date().toISOString();
        run.error = `Failed to start runner: ${outcome.message}`;
        rootLogger.error(
          {
            runId: run.id,
            ownerId: run.ownerId,
            workspaceId: workspace.id,
            spawnError: outcome.message,
          },
          'crew runner spawn failed'
        );
        this.emitEvent(run.id, {
          type: 'run_errored',
          title: 'Crew errored',
          detail: run.error,
          nodeId: 'output',
          phase: 'failed',
        });
      } else {
        const exitCode = outcome.code;
        run.exitCode = exitCode;
        if (this.cancelIntents.has(run.id)) {
          // Cancel was requested; finalize as cancelled regardless of how
          // the subprocess actually exited. The non-terminal warning was
          // already emitted by cancelRun — we emit the terminal status
          // here via the normal exit path so trailing stdout has had a
          // chance to drain before the emitter is reaped.
          this.cancelIntents.delete(run.id);
          run.status = 'cancelled';
          run.completedAt = new Date().toISOString();
        } else if (exitCode === 0) {
          // Mark completed and emit terminal status immediately so the UI
          // doesn't sit on "running" while slow email actions fire. Email
          // actions are detached as a post-terminal side effect below.
          run.status = 'completed';
          run.completedAt = new Date().toISOString();
          this.emitEvent(run.id, {
            type: 'run_completed',
            title: 'Crew completed',
            nodeId: 'output',
            phase: 'completed',
          });
          this.emitStatus(run);
          // Fire email actions detached. Mark the run as having
          // post-terminal work in flight so maybeReapEmitter doesn't tear
          // down the emitter while emails are still emitting log events.
          this.postTerminalInFlight.add(run.id);
          void this.executeEmailActions(run, workspace, crew)
            .catch((err) => {
              this.emitEvent(run.id, {
                type: 'warning',
                title: 'Email actions failed',
                detail: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              this.postTerminalInFlight.delete(run.id);
              // Re-attempt reap now that side-effects are complete.
              this.maybeReapEmitter(run.id);
            });
        } else {
          run.status = 'errored';
          run.completedAt = new Date().toISOString();
          run.error = `Process exited with code ${exitCode}`;
          this.emitEvent(run.id, {
            type: 'run_errored',
            title: 'Crew errored',
            detail: run.error,
            nodeId: 'output',
            phase: 'failed',
          });
        }
      }
    } catch (error) {
      run.status = 'errored';
      run.completedAt = new Date().toISOString();
      run.error = error instanceof Error ? error.message : String(error);
      // Structured log so ops can grep by runId across worker stdout
      // even when no SSE client was attached to receive the trace event.
      rootLogger.error(
        {
          runId: run.id,
          ownerId: run.ownerId,
          workspaceId: workspace.id,
          crewId: crew.id,
          err: run.error,
          errName: error instanceof Error ? error.name : 'unknown',
        },
        'crew run errored (unhandled)'
      );
      this.emitEvent(run.id, {
        type: 'run_errored',
        title: 'Crew errored',
        detail: run.error,
        nodeId: 'output',
        phase: 'failed',
      });
    } finally {
      this.pendingStarts = Math.max(0, this.pendingStarts - 1);
      // The success branch already emitted terminal status (so email
      // actions could detach). For the cancelled / errored / spawn-error
      // branches, this is the single terminal emission. The latch
      // prevents a double-emit if a defensive caller has already done so.
      if (!this.terminalEmitted.has(run.id)) {
        this.emitStatus(run);
      }
      this.dropFromActive(run.id);
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* noop */
        }
      }
    }
  }
}

// Singleton — persist across hot reloads in dev by stashing on globalThis.
// We pair the cached instance with a RUNNER_VERSION stamp so HMR reloads
// that change the manager's shape don't silently keep a stale instance
// missing new fields/invariants. Mismatched stamp ⇒ fresh instance.
type GlobalWithRunner = typeof globalThis & {
  __crewRunner?: CrewRunnerManager;
  __crewRunnerVersion?: string;
};
const g = globalThis as GlobalWithRunner;
if (!g.__crewRunner || g.__crewRunnerVersion !== RUNNER_VERSION) {
  g.__crewRunner = new CrewRunnerManager();
  g.__crewRunnerVersion = RUNNER_VERSION;
}
export const crewRunner: CrewRunnerManager = g.__crewRunner;
