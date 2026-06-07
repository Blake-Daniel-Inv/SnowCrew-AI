// Workspace + sub-entity normalization for CrewStudio persisted state.

import { v4 as uuid } from 'uuid';
import type {
  CrewStudioAgent,
  CrewStudioAction,
  CrewStudioConnection,
  CrewStudioCrew,
  CrewStudioActionType,
  CrewStudioTask,
  CrewStudioWorkspace,
  SubCrewInvocation,
} from '@/types';
import { SUBCREW_LIMITS } from '@/lib/schemas/field-limits';

export function sanitizeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

export function toPascalCase(value: string, fallback: string): string {
  return (
    sanitizeIdentifier(value, fallback)
      .split('_')
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join('') || fallback
  );
}

/**
 * Resolve the Python class name the exporter will generate for a given
 * crew + workspace pair. Exposed so callers (e.g. the runner) can locate
 * the class in the emitted crew.py without guessing.
 */
export function resolveCrewClassName(
  workspace: CrewStudioWorkspace,
  crew?: CrewStudioCrew | null
): string {
  const source = (crew ?? workspace.crews[0])?.name || workspace.name;
  return `${toPascalCase(source, 'CrewStudio')}Crew`;
}

export function yamlBlock(value: string, indent = 4): string {
  const padding = ' '.repeat(indent);
  const content = value.trim() || 'TBD';
  // Indent each line and trim trailing whitespace, but preserve blank
  // lines as actual blanks — replacing them with 'TBD' would inject
  // stray placeholder text inside multi-line role/goal/backstory values.
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/\s+$/, '');
      return trimmed ? `${padding}${trimmed.replace(/^\s+/, '')}` : '';
    })
    .join('\n');
}

export function pyString(value: string): string {
  return JSON.stringify(value);
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

// Clamp arbitrary inputs to a finite positive integer with a default
// fallback. Anything non-finite, non-positive, or non-numeric becomes
// `fallback` so it can never leak NaN/Infinity into emitted YAML.
function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}

// Env-var identifier rule: must start with SNOWFLAKE_ so a workspace
// blob can't be used to read unrelated process env vars (AWS, OPENAI,
// etc.) via the runner's per-connection passwordEnvVar lookup.
const ENV_VAR_NAME_RE = /^SNOWFLAKE_[A-Z0-9_]+$/;

/**
 * Filter `task.contextTaskIds` to exclude self-references and any id whose
 * inclusion would create a cycle in the task-context graph. We walk the
 * graph from each candidate context id; if we can reach `task.id`, that
 * candidate would close a cycle and is dropped silently.
 *
 * Exposed so YAML emitters can call this at emit time without rebuilding
 * the workspace.
 */
export function filterAcyclicContextTaskIds(
  workspace: CrewStudioWorkspace,
  task: CrewStudioTask
): string[] {
  if (!task.contextTaskIds.length) return [];

  const tasksById = new Map<string, CrewStudioTask>();
  for (const candidate of workspace.tasks) {
    tasksById.set(candidate.id, candidate);
  }

  const wouldCycle = (candidateId: string): boolean => {
    // Self-reference closes the trivial cycle.
    if (candidateId === task.id) return true;
    const seen = new Set<string>();
    const stack: string[] = [candidateId];
    while (stack.length) {
      const current = stack.pop() as string;
      if (current === task.id) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const node = tasksById.get(current);
      if (!node) continue;
      for (const next of node.contextTaskIds) {
        stack.push(next);
      }
    }
    return false;
  };

  const seenIds = new Set<string>();
  const result: string[] = [];
  for (const candidateId of task.contextTaskIds) {
    if (seenIds.has(candidateId)) continue;
    seenIds.add(candidateId);
    if (!tasksById.has(candidateId)) continue;
    if (wouldCycle(candidateId)) continue;
    result.push(candidateId);
  }
  return result;
}

function normalizeConnection(
  connection: Partial<CrewStudioConnection>,
  index: number
): CrewStudioConnection {
  const rawPasswordEnvVar = connection.passwordEnvVar?.trim() || '';
  // Preserve empty (intentionally-unset) values; only rewrite when the
  // user supplied a non-empty value that doesn't match the SNOWFLAKE_*
  // allowlist. The allowlist defends against env-var enumeration of
  // unrelated process env vars (AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY,
  // etc.) via this connection field.
  const passwordEnvVar = !rawPasswordEnvVar
    ? ''
    : ENV_VAR_NAME_RE.test(rawPasswordEnvVar)
      ? rawPasswordEnvVar
      : 'SNOWFLAKE_PAT';
  return {
    id: connection.id || uuid(),
    name: connection.name?.trim() || `Snowflake Connection ${index + 1}`,
    description: connection.description?.trim() || '',
    mode: 'snowflake-api',
    enabled: connection.enabled ?? true,
    isDefault: connection.isDefault ?? index === 0,
    account: connection.account?.trim() || '',
    user: connection.user?.trim() || '',
    passwordEnvVar,
    warehouse: connection.warehouse?.trim() || '',
    database: connection.database?.trim() || '',
    schema: connection.schema?.trim() || '',
    role: connection.role?.trim() || '',
    queryGuide: connection.queryGuide?.trim() || '',
    toolName: connection.toolName?.trim() || '',
    allowedTools: normalizeStringArray(connection.allowedTools),
    emailNotificationIntegration: connection.emailNotificationIntegration?.trim() || '',
    emailDefaultRecipients: normalizeStringArray(connection.emailDefaultRecipients),
    notes: connection.notes?.trim() || '',
  };
}

function normalizeAgent(agent: Partial<CrewStudioAgent>, workspace: CrewStudioWorkspace): CrewStudioAgent {
  return {
    id: agent.id || uuid(),
    name: agent.name?.trim() || 'New Agent',
    role: agent.role?.trim() || 'Specialist operator',
    goal: agent.goal?.trim() || 'Drive a focused outcome for the crew.',
    backstory:
      agent.backstory?.trim() ||
      `Embedded in ${workspace.name}, this agent translates intent into structured output.`,
    llm: agent.llm?.trim() || workspace.defaultLlm || 'snowflake/claude-sonnet-4-6',
    allowDelegation: agent.allowDelegation ?? true,
    verbose: agent.verbose ?? true,
    maxIter: clampPositiveInt(agent.maxIter, 12),
    tools: normalizeStringArray(agent.tools),
    knowledge: normalizeStringArray(agent.knowledge),
    connectionIds: normalizeStringArray(agent.connectionIds),
    tags: normalizeStringArray(agent.tags),
    // Sub-crew tool ids: deduped + trimmed. Dangling references (tools
    // that point at an invocation no longer present on the workspace)
    // are filtered out by `pruneSubCrewToolIds` after subCrewInvocations
    // are normalized at the workspace level. We keep the raw array here
    // because normalizeAgent runs before subCrewInvocations are
    // available for the bound check.
    subCrewToolIds: normalizeStringArray(agent.subCrewToolIds),
  };
}

function normalizeTask(task: Partial<CrewStudioTask>): CrewStudioTask {
  return {
    id: task.id || uuid(),
    name: task.name?.trim() || 'new_task',
    description: task.description?.trim() || 'Describe the work this task should complete.',
    expectedOutput: task.expectedOutput?.trim() || 'Structured findings and a concise final artifact.',
    agentId: task.agentId || null,
    contextTaskIds: normalizeStringArray(task.contextTaskIds),
    outputFile: task.outputFile?.trim() || '',
    humanInput: task.humanInput ?? false,
    asyncExecution: task.asyncExecution ?? false,
    markdown: task.markdown ?? true,
  };
}

function normalizeAction(action: Partial<CrewStudioAction>, index: number): CrewStudioAction {
  return {
    id: action.id || uuid(),
    name: action.name?.trim() || `email_result_${index + 1}`,
    type: (action.type as CrewStudioActionType) || 'email',
    enabled: action.enabled ?? true,
    afterTaskId: action.afterTaskId || null,
    connectionId: action.connectionId || null,
    recipients: normalizeStringArray(action.recipients),
    subject: action.subject?.trim() || '',
    emailBodyMode: action.emailBodyMode === 'raw-html' ? 'raw-html' : 'clean',
    notes: action.notes?.trim() || '',
  };
}

function normalizeCrew(crew: Partial<CrewStudioCrew>): CrewStudioCrew {
  return {
    id: crew.id || uuid(),
    name: crew.name?.trim() || 'primary_crew',
    description: crew.description?.trim() || 'Coordinate the crew around a concrete business objective.',
    process: crew.process === 'hierarchical' ? 'hierarchical' : 'sequential',
    agentIds: normalizeStringArray(crew.agentIds),
    taskIds: normalizeStringArray(crew.taskIds),
    managerAgentId: crew.managerAgentId || null,
    memory: crew.memory ?? false,
    planning: crew.planning ?? true,
    verbose: crew.verbose ?? true,
    tags: normalizeStringArray(crew.tags),
  };
}

/**
 * Normalize one SubCrewInvocation. Defaults align with the design doc:
 *  - Missing id -> fresh uuid.
 *  - Missing name -> "Sub-crew invocation" placeholder.
 *  - Missing description -> empty string (the exporter will still emit
 *    something readable for the LLM).
 *  - targetCrewId trimmed; orphan refs (target not present in
 *    workspace.crews) are NOT dropped here — caller filters them out
 *    after the crews array is finalized so validation can report them.
 *  - maxInvocations clamped to 1..MAX_INVOCATIONS_PER_BOX, defaulting to
 *    SUBCREW_LIMITS.DEFAULT_INVOCATIONS when out of range / missing.
 *  - contextMode is always forced to 'isolated' in v1.
 */
export function normalizeSubCrewInvocation(
  invocation: Partial<SubCrewInvocation>
): SubCrewInvocation {
  const rawMax =
    typeof invocation.maxInvocations === 'number' &&
    Number.isFinite(invocation.maxInvocations)
      ? Math.floor(invocation.maxInvocations)
      : SUBCREW_LIMITS.DEFAULT_INVOCATIONS;
  const maxInvocations =
    rawMax < 1
      ? SUBCREW_LIMITS.DEFAULT_INVOCATIONS
      : rawMax > SUBCREW_LIMITS.MAX_INVOCATIONS_PER_BOX
        ? SUBCREW_LIMITS.MAX_INVOCATIONS_PER_BOX
        : rawMax;

  return {
    id: invocation.id || uuid(),
    name: invocation.name?.trim() || 'Sub-crew invocation',
    description: invocation.description?.trim() || '',
    targetCrewId: invocation.targetCrewId?.trim() || '',
    maxInvocations,
    inputMapping: invocation.inputMapping?.trim() || '',
    successCriteria:
      typeof invocation.successCriteria === 'string'
        ? invocation.successCriteria.trim() || null
        : null,
    // V1 only supports isolated; ignore any other value smuggled in.
    contextMode: 'isolated',
    tags: normalizeStringArray(invocation.tags),
  };
}

/**
 * Build a fast lookup for "which crew does each agent belong to?".
 *
 * The sub-crew dependency graph treats a crew as the unit that "calls"
 * another crew via any of its member agents' subCrewToolIds. This map
 * keeps the cycle-detection DFS at O(N) per traversal.
 */
function buildAgentToCrewMap(
  workspace: CrewStudioWorkspace
): Map<string, string> {
  const out = new Map<string, string>();
  for (const crew of workspace.crews) {
    for (const agentId of crew.agentIds) {
      // First crew that lists the agent wins; the same agent can
      // appear in multiple crews in pathological cases but cycle
      // detection still terminates because we visit each crew once.
      if (!out.has(agentId)) out.set(agentId, crew.id);
    }
  }
  return out;
}

/**
 * Filter `agent.subCrewToolIds` to exclude tool ids that:
 *   (a) don't reference a known SubCrewInvocation, or
 *   (b) would close a cycle in the crew-call graph.
 *
 * Same DFS shape as `filterAcyclicContextTaskIds`. The graph is:
 *   agent  ─belongs to→  crew_owner
 *   crew_owner  ─tool→  invocation.targetCrewId
 *   targetCrew ─members→ agents (each of which can have its own tools)
 *
 * We're asking: "If we add tool T (target crew C) to this agent,
 * could C reach back to the agent's owning crew?"
 *
 * Exposed so the picker UI (PR β) can call this directly with a
 * candidate list — but the normalizer also calls it on every save to
 * keep the on-disk shape free of cycles.
 */
export function filterAcyclicSubCrewToolIds(
  workspace: CrewStudioWorkspace,
  agentId: string,
  candidateToolIds: string[]
): string[] {
  if (!candidateToolIds.length) return [];

  // Look up which crew this agent belongs to (the "source" of the call).
  const agentToCrew = buildAgentToCrewMap(workspace);
  const sourceCrewId = agentToCrew.get(agentId);
  // If the agent isn't yet wired into any crew, no cycle is possible —
  // but we still drop danglers and dedupe.
  const invById = new Map(
    workspace.subCrewInvocations.map((i) => [i.id, i] as const)
  );
  const crewById = new Map(workspace.crews.map((c) => [c.id, c] as const));

  /**
   * Starting from crewId, can we reach sourceCrewId via the
   * existing-on-disk + the candidate edge? `extraEdge` is the
   * (sourceCrew → targetCrew) edge that the candidate tool would add.
   */
  const reachesSource = (
    startCrewId: string,
    extraEdge: { from: string; to: string } | null
  ): boolean => {
    if (!sourceCrewId) return false;
    const seen = new Set<string>();
    const stack: string[] = [startCrewId];
    while (stack.length) {
      const current = stack.pop() as string;
      if (current === sourceCrewId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const crew = crewById.get(current);
      if (!crew) continue;
      // Walk every tool on every member agent — this is the existing
      // edge set.
      for (const memberAgentId of crew.agentIds) {
        const memberAgent = workspace.agents.find(
          (a) => a.id === memberAgentId
        );
        if (!memberAgent) continue;
        for (const toolId of memberAgent.subCrewToolIds) {
          const inv = invById.get(toolId);
          if (inv && inv.targetCrewId) stack.push(inv.targetCrewId);
        }
      }
      // Apply the candidate edge if it originates from this crew.
      if (extraEdge && extraEdge.from === current) {
        stack.push(extraEdge.to);
      }
    }
    return false;
  };

  const seenIds = new Set<string>();
  const result: string[] = [];
  for (const candidateId of candidateToolIds) {
    if (seenIds.has(candidateId)) continue;
    seenIds.add(candidateId);
    const inv = invById.get(candidateId);
    if (!inv) continue; // dangling: drop
    if (!inv.targetCrewId) {
      // No target — harmless but useless. Keep it; validation will warn.
      result.push(candidateId);
      continue;
    }
    if (!sourceCrewId) {
      // Agent isn't in a crew yet; cycle impossible.
      result.push(candidateId);
      continue;
    }
    // The candidate edge is sourceCrew → inv.targetCrewId. Does the
    // resulting graph let us reach sourceCrew starting from
    // inv.targetCrewId? If yes, cycle; drop.
    if (
      reachesSource(inv.targetCrewId, {
        from: sourceCrewId,
        to: inv.targetCrewId,
      })
    ) {
      continue;
    }
    result.push(candidateId);
  }
  return result;
}

/**
 * Drop subCrewToolIds entries on every agent that:
 *   - don't reference a present invocation, or
 *   - would close a cycle.
 *
 * Called from normalizeCrewStudioWorkspace after both subCrewInvocations
 * and agents have been built so the cross-reference set is final.
 */
function pruneSubCrewToolIdsOnAgents(workspace: CrewStudioWorkspace): void {
  if (!workspace.subCrewInvocations.length) {
    // No invocations at all -> nothing valid to point at. Clear
    // every agent's list so a stale on-disk reference can't survive.
    for (const agent of workspace.agents) {
      agent.subCrewToolIds = [];
    }
    return;
  }
  for (const agent of workspace.agents) {
    if (!agent.subCrewToolIds.length) continue;
    agent.subCrewToolIds = filterAcyclicSubCrewToolIds(
      workspace,
      agent.id,
      agent.subCrewToolIds
    );
  }
}

export function normalizeCrewStudioWorkspace(
  workspace: Partial<CrewStudioWorkspace>
): CrewStudioWorkspace {
  const now = new Date().toISOString();
  const base: CrewStudioWorkspace = {
    id: workspace.id || uuid(),
    // Pre-auth rows have no ownerId on disk; surface them under the
    // sentinel '__legacy__' so owner-scoped queries can ignore them
    // without dropping the data.
    ownerId: workspace.ownerId || '__legacy__',
    repoPath: workspace.repoPath || null,
    name: workspace.name?.trim() || 'CrewAI Control Plane',
    description: workspace.description?.trim() || 'Local workspace for defining agents, tasks, crews, and Snowflake connectivity.',
    productBrief:
      workspace.productBrief?.trim() ||
      'Model the same control-plane primitives CrewAI emphasizes publicly: coordinated agents, production-ready crews, observability-minded workflows, and integrations that reach enterprise data. All LLM traffic is routed through Snowflake Cortex via LiteLLM — credentials stay inside Snowflake and there is no separate model vendor invoice.',
    defaultLlm: workspace.defaultLlm?.trim() || 'snowflake/claude-sonnet-4-6',
    tags: normalizeStringArray(workspace.tags),
    agents: [],
    tasks: [],
    actions: [],
    crews: [],
    connections: [],
    // Populated after crews so orphan invocations can be filtered out
    // against the finalized crew set.
    subCrewInvocations: [],
    canvasLayout: (workspace as CrewStudioWorkspace).canvasLayout || { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: workspace.createdAt || now,
    updatedAt: workspace.updatedAt || now,
    // Preserve fork provenance if present; null otherwise. Set by the
    // clone endpoint (POST /api/workspaces/[id]/clone) — never by the
    // client directly.
    forkedFromId: workspace.forkedFromId ?? null,
  };

  base.connections = Array.isArray(workspace.connections)
    ? workspace.connections.map((connection, index) => normalizeConnection(connection, index))
    : [];
  base.agents = Array.isArray(workspace.agents)
    ? workspace.agents.map((agent) => normalizeAgent(agent, base))
    : [];
  base.tasks = Array.isArray(workspace.tasks) ? workspace.tasks.map(normalizeTask) : [];
  base.actions = Array.isArray(workspace.actions)
    ? workspace.actions.map((action, index) => normalizeAction(action, index))
    : [];
  base.crews = Array.isArray(workspace.crews) ? workspace.crews.map(normalizeCrew) : [];

  // Populate subCrewInvocations AFTER crews are finalized so we can
  // drop invocations whose targetCrewId no longer references an
  // existing crew. Orphaned invocations on disk shouldn't crash
  // export — they're silently filtered here and surfaced as a
  // validation warning ('subcrew_orphaned') for the UI.
  const rawInvocations = Array.isArray(workspace.subCrewInvocations)
    ? workspace.subCrewInvocations.map(normalizeSubCrewInvocation)
    : [];
  const crewIds = new Set(base.crews.map((c) => c.id));
  base.subCrewInvocations = rawInvocations.filter(
    (inv) => inv.targetCrewId && crewIds.has(inv.targetCrewId)
  );

  // Drop dangling subCrewToolIds (point at an invocation we just
  // filtered) and cycle-creating tool refs.
  pruneSubCrewToolIdsOnAgents(base);

  return base;
}
