# Architecture

CrewAI Studio Local is a Next.js 16 + React 19 app that lets users visually
compose CrewAI control planes (agents, tasks, crews, Snowflake connections,
post-run actions) and execute them by spawning a Python subprocess that drives
CrewAI itself. All LLM traffic is routed through **Snowflake Cortex via
LiteLLM** — credentials and billing stay inside Snowflake, with no separate
model-vendor invoice.

The app runs in two deployment modes:

- **Local dev** — `npm run dev`, data in `~/.crewai-studio-local/`, auth via a
  PAT in `SNOWFLAKE_PAT`.
- **SPCS (Snowpark Container Services)** — Dockerized, data in `$DATA_DIR`
  (Snowflake stage volume), auth via the OAuth session token auto-mounted at
  `/snowflake/session/token`.

The same code paths handle both — see [Environment seam](#environment-seam-spcs-vs-local).

---

## High-level shape

```
┌──────────────────────────────── Browser ────────────────────────────────┐
│  CrewStudioApp (large client component + sibling CrewStudioApp/ hooks)  │
│  ├─ NodePalette ── drag ──▶ WorkflowCanvas (React Flow)                 │
│  │                          ├─ TaskNode / AgentNode / ConnectionNode... │
│  │                          └─ click ──▶ NodeConfigPanel                │
│  ├─ ValidationPanel  (live errors/warnings)                             │
│  ├─ RunPanel         (SSE-driven run timeline, metrics, cost)           │
│  └─ Workflow Assistant (in-app Cortex chat that proposes diffs)         │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ fetch / SSE
┌─────────────────────────────────▼───────────────────────────────────────┐
│  Next.js API routes  (src/app/api/**)                                   │
│  • /workspaces (CRUD)         • /runs (start/list/get/cancel)           │
│  • /workspaces/[id]           • /runs/[id]/stream  (SSE)                │
│  • /workspaces/assistant      • /runs/[id]/email                        │
│  • /connections/test          • /me                                     │
│  • /models/cortex                                                       │
└────────┬────────────────┬────────────────────┬───────────────┬──────────┘
         │                │                    │               │
         ▼                ▼                    ▼               ▼
   Workspace store    runs SQLite      crewRunner singleton   Cortex REST
   (JSON + lock)      (better-sqlite3) (per-run EventEmitter  api/v2/...
                                       map)
                                              │
                                              ▼
                                    spawn CREW_PYTHON_BIN
                                              │
                                              ▼
                                    /tmp/crewai-run-XXXX/
                                    ├─ config/agents.yaml
                                    ├─ config/tasks.yaml
                                    ├─ crew.py
                                    ├─ run.py  (instrumentation)
                                    └─ inputs.json
                                              │
                                              ▼
                                    CrewAI ── LiteLLM ── Cortex
                                              │
                                              ▼
                                    @@TRACE@@ json on stdout
                                              │
                                              ▼
                                    parsed → TraceEvent → SSE → UI
```

---

## Data flow: building a crew

1. User drags a node from `NodePalette` onto the canvas.
2. `WorkflowCanvas` ([src/components/WorkflowCanvas.tsx](src/components/WorkflowCanvas.tsx)) creates the entity in workspace state and gates new edges via `isWireableEdge` ([src/lib/workspace/graph.ts:47](src/lib/workspace/graph.ts#L47)). Only these pairs wire:
   - `agent → task`, `task → task`, `task → action`, `connection → agent`, `connection → action`
3. User edits the entity in `NodeConfigPanel`. Local state is the source of truth while editing; debounced PATCHes go to `/api/workspaces/[id]`.
4. The store layer ([src/lib/crew-studio-store.ts](src/lib/crew-studio-store.ts)) round-trips through `normalizeCrewStudioWorkspace`, which fills missing IDs, defaults, and sanitized identifiers — so anything written to disk is always valid.
5. Validation runs in pure TS on every change ([src/lib/validation.ts](src/lib/validation.ts)) and surfaces in `ValidationPanel`.

## Data flow: running a crew

The runtime side is the most interesting seam.

### 1. API entry — `POST /api/runs`

[src/app/api/runs/route.ts](src/app/api/runs/route.ts) loads the workspace + crew, then calls `crewRunner.startRun(...)`. Returns immediately with HTTP 201, the full run JSON in the body, and a `Location: /api/runs/{id}` header. If the concurrency cap is exceeded, returns HTTP 429.

### 2. CrewRunnerManager singleton

[src/lib/crew-runner.ts](src/lib/crew-runner.ts) is a process-wide singleton (stashed on `globalThis` so Next.js HMR doesn't duplicate it). It owns:

- An in-memory `Map<runId, CrewRun>` for **active** runs (the DB is the source of truth for everything else).
- A `Map<runId, ChildProcess>` for kill/cancel.
- A per-run EventEmitter map (`Map<runId, EventEmitter>`) that the SSE route subscribes to — the manager has one emitter per run, not a single global one.
- A concurrency cap (`CREW_MAX_CONCURRENT_RUNS`, default 4) — extra runs return HTTP 429.

### 3. Materialize a temp project

`executeRun` creates a `tmpdir` and writes:

| File | Source |
|---|---|
| `config/agents.yaml` | `buildCrewStudioExportBundle` |
| `config/tasks.yaml`  | `buildCrewStudioExportBundle` |
| `crew.py`            | `buildCrewStudioExportBundle` (includes a custom `CrewStudioSnowflakeTool` class — see [workspace/export/snowflake-tool.py.ts:25](src/lib/workspace/export/snowflake-tool.py.ts#L25)) |
| `inputs.json`        | request body |
| `studio-map.json`    | `{tasks, agents}` so `run.py` can map CrewAI events back to studio IDs |
| `run.py`             | `RUNNER_SCRIPT` constant — embedded in `crew-runner.ts` |

`buildCrewStudioExportBundle` is the **single source of truth** for crew code generation. The "Exports" tab in the UI calls it directly; the runner calls it to materialize the temp project. There is no second exporter.

### 4. Resolve Snowflake auth

[src/lib/snowflake-auth.ts](src/lib/snowflake-auth.ts) `getSnowflakeAuth()` returns one of three credentials in priority order:

| Source | Trigger | Token type | Host |
|---|---|---|---|
| `spcs-session` | `/snowflake/session/token` exists + `SNOWFLAKE_HOST` set | `OAUTH` | internal SNOWFLAKE_HOST (no External Access Integration needed) |
| `pat-env` | `SNOWFLAKE_PAT` set | `PROGRAMMATIC_ACCESS_TOKEN` | `<account>.snowflakecomputing.com` |
| `jwt-env` | `SNOWFLAKE_JWT` set | `KEYPAIR_JWT` (or PAT if prefixed `pat/`) | `<account>.snowflakecomputing.com` |

Cached for 60s. `resolveLiteLlmJwt` adds the `pat/` prefix LiteLLM's Snowflake provider expects when the resolved credential is a PAT.

### 5. Spawn the Python subprocess

`spawn($CREW_PYTHON_BIN, ['run.py'], …)` with `cwd = tmpdir`. Env passed in:

- `CREW_RUN_ID` — for log correlation
- `CREW_CLASS_NAME` — exact class to import out of `crew.py`
- `SNOWFLAKE_JWT`, `SNOWFLAKE_ACCOUNT_ID` — for LiteLLM
- `OTEL_SDK_DISABLED=true`, `CREWAI_DISABLE_TELEMETRY=true`, `CREWAI_TRACING_ENABLED=false` — keep CrewAI's own telemetry off (we have our own)
- `CREWAI_STUDIO_ALLOW_HUMAN_INPUT=false` — disable terminal prompts that would deadlock a server-spawned crew

In the Docker image, `CREW_PYTHON_BIN=/opt/crewai/bin/python3` is a baked-in venv with `crewai`, `crewai-tools`, `litellm`, and `snowflake-connector-python` pinned (see [Dockerfile](Dockerfile)).

### 6. The `@@TRACE@@` stdout protocol

`run.py` registers handlers on `crewai.events.crewai_event_bus` for `TaskStartedEvent`, `TaskCompletedEvent`, `AgentExecutionStartedEvent`, `LLMCallCompletedEvent`, `ToolUsageStartedEvent`, etc. Each handler prints one line:

```
@@TRACE@@ {"type":"task_started","title":"Task started","taskId":"abc","nodeId":"abc","phase":"running"}
```

Node side ([runner/manager.ts:482](src/lib/runner/manager.ts#L482)) splits stdout by line; the `@@TRACE@@ ` decode itself lives in [runner/trace-parser.ts](src/lib/runner/trace-parser.ts). If a line starts with `@@TRACE@@ `, parse the JSON into a `TraceEvent`. Otherwise treat as raw output. Token-usage events are split into two destinations:

- The trace event itself (for the timeline UI)
- An `llm_calls` row with prompt/completion/total tokens, model, agent, task, latency

This split is why per-agent / per-model cost rollups are cheap — they're SQL aggregates over `llm_calls`, not scans over event logs.

### 7. Stream to the browser

[src/app/api/runs/[id]/stream/route.ts](src/app/api/runs/[id]/stream/route.ts) opens an SSE channel:

- Initial `snapshot` event with the full current `CrewRun`.
- Subscribes to the per-run EventEmitter (`Map<runId, EventEmitter>`) for that run id; forwards every event the emitter receives.
- 15s heartbeats so proxies don't drop the connection.
- Closes 100ms after a terminal status arrives (gives the listener time to receive it).
- Tears down listeners on client disconnect via `ReadableStream`'s `cancel()`.

`RunPanel` ([src/components/RunPanel.tsx](src/components/RunPanel.tsx)) consumes the stream, threads events back through the canvas to highlight running/completed/failed nodes in real time, and shows the metrics bar (tokens, calls, estimated cost).

### 8. Post-run actions (email)

After a successful exit code, `executeEmailActions` ([runner/email-actions.ts:10](src/lib/runner/email-actions.ts#L10)) iterates the workspace's `actions` array, filters to enabled `email` actions whose `afterTaskId` was in the crew, and calls [src/lib/snowflake-email.ts](src/lib/snowflake-email.ts):

1. Markdown final output → safe HTML (`marked` + `DOMPurify` allowlist in [src/lib/run-output.ts](src/lib/run-output.ts)).
2. `CALL SYSTEM$SEND_EMAIL(…)` via Snowflake's `/api/v2/statements` endpoint.
3. 202 polling for async statements.

Manual re-send is available via `POST /api/runs/[id]/email`.

---

## Persistence

Two stores, two access patterns.

### Workspaces — JSON + per-path mutex

[src/lib/json-store.ts](src/lib/json-store.ts) wraps a single `workspaces.json` blob:

- **Atomic writes**: write to `<file>.<pid>.<ts>.tmp` then `rename` (atomic on POSIX).
- **Per-path mutex**: [src/lib/file-lock.ts](src/lib/file-lock.ts) — promise-chain mutex keyed by file path. FIFO; one caller's error cannot leak to other waiters; 30s timeout to break deadlocks.
- **Read-modify-write API**: `mutateJsonFile(path, fallback, mutator)` — concurrent PATCHes are serialized so no update is lost.

This is fine because workspace edits are infrequent and the blob is small. Don't reach for it for high-frequency state.

### Runs — SQLite (better-sqlite3)

[src/lib/runs-db.ts](src/lib/runs-db.ts), in `runs.db` next to the workspaces JSON. Tables:

| Table | Purpose |
|---|---|
| `runs` | One row per run: status, exit code, inputs, full output, error |
| `events` | One row per `TraceEvent`. PK `(run_id, sequence)` |
| `llm_calls` | One row per LLM call: model, agent_id, task_id, prompt/completion/total tokens, latency. Indexed by run, run+agent, run+task |

Configuration:

- WAL journaling — concurrent readers + single writer with no `SQLITE_BUSY` during event-insert bursts.
- 5s `busy_timeout` — Next.js build workers all import the module concurrently and would otherwise race on migrations.
- `ON DELETE CASCADE` from runs → events / llm_calls so prune-by-run works in one statement.

Boot-time chores ([runs-db.ts:34](src/lib/runs-db.ts#L34)):

1. Apply schema migrations (idempotent `CREATE IF NOT EXISTS`).
2. **Legacy JSON migration**: if `runs.json` exists and `runs` is empty, import once and rename the JSON to `*.migrated-<ts>`.
3. **Orphan handling**: any `running`/`queued` row at startup is from a previous server lifetime — its python subprocess is dead. Flip to `errored` so the UI doesn't show a forever-spinning trace.

---

## Cost estimation

[src/lib/cortex-pricing.ts](src/lib/cortex-pricing.ts) is intentionally **decoupled from storage**. `runs-db.ts` only stores token counts. Pricing layers on at read time via `enrichRunMetricsWithCost`:

- Static `DEFAULT_RATES` table (credits per 1M input/output tokens) anchored on Snowflake's published Sonnet 3.5 rate, scaled by Anthropic's tier ratios for newer variants.
- Per-model overrides via env: `CORTEX_RATE_<sanitized_model>=<in>/<out>`.
- Credit→USD via `SNOWFLAKE_CREDIT_USD` (default 3.0, Enterprise tier).

Treat the numbers as a directional signal — the authoritative record is `SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY`.

---

## The Workflow Assistant

[src/app/api/workspaces/assistant/route.ts](src/app/api/workspaces/assistant/route.ts) is an in-app chat that proposes workspace edits as a diff the user can preview/apply.

- Uses the same `getSnowflakeAuth()` path — no separate API key.
- Auto-routes between Sonnet 4.6 and Opus 4.7 based on prompt length, workspace size, and validation issue count (heuristic in `isComplexRequest`).
- Returns a JSON `{summary, changes, workspace}` patch. The client diffs it against the current workspace and shows it as a reviewable proposal.
- `ensureCanvasPositions` re-grids new entities so they're not all stacked at `(0,0)`.

---

## Environment seam: SPCS vs local

Three call sites decide which mode we're in:

| Decision | File | Source of truth |
|---|---|---|
| Where data lives | [src/lib/config.ts](src/lib/config.ts) `getConfigDir()` | `$DATA_DIR` set ⟹ container; else `~/.crewai-studio-local` |
| Which credential to use | [src/lib/snowflake-auth.ts](src/lib/snowflake-auth.ts) `getSnowflakeAuth()` | `/snowflake/session/token` exists ⟹ SPCS; else env vars |
| Whether to validate `repoPath` as a git repo | [src/lib/git-utils.ts](src/lib/git-utils.ts) `isGitRepo()` | `isContainerMode()` ⟹ skip; locally run `git rev-parse` |

Everything else — the runner, the exporter, the API routes, the UI — is mode-agnostic.

The Docker build ([Dockerfile](Dockerfile)) bakes a Python venv at `/opt/crewai`
with `crewai>=0.150`, `crewai-tools>=0.50`, `litellm>=1.50`, and
`snowflake-connector-python>=3.0`. `CREW_PYTHON_BIN` points at that venv so the
runner never picks up a system Python.

`CREWAI_STORAGE_DIR=/data/crewai-storage` keeps chromadb/cache state on the
persistent volume — `crewai` imports chromadb at module load and writes default
state under `Path.home()`, which would be ephemeral in a container layer.

---

## SPCS deployment

[snowflake/](snowflake/) holds the deployment artifacts:

- [setup.sql](snowflake/setup.sql) — image repo, internal stage, compute pool, service. Run once per account.
- [spec.yaml](snowflake/spec.yaml) — service spec; pulls a PAT secret in for `crewai-tools`' `SnowflakeSearchTool` (Cortex itself uses the session token).
- [deploy.sh](snowflake/deploy.sh) — `docker build --platform linux/amd64`, push to the Snowflake registry, rewrite the `image:` line in `spec.yaml` to the new tag.
- [setup-cortex-role.sql](snowflake/setup-cortex-role.sql) — least-privilege role for the service.
- [PAT-SETUP.md](snowflake/PAT-SETUP.md) — PAT generation walkthrough.
- [OPERATIONS.md](docs/OPERATIONS.md) — SPCS deploy + day-2 ops runbook (PR 33).

The auth model is **hybrid**:

- Cortex inference, `SYSTEM$SEND_EMAIL`, and statement API calls all use the
  SPCS-injected OAuth session token. Internal route, no External Access
  Integration, auto-rotated.
- The custom `CrewStudioSnowflakeTool` (in generated `crew.py`) **also** prefers
  the session token, falling back to PAT for local dev.
- The one path that still requires a PAT is `crewai-tools`' upstream
  `SnowflakeSearchTool` — its `SnowflakeConfig` only accepts password or
  private-key auth, no `authenticator='oauth'`. We work around this by injecting
  our own tool class instead, but the PAT secret is still wired in
  [spec.yaml](snowflake/spec.yaml) as a fallback.

---

## Key abstractions, by file

| File | What it owns |
|---|---|
| [src/types/index.ts](src/types/index.ts) | All shared types: `CrewStudioWorkspace`, `TraceEvent`, `RunMetrics`, `CrewStudioConnection`, etc. |
| [src/lib/crew-studio.ts](src/lib/crew-studio.ts) | Barrel re-exporting the `workspace/` submodules below |
| [src/lib/workspace/normalize.ts](src/lib/workspace/normalize.ts) | `normalizeCrewStudioWorkspace`: fills missing IDs, defaults, sanitized identifiers |
| [src/lib/workspace/graph.ts](src/lib/workspace/graph.ts) | Edge-legality rules (`isWireableEdge`) and workspace-graph helpers |
| [src/lib/workspace/export/](src/lib/workspace/export) | `buildCrewStudioExportBundle` + per-file generators (`agents.yaml`, `tasks.yaml`, `crew.py`, `snowflake-tool.py.ts`, `.env.example`) |
| [src/lib/crew-runner.ts](src/lib/crew-runner.ts) | Barrel re-exporting the `runner/` submodules below |
| [src/lib/runner/manager.ts](src/lib/runner/manager.ts) | `CrewRunnerManager` singleton — active-run map, per-run emitters, concurrency cap, stdout split loop |
| [src/lib/runner/materialize.ts](src/lib/runner/materialize.ts) | Writes the temp project (`config/*.yaml`, `crew.py`, `run.py`, `inputs.json`, `studio-map.json`) |
| [src/lib/runner/trace-parser.ts](src/lib/runner/trace-parser.ts) | `@@TRACE@@ <json>` line decoder → `TraceEvent` |
| [src/lib/runner/email-actions.ts](src/lib/runner/email-actions.ts) | `executeEmailActions`: post-run filter + dispatch via `snowflake-email.ts` |
| [src/lib/runner/run-py.ts](src/lib/runner/run-py.ts) | The embedded `RUNNER_SCRIPT` Python instrumentation written to `run.py` |
| [src/lib/runs-db.ts](src/lib/runs-db.ts) | SQLite schema, migrations, orphan cleanup, run + event + llm_calls APIs |
| [src/lib/crew-studio-store.ts](src/lib/crew-studio-store.ts) | Workspace JSON CRUD |
| [src/lib/json-store.ts](src/lib/json-store.ts) + [src/lib/file-lock.ts](src/lib/file-lock.ts) | Atomic JSON writes with per-path mutex |
| [src/lib/snowflake-auth.ts](src/lib/snowflake-auth.ts) | SPCS / PAT / JWT resolution; LiteLLM JWT formatting |
| [src/lib/snowflake-email.ts](src/lib/snowflake-email.ts) | `SYSTEM$SEND_EMAIL` via Snowflake REST API; markdown sanitization |
| [src/lib/connection-test.ts](src/lib/connection-test.ts) | Cortex auth probe (`max_tokens:1`); model availability check |
| [src/lib/cortex-models.ts](src/lib/cortex-models.ts) | Parallel model availability discovery against the Cortex inference endpoint |
| [src/lib/cortex-pricing.ts](src/lib/cortex-pricing.ts) | Static rate table, env overrides, `enrichRunMetricsWithCost` |
| [src/lib/templates.ts](src/lib/templates.ts) | Pre-built workspaces (blank / starter / snowflake-usage / data-analysis) |
| [src/lib/validation.ts](src/lib/validation.ts) | Pure-TS workspace validation; task-cycle DFS |
| [src/lib/run-output.ts](src/lib/run-output.ts) | ANSI stripping, `===== FINAL OUTPUT =====` extraction, markdown→safe HTML |
| [src/components/CrewStudioApp.tsx](src/components/CrewStudioApp.tsx) | Top-level client component; owns workspace state, panes, theme, assistant. Large but paired with a sibling [src/components/CrewStudioApp/](src/components/CrewStudioApp) directory of extracted hooks (`useActiveRunStream`, `useAssistantProposal`, `usePaneSizes`, `useWorkspaceDraft`, etc.) |
| [src/components/WorkflowCanvas.tsx](src/components/WorkflowCanvas.tsx) | React Flow canvas; live run-phase highlighting |
| [src/components/RunPanel.tsx](src/components/RunPanel.tsx) | SSE consumer, run timeline, metrics bar |
| [src/components/NodeConfigPanel.tsx](src/components/NodeConfigPanel.tsx) | Right-side editor for selected entity |

---

## Where the seams are

These are the boundaries you'll cross when extending the app. Most changes
that touch only one of these are local; changes that span two warrant extra
care.

1. **TypeScript ↔ Python via stdout protocol.** No RPC, no shared library — just `@@TRACE@@ <json>` lines. Adding a new event type means agreeing on a `TraceEventType` literal in [src/types/index.ts](src/types/index.ts) and emitting it from `RUNNER_SCRIPT` inside [crew-runner.ts](src/lib/crew-runner.ts). The runner falls back to "treat as log" when JSON parse fails, so the wire format is forward-compatible.

2. **JSON store ↔ SQLite store.** Workspaces are infrequent, structured-as-a-blob, and atomically rewritten under a mutex. Runs are append-mostly, indexed, queried for aggregates. Don't put run telemetry in the JSON store; don't put workspace state in SQLite.

3. **SPCS ↔ local dev.** Decided in three places (`getConfigDir`, `getSnowflakeAuth`, `isGitRepo`). Everything else is environment-agnostic. New code that needs to branch on environment should go through one of those helpers, not re-detect.

4. **Authoring ↔ executing.** `buildCrewStudioExportBundle` is the single source of truth for crew code generation. Both the "Exports" tab and the live runner consume it. Don't add a second renderer.

5. **Storage ↔ pricing.** `runs-db.ts` stores raw token counts only. `cortex-pricing.ts` layers cost estimates on at read time. Pricing tables drift; raw counts don't. Keep them separate.

6. **Cortex auth ↔ Snowflake data tools.** Cortex inference and `SYSTEM$SEND_EMAIL` use the session token. The custom `CrewStudioSnowflakeTool` prefers it too. The legacy upstream `SnowflakeSearchTool` can't, which is the only reason a PAT secret is still wired into the SPCS spec.

7. **Server EventEmitter ↔ SSE clients.** The runner maintains a per-run EventEmitter map (`Map<runId, EventEmitter>`); SSE routes subscribe to the emitter for their specific `runId` and forward. Cancellation and teardown happen on the route side — the runner doesn't track listeners. New consumers (e.g. webhooks, log shippers) should subscribe the same way.

---

## Operational defaults worth knowing

| Env var | Default | What it controls |
|---|---|---|
| `CREW_PYTHON_BIN` | `python3` (image: `/opt/crewai/bin/python3`) | Python interpreter for the crew runner |
| `CREW_MAX_CONCURRENT_RUNS` | `4` | Concurrency cap on simultaneous python subprocesses |
| `DATA_DIR` | unset | When set, switches to container mode + uses this dir for all state |
| `CONTAINER_MODE` | unset | Marks container mode without overriding `DATA_DIR` |
| `SNOWFLAKE_ACCOUNT_ID` | — | Account identifier for env-based auth |
| `SNOWFLAKE_PAT` | — | PAT for local dev (preferred over JWT) |
| `SNOWFLAKE_JWT` | — | Keypair JWT or `pat/`-prefixed PAT |
| `SNOWFLAKE_HOST` | — | Internal SPCS host (set by SPCS automatically) |
| `SNOWFLAKE_CREDIT_USD` | `3.0` | USD per credit for cost rollups |
| `CORTEX_RATE_<model>` | from `DEFAULT_RATES` | Per-model rate override, format `<in>/<out>` per 1M tokens |
| `CREWAI_STORAGE_DIR` | image: `/data/crewai-storage` | chromadb/cache location |
| `CREWAI_STUDIO_ALLOW_HUMAN_INPUT` | `false` | Studio runs disable terminal prompts; flip on only for exported CLI runs |

Caps inside the runner:

- `MAX_STORED_RUNS = 100` — terminal runs past this are pruned (active runs always preserved).
- `MAX_EVENTS_PER_RUN = 2_000` — in-memory event cap; the DB still has every event.
- `MAX_OUTPUT_BYTES_PER_RUN = 1_000_000` — runaway-output guard.
- `CANCEL_GRACE_MS = 3_000` — SIGTERM → SIGKILL escalation window for `cancelRun`.
