// ============================================================
// CrewAI Studio types
// ============================================================

export type CrewStudioConnectionMode = 'snowflake-api';
export type CrewStudioProcessMode = 'sequential' | 'hierarchical';
export type CrewStudioActionType = 'email';
export type CrewStudioEmailBodyMode = 'clean' | 'raw-html';

export interface CrewStudioConnection {
  id: string;
  name: string;
  description: string;
  mode: CrewStudioConnectionMode;
  enabled: boolean;
  isDefault: boolean;
  account: string;
  user: string;
  passwordEnvVar: string;
  warehouse: string;
  database: string;
  schema: string;
  role: string;
  queryGuide: string;
  toolName: string;
  allowedTools: string[];
  emailNotificationIntegration: string;
  emailDefaultRecipients: string[];
  notes: string;
}

export interface CrewStudioAgent {
  id: string;
  name: string;
  role: string;
  goal: string;
  backstory: string;
  llm: string;
  allowDelegation: boolean;
  verbose: boolean;
  maxIter: number;
  tools: string[];
  knowledge: string[];
  connectionIds: string[];
  tags: string[];
  /**
   * Sub-crew tool ids the agent can call. References ids in
   * `workspace.subCrewInvocations[].id`. Separate from `tools` so the
   * canonical KNOWN_AGENT_TOOLS registry stays small and typed. Empty
   * for agents that don't coordinate sub-crews. Existing workspaces on
   * disk that pre-date PR 20 normalize to `[]` (Zod uses `.optional()`).
   */
  subCrewToolIds: string[];
}

export interface CrewStudioTask {
  id: string;
  name: string;
  description: string;
  expectedOutput: string;
  agentId: string | null;
  contextTaskIds: string[];
  outputFile: string;
  humanInput: boolean;
  asyncExecution: boolean;
  markdown: boolean;
}

export interface CrewStudioAction {
  id: string;
  name: string;
  type: CrewStudioActionType;
  enabled: boolean;
  afterTaskId: string | null;
  connectionId: string | null;
  recipients: string[];
  subject: string;
  emailBodyMode: CrewStudioEmailBodyMode;
  notes: string;
}

export interface CrewStudioCrew {
  id: string;
  name: string;
  description: string;
  process: CrewStudioProcessMode;
  agentIds: string[];
  taskIds: string[];
  managerAgentId: string | null;
  memory: boolean;
  planning: boolean;
  verbose: boolean;
  tags: string[];
}

export interface CanvasNodePosition {
  x: number;
  y: number;
}

export interface CanvasLayout {
  nodes: Record<string, CanvasNodePosition>;
  zoom: number;
  panX: number;
  panY: number;
}

export interface CrewStudioWorkspace {
  id: string;
  /** Identity of the caller who owns this workspace. '__legacy__' for
   * pre-auth rows so they remain readable only in legacy mode. */
  ownerId: string;
  repoPath: string | null;
  name: string;
  description: string;
  productBrief: string;
  defaultLlm: string;
  tags: string[];
  agents: CrewStudioAgent[];
  tasks: CrewStudioTask[];
  actions: CrewStudioAction[];
  crews: CrewStudioCrew[];
  connections: CrewStudioConnection[];
  /**
   * Sub-crew invocations: "Coordinator" workflows declare these to let
   * a lead agent call another crew in the same workspace as a tool.
   * The lead can observe the output and re-invoke with refined inputs,
   * bounded by `maxInvocations` (Python-side enforced) and a recursion
   * cap (`SUBCREW_NESTING_DEPTH` env var). PR 20 ships the data model
   * + Python exporter; PR β adds the UI; PR γ adds nested telemetry.
   */
  subCrewInvocations: SubCrewInvocation[];
  canvasLayout: CanvasLayout;
  createdAt: string;
  updatedAt: string;
  /** Provenance: id of the workspace this one was forked/cloned from.
   * Null for workspaces created from scratch or from a template.
   * Server-set on POST /api/workspaces/[id]/clone and immutable from
   * the client side (not accepted in UpdateWorkspaceBody). */
  forkedFromId?: string | null;
}

/**
 * One sub-crew tool a Coordinator lead agent can invoke. Stored on the
 * workspace (not the agent) so multiple agents can share the same
 * invocation contract and so deletion of the source crew is a one-pointer
 * fix. See PR 20 design doc; PR β renders these in the config panel.
 */
export interface SubCrewInvocation {
  /** Stable id; referenced from `agent.subCrewToolIds`. */
  id: string;
  /** Display name shown in the agent's tool list (LLM-visible). */
  name: string;
  /** Tool description fed to the LLM so it can pick the right tool. */
  description: string;
  /**
   * Which crew (in this same workspace) this tool kicks off. Must
   * reference an existing `CrewStudioCrew.id`. Orphaned invocations
   * (target crew deleted) are filtered out by `normalizeCrewStudioWorkspace`
   * and surfaced as a `subcrew_orphaned` validation warning.
   */
  targetCrewId: string;
  /**
   * Per-call budget enforced inside the Python `SubCrewTool`. Even if
   * the LLM tries to call N+1 times, the tool refuses and returns a
   * "budget exhausted" message. Range 1..MAX_INVOCATIONS_PER_BOX (10).
   */
  maxInvocations: number;
  /**
   * Free-form text or a JSON template instructing the LLM how to shape
   * inputs for the target crew. Passed through verbatim to the
   * Python factory's docstring; the LLM reads it before calling.
   */
  inputMapping: string;
  /**
   * Optional rubric the lead can check the sub-crew's output against
   * to decide whether to re-invoke. Null when no rubric is supplied.
   */
  successCriteria: string | null;
  /**
   * V1 only supports 'isolated' — each kickoff is a fresh CrewAI run
   * with no shared memory. Reserved for a future 'shared' mode.
   */
  contextMode: 'isolated';
  /** Free-form tags for organization / filtering. */
  tags: string[];
}

export interface CrewStudioExportBundle {
  agentsYaml: string;
  tasksYaml: string;
  crewPython: string;
  envExample: string;
  /**
   * Source of the SPCS session-token refresh daemon. Optional for
   * backward compat: older mocks / serialized bundles may omit it.
   * When present, this is the verbatim text written to disk as
   * snowflake_token_refresh.py alongside crew.py.
   */
  tokenRefreshPython?: string;
  /**
   * Source of the SubCrewTool Python module (PR 20). Present only when
   * the source workspace declares at least one SubCrewInvocation; absent
   * for ordinary crews so the runner doesn't materialize a dead file.
   * Written to disk as `subcrew_tool.py` (see `getSubCrewToolFilename`).
   */
  subcrewToolPython?: string;
}

// ============================================================
// Validation
// ============================================================

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  id: string;
  severity: ValidationSeverity;
  code: string;
  message: string;
  /** Entity this issue points at, for click-to-focus */
  target?:
    | { kind: 'agent'; id: string }
    | { kind: 'task'; id: string }
    | { kind: 'action'; id: string }
    | { kind: 'connection'; id: string }
    | { kind: 'crew'; id: string };
}

// ============================================================
// Connection testing
// ============================================================

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  details?: string[];
}

export interface CortexModelOption {
  id: string;
  providerModelId: string;
  label: string;
  group: string;
  description: string;
  available: boolean;
  status?: number;
  reason?: string;
}

export interface CortexModelDiscoveryResult {
  ok: boolean;
  checkedAt: string;
  account?: string;
  models: CortexModelOption[];
  message: string;
  details?: string[];
}

// ============================================================
// Crew runs
// ============================================================

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'errored'
  | 'cancelled';

export type TraceEventType =
  | 'run_started'
  | 'run_completed'
  | 'run_errored'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'agent_thought'
  | 'tool_call'
  | 'tool_result'
  | 'token_usage'
  | 'log'
  | 'warning'
  // PR γ — sub-crew nesting telemetry. A `subcrew_call` event fires when
  // the Python SubCrewTool successfully kicks off a target crew; the
  // matching `subcrew_complete` fires from the same Python wrapper once
  // the kickoff has returned. The two together delimit the window during
  // which any other emitted events should be tagged with this
  // invocation as their `parentInvocationId` (see runner/trace-parser.ts
  // for the context-stack implementation).
  | 'subcrew_call'
  | 'subcrew_complete';

export type CanvasRunPhase = 'idle' | 'running' | 'completed' | 'failed';

export interface TraceEvent {
  id: string;
  timestamp: string;
  type: TraceEventType;
  title: string;
  detail?: string;
  taskName?: string;
  agentName?: string;
  toolName?: string;
  taskId?: string;
  agentId?: string;
  nodeId?: string;
  phase?: CanvasRunPhase;
  tokens?: number;
  /**
   * PR γ — sub-crew nesting context. Empty / absent for top-level
   * events. Populated by the runner trace-parser when an event is
   * emitted INSIDE a `subcrew_call` / `subcrew_complete` window so the
   * UI can indent it under the parent invocation.
   *
   * `invocationDepth` is 0 for top-level, 1 for events inside a direct
   * sub-crew, 2 for sub-sub-crew, etc. (capped at MAX_NESTING_DEPTH=5
   * by the SubCrewTool itself).
   *
   * `invocationNumber` / `invocationTotal` are present on the
   * `subcrew_call` event itself so the UI can render "Invocation 2 of
   * 3" without re-counting events.
   */
  metadata?: {
    parentInvocationId?: string;
    invocationDepth?: number;
    invocationNumber?: number;
    invocationTotal?: number;
    /** Display name of the target crew on a `subcrew_call` event. */
    target?: string;
  };
  /** Monotonic sequence within run so clients can resume */
  sequence: number;
}

export interface RunMetricsTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  latencyMs: number;
}

/** Raw token aggregates pulled from llm_calls storage. Cost is layered on
 * at the API boundary by cortex-pricing.ts so storage stays decoupled
 * from the always-shifting pricing table. */
export interface RawRunMetricsTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  latencyMs: number;
}

export interface RawRunMetricsByModel extends RawRunMetricsTotals {
  model: string;
}

export interface RawRunMetricsByAgent extends RawRunMetricsTotals {
  agentId: string | null;
  agentName: string | null;
}

export interface RawRunMetrics {
  totals: RawRunMetricsTotals;
  byModel: RawRunMetricsByModel[];
  byAgent: RawRunMetricsByAgent[];
}

export interface RunMetricsByModel extends RunMetricsTotals {
  model: string;
  /** Estimated Snowflake credits consumed (best-effort). */
  credits: number;
  /** Estimated USD at the configured credit→USD rate. */
  usd: number;
  /** False when no Cortex rate is known for this model. */
  estimated: boolean;
}

export interface RunMetricsByAgent extends RunMetricsTotals {
  agentId: string | null;
  agentName: string | null;
}

export interface RunMetrics {
  totals: RunMetricsTotals & {
    credits: number;
    usd: number;
    /** True when at least one model in the breakdown had a known rate. */
    estimated: boolean;
  };
  byModel: RunMetricsByModel[];
  byAgent: RunMetricsByAgent[];
}

export interface CrewRun {
  id: string;
  workspaceId: string;
  /** Denormalized owner identity for cheap ownership gating in the runner. */
  ownerId: string;
  crewId: string;
  crewName: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  inputs: Record<string, string>;
  output: string;
  error: string | null;
  events: TraceEvent[];
  /** Token + cost rollup. Computed on read; absent when no LLM calls captured yet. */
  metrics?: RunMetrics;
  /** PID of the Node.js worker that started this run. Used by the orphan
   * sweep to avoid killing runs owned by sibling workers. */
  ownerPid?: number;
  /** Hostname of the worker that started this run. Pairs with ownerPid. */
  ownerHost?: string;
}

export interface CrewRunSummary {
  id: string;
  workspaceId: string;
  crewId: string;
  crewName: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  eventCount: number;
}


// ============================================================
// Per-user credentials (PR 1 foundation; PR 2 wires OAuth)
// ============================================================

/**
 * Providers we currently encrypt credentials for. Keep in sync with
 * CredentialProviderSchema in src/lib/schemas/credentials.ts.
 */
export type CredentialProvider = 'github';

/**
 * One GitHub organization the user is a visible member of. Populated
 * by the OAuth callback from `GET /user/orgs`. `description` and
 * `avatarUrl` are nullable because GitHub returns them only when set
 * on the org profile.
 */
export interface GitHubOrgMembership {
  login: string;
  id: number;
  description: string | null;
  avatarUrl: string | null;
}

/**
 * Public-safe view of a stored credential. Never includes ciphertext,
 * IV, auth tag, wrapped data key, or the plaintext token — these stay
 * inside src/lib/credentials-db.ts.
 *
 * `metadata` carries non-secret per-credential context (e.g. GitHub
 * org memberships). Optional + nullable-deep so older rows (or rows
 * upserted before PR 12) still parse cleanly.
 */
export interface UserCredentialPublic {
  provider: CredentialProvider;
  accountLogin: string | null;
  accountId: string | null;
  scopes: string[];
  /** Unix epoch ms when the credential was first stored. */
  connectedAt: number;
  /** Unix epoch ms when the credential was last decrypted for use. */
  lastUsedAt: number | null;
  /** Unix epoch ms when the credential expires; null = no known expiry. */
  expiresAt: number | null;
  /** Non-secret context attached to this credential. */
  metadata?: {
    /** Visible GitHub org memberships at the time of the last connect. */
    organizations?: GitHubOrgMembership[];
  };
}

/**
 * Minimal projection of the GitHub `/user` response — just the fields
 * PR 2's OAuth callback consumes to populate `account_login` /
 * `account_id` on the stored credential row. Kept tiny on purpose so
 * we don't tie our type surface to GitHub's much larger user schema.
 */
export interface GitHubUser {
  login: string;
  id: number;
}


// ============================================================
// Workflow scheduling (PR 15)
// ============================================================

/**
 * What caused a run to start. The daemon emits 'scheduled' so the run
 * history can surface "Triggered by schedule X"; everything else uses
 * the default 'manual'.
 */
export type TriggerKind = 'manual' | 'scheduled';

/**
 * One saved cron schedule. Field names mirror the SQLite column order
 * but are camelCased — the row→object mapper in src/lib/schedules-db.ts
 * does the rename. Timestamps are unix epoch milliseconds (NOT ISO) so
 * the daemon's `next_fire_at <= ?` claim can use a single integer
 * comparison in SQLite without round-tripping through Date.parse.
 */
export interface Schedule {
  id: string;
  ownerId: string;
  workspaceId: string;
  crewId: string;
  name: string;
  cronExpr: string;
  /** IANA timezone (e.g. 'America/New_York'); defaults to 'UTC'. */
  timezone: string;
  enabled: boolean;
  /** Unix epoch ms of the next scheduled fire; null when paused/invalid. */
  nextFireAt: number | null;
  /** Unix epoch ms of the most recent successful fire; null until first run. */
  lastFiredAt: number | null;
  /** runs(id) of the most recent scheduled run; null on first save / failure. */
  lastRunId: string | null;
  /** Daemon claim flag. Internal — never exposed by SchedulePublic. */
  running: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Public-facing view of a schedule shipped to the UI. Timestamps are
 * ISO strings here (the UI parses with new Date and formats with
 * Intl.RelativeTimeFormat) and we surface a best-effort
 * humanizedCron rendering for display. The `running` flag stays
 * server-side — clients have no reason to know about it.
 */
export interface SchedulePublic {
  id: string;
  workspaceId: string;
  crewId: string;
  name: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  /** ISO 8601 of the next scheduled fire; null when paused/invalid. */
  nextFireAt: string | null;
  /** ISO 8601 of the most recent successful fire; null until first run. */
  lastFiredAt: string | null;
  lastRunId: string | null;
  /** Best-effort human rendering ("Every day at 9:00 AM"); never null. */
  humanizedCron: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Readiness (PR 16 — /api/health/ready response shape)
// ============================================================

/**
 * Client-side parsed view of GET /api/health/ready. The server payload
 * surfaces `envVars` as either `'ok'` or a `missing:VAR1,VAR2|VAR3`
 * string; the parser in useReadinessCheck.ts normalizes that into a
 * structured `{ missing: string[] }` so the banner can render each
 * variable individually. See src/app/api/health/ready/route.ts for the
 * server-side contract.
 */
export interface ReadinessStatus {
  status: 'ready' | 'not_ready' | 'unknown';
  checks: {
    db: 'ok' | 'failed' | 'unknown';
    envVars: 'ok' | { missing: string[] };
    credentialsKey: 'ok' | 'missing' | 'unknown';
  };
  mode: 'local' | 'spcs' | 'unknown';
}
