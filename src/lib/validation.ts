import type {
  CrewStudioWorkspace,
  ValidationIssue,
} from '@/types';
import { isCrewStudioConnectionReady } from './crew-studio';


function pushIssue(
  issues: ValidationIssue[],
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  target?: ValidationIssue['target']
) {
  issues.push({
    id: `${code}-${target?.kind || 'workspace'}-${target?.id || 'n/a'}-${issues.length}`,
    severity,
    code,
    message,
    target,
  });
}

/** Detect cycles in task context dependencies via DFS. */
function detectTaskCycles(
  workspace: CrewStudioWorkspace,
  issues: ValidationIssue[]
) {
  const taskMap = new Map(workspace.tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'white' | 'gray' | 'black'>();
  workspace.tasks.forEach((t) => state.set(t.id, 'white'));

  function visit(taskId: string, path: string[]): boolean {
    const current = state.get(taskId);
    if (current === 'gray') {
      const cycleStart = path.indexOf(taskId);
      const names = path
        .slice(cycleStart)
        .concat(taskId)
        .map((id) => taskMap.get(id)?.name || id)
        .join(' → ');
      pushIssue(
        issues,
        'error',
        'task-context-cycle',
        `Circular context dependency: ${names}`,
        { kind: 'task', id: taskId }
      );
      return true;
    }
    if (current === 'black') return false;

    state.set(taskId, 'gray');
    const task = taskMap.get(taskId);
    if (task) {
      for (const dep of task.contextTaskIds) {
        if (visit(dep, [...path, taskId])) {
          break;
        }
      }
    }
    state.set(taskId, 'black');
    return false;
  }

  workspace.tasks.forEach((t) => {
    if (state.get(t.id) === 'white') visit(t.id, []);
  });
}

export function validateWorkspace(
  workspace: CrewStudioWorkspace
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const tasksByAgent = new Map<string, number>();
  workspace.tasks.forEach((task) => {
    if (task.agentId) {
      tasksByAgent.set(task.agentId, (tasksByAgent.get(task.agentId) || 0) + 1);
    }
  });

  // ----- Agents -----
  for (const agent of workspace.agents) {
    if (!agent.name.trim()) {
      pushIssue(issues, 'error', 'agent-no-name', 'Agent has no name', { kind: 'agent', id: agent.id });
    }
    if (!agent.goal.trim()) {
      pushIssue(issues, 'warning', 'agent-no-goal', `Agent "${agent.name}" has no goal`, { kind: 'agent', id: agent.id });
    }
    if (!agent.llm.trim()) {
      pushIssue(issues, 'error', 'agent-no-llm', `Agent "${agent.name}" has no LLM selected`, { kind: 'agent', id: agent.id });
    }
    if (['snowflake/claude-4-opus', 'snowflake/claude-3-7-sonnet', 'snowflake/claude-3-5-sonnet'].includes(agent.llm.trim())) {
      pushIssue(
        issues,
        'warning',
        'agent-legacy-cortex-model',
        `Agent "${agent.name}" uses an older Cortex model ID. Runs map legacy Opus to Claude Opus 4.7 and deprecated Sonnet IDs to Claude Sonnet 4.6.`,
        { kind: 'agent', id: agent.id }
      );
    }
    if (!tasksByAgent.has(agent.id)) {
      pushIssue(issues, 'info', 'agent-unused', `Agent "${agent.name}" is not assigned to any task`, { kind: 'agent', id: agent.id });
    }
    // Check referenced connections exist and are enabled
    for (const connId of agent.connectionIds) {
      const conn = workspace.connections.find((c) => c.id === connId);
      if (!conn) {
        pushIssue(issues, 'error', 'agent-bad-conn-ref', `Agent "${agent.name}" references a missing connection`, { kind: 'agent', id: agent.id });
      } else if (!conn.enabled) {
        pushIssue(issues, 'warning', 'agent-disabled-conn', `Agent "${agent.name}" uses disabled connection "${conn.name}"`, { kind: 'agent', id: agent.id });
      } else if (!isCrewStudioConnectionReady(conn)) {
        pushIssue(issues, 'warning', 'agent-unready-conn', `Agent "${agent.name}" uses connection "${conn.name}" which needs setup`, { kind: 'agent', id: agent.id });
      }
    }
  }

  // ----- Tasks -----
  for (const task of workspace.tasks) {
    if (!task.name.trim()) {
      pushIssue(issues, 'error', 'task-no-name', 'Task has no name', { kind: 'task', id: task.id });
    }
    if (!task.description.trim()) {
      pushIssue(issues, 'warning', 'task-no-desc', `Task "${task.name}" has no description`, { kind: 'task', id: task.id });
    }
    if (!task.agentId) {
      pushIssue(issues, 'error', 'task-unassigned', `Task "${task.name}" has no agent assigned`, { kind: 'task', id: task.id });
    } else if (!workspace.agents.some((a) => a.id === task.agentId)) {
      pushIssue(issues, 'error', 'task-bad-agent', `Task "${task.name}" references a missing agent`, { kind: 'task', id: task.id });
    }
    for (const ctxId of task.contextTaskIds) {
      if (!workspace.tasks.some((t) => t.id === ctxId)) {
        pushIssue(issues, 'error', 'task-bad-context', `Task "${task.name}" references a missing context task`, { kind: 'task', id: task.id });
      }
    }
    if (task.humanInput) {
      pushIssue(
        issues,
        'info',
        'task-human-input-studio-disabled',
        `Task "${task.name}" has human feedback enabled; Studio runs disable terminal prompts by default. Set CREWAI_STUDIO_ALLOW_HUMAN_INPUT=true for exported CLI runs.`,
        { kind: 'task', id: task.id }
      );
    }
  }

  detectTaskCycles(workspace, issues);

  // ----- Crews -----
  if (workspace.crews.length === 0) {
    pushIssue(issues, 'warning', 'no-crew', 'No crew defined yet');
  }
  for (const crew of workspace.crews) {
    if (crew.taskIds.length === 0) {
      pushIssue(issues, 'warning', 'crew-no-tasks', `Crew "${crew.name}" has no tasks`, { kind: 'crew', id: crew.id });
    }
    if (crew.agentIds.length === 0) {
      pushIssue(issues, 'warning', 'crew-no-agents', `Crew "${crew.name}" has no agents`, { kind: 'crew', id: crew.id });
    }
    if (crew.process === 'hierarchical' && !crew.managerAgentId) {
      pushIssue(issues, 'error', 'crew-no-manager', `Hierarchical crew "${crew.name}" needs a manager agent`, { kind: 'crew', id: crew.id });
    }
    if (crew.memory) {
      pushIssue(
        issues,
        'info',
        'crew-memory-snowflake-export-disabled',
        `Crew "${crew.name}" has memory enabled in Studio, but generated Snowflake-only runs disable CrewAI memory because the default embedder requires OpenAI credentials.`,
        { kind: 'crew', id: crew.id }
      );
    }
    // Every task the crew references should exist
    for (const tid of crew.taskIds) {
      if (!workspace.tasks.some((t) => t.id === tid)) {
        pushIssue(issues, 'error', 'crew-bad-task', `Crew "${crew.name}" references a missing task`, { kind: 'crew', id: crew.id });
      }
    }
    // Every agent assigned to the crew's tasks should be in the crew
    const taskAgentIds = new Set(
      crew.taskIds
        .map((tid) => workspace.tasks.find((t) => t.id === tid)?.agentId)
        .filter(Boolean) as string[]
    );
    for (const aid of taskAgentIds) {
      if (!crew.agentIds.includes(aid)) {
        const agent = workspace.agents.find((a) => a.id === aid);
        pushIssue(
          issues,
          'warning',
          'crew-missing-agent',
          `Crew "${crew.name}" has a task assigned to "${agent?.name || aid}" but that agent is not in the crew`,
          { kind: 'crew', id: crew.id }
        );
      }
    }
  }

  // ----- Connections -----
  for (const conn of workspace.connections) {
    if (!conn.enabled) continue;
    if (!isCrewStudioConnectionReady(conn)) {
      pushIssue(issues, 'warning', 'conn-not-ready', `Connection "${conn.name}" needs setup`, { kind: 'connection', id: conn.id });
    }
  }

  // ----- Actions -----
  for (const action of workspace.actions) {
    if (!action.enabled || action.type !== 'email') continue;

    const connection =
      workspace.connections.find((conn) => conn.id === action.connectionId && conn.enabled && conn.mode === 'snowflake-api') ||
      workspace.connections.find((conn) => conn.enabled && conn.mode === 'snowflake-api' && conn.isDefault) ||
      workspace.connections.find((conn) => conn.enabled && conn.mode === 'snowflake-api');

    if (!connection) {
      pushIssue(
        issues,
        'error',
        'email-action-no-connection',
        `Email action "${action.name}" needs an enabled Snowflake API connection`,
        { kind: 'action', id: action.id }
      );
      continue;
    }

    if (!connection.emailNotificationIntegration.trim()) {
      pushIssue(
        issues,
        'warning',
        'email-action-no-integration',
        `Email action "${action.name}" has no Snowflake email integration configured on "${connection.name}"`,
        { kind: 'action', id: action.id }
      );
    }

    if (action.recipients.length === 0 && connection.emailDefaultRecipients.length === 0) {
      pushIssue(
        issues,
        'warning',
        'email-action-no-recipients',
        `Email action "${action.name}" has no recipients configured`,
        { kind: 'action', id: action.id }
      );
    }
  }

  // ----- Sub-crew invocations (PR 20) -----
  detectSubCrewCycles(workspace, issues);
  for (const inv of workspace.subCrewInvocations) {
    if (
      inv.targetCrewId &&
      !workspace.crews.some((c) => c.id === inv.targetCrewId)
    ) {
      pushIssue(
        issues,
        'warning',
        'subcrew_orphaned',
        `Sub-crew invocation "${inv.name}" targets a missing crew (id "${inv.targetCrewId}").`,
        { kind: 'crew', id: inv.targetCrewId }
      );
    } else if (!inv.targetCrewId) {
      pushIssue(
        issues,
        'warning',
        'subcrew_orphaned',
        `Sub-crew invocation "${inv.name}" has no target crew configured.`
      );
    }
  }
  // Dangling agent.subCrewToolIds — point at an invocation no longer present
  // on the workspace. Surfaces as a warning so the user knows the click-to-edit
  // target is stale, but doesn't block save (the normalizer drops the ref).
  const invocationIds = new Set(
    workspace.subCrewInvocations.map((inv) => inv.id)
  );
  for (const agent of workspace.agents) {
    for (const toolId of agent.subCrewToolIds) {
      if (invocationIds.has(toolId)) continue;
      pushIssue(
        issues,
        'warning',
        'subcrew_dangling_ref',
        `Agent "${agent.name}" references sub-crew tool "${toolId}" which no longer exists.`,
        { kind: 'agent', id: agent.id }
      );
    }
  }

  // Sort: errors first, then warnings, then info
  const rank = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return issues;
}

/**
 * Detect cycles in the sub-crew call graph via three-color DFS over
 * crew nodes. An edge exists from sourceCrew → targetCrew when ANY
 * member agent of sourceCrew has a `subCrewToolIds` entry whose
 * invocation has `targetCrewId === targetCrew.id`. Self-loops are
 * also caught (a crew whose member's tool kicks off the same crew).
 *
 * Mirrors detectTaskCycles in shape but operates on a different graph.
 */
function detectSubCrewCycles(
  workspace: CrewStudioWorkspace,
  issues: ValidationIssue[]
) {
  if (!workspace.subCrewInvocations.length) return;
  const invById = new Map(
    workspace.subCrewInvocations.map((i) => [i.id, i] as const)
  );
  const crewById = new Map(workspace.crews.map((c) => [c.id, c] as const));

  // For each crew, the set of crews it can reach in one hop.
  const adjacency = new Map<string, Set<string>>();
  for (const crew of workspace.crews) {
    const targets = new Set<string>();
    for (const memberAgentId of crew.agentIds) {
      const agent = workspace.agents.find((a) => a.id === memberAgentId);
      if (!agent) continue;
      for (const toolId of agent.subCrewToolIds) {
        const inv = invById.get(toolId);
        if (!inv || !inv.targetCrewId) continue;
        if (!crewById.has(inv.targetCrewId)) continue;
        targets.add(inv.targetCrewId);
      }
    }
    adjacency.set(crew.id, targets);
  }

  const state = new Map<string, 'white' | 'gray' | 'black'>();
  workspace.crews.forEach((c) => state.set(c.id, 'white'));

  function visit(crewId: string, path: string[]): boolean {
    const current = state.get(crewId);
    if (current === 'gray') {
      const cycleStart = path.indexOf(crewId);
      const names = path
        .slice(cycleStart)
        .concat(crewId)
        .map((id) => crewById.get(id)?.name || id)
        .join(' → ');
      pushIssue(
        issues,
        'error',
        'subcrew_cycle',
        `Circular sub-crew invocation: ${names}`,
        { kind: 'crew', id: crewId }
      );
      return true;
    }
    if (current === 'black') return false;
    state.set(crewId, 'gray');
    const neighbors = adjacency.get(crewId) || new Set();
    for (const next of neighbors) {
      if (visit(next, [...path, crewId])) {
        // Continue scanning siblings so multiple cycles surface as
        // separate issues — mirrors detectTaskCycles' behavior.
      }
    }
    state.set(crewId, 'black');
    return false;
  }

  workspace.crews.forEach((c) => {
    if (state.get(c.id) === 'white') visit(c.id, []);
  });
}
