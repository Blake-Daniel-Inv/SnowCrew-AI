// PR 23 — Canvas crew-scoped filtering.
//
// Why this exists:
//   The Coordinator template (PR 21) introduced multi-crew workspaces. The
//   canvas previously rendered EVERY agent/task/connection/action in
//   `workspace.tasks`, so a Coordinator's "parent" crew canvas was polluted
//   with sub-crew tasks that had no workflow edges into the lead crew (their
//   edges live on the *other* crews). That looks broken to demo viewers.
//
// What this does:
//   `scopeWorkspaceToCrew(workspace, crewId)` returns a filtered view of the
//   workspace entities the canvas should render for a given crew. Pure: the
//   input workspace is never mutated, and the returned arrays are fresh
//   `.filter(...)` results (no aliasing into workspace internals).
//
// Fallback semantics (intentional):
//   - `crewId === null` → return EVERYTHING (current pre-PR-23 behavior).
//   - `crewId` doesn't match a crew → also return EVERYTHING.
//   Either case implies "we don't have a confident active-crew anchor"; we
//   prefer "show too much" over "blank the canvas" because the latter looks
//   like data loss to a user who just deleted a crew. The caller can detect
//   the fallback if it wants by checking `workspace.crews.some(c => c.id ===
//   crewId)` before calling.
//
// Out of scope:
//   - Edge construction lives in WorkflowCanvas. This module deals only with
//     the node-input subset.
//   - We do NOT delete entities from disk; the workspace store is
//     authoritative. This is a render-time filter, nothing more.

import type {
  CrewStudioAction,
  CrewStudioAgent,
  CrewStudioConnection,
  CrewStudioTask,
  CrewStudioWorkspace,
  SubCrewInvocation,
} from '@/types';

export interface ScopedWorkspaceEntities {
  agents: CrewStudioAgent[];
  tasks: CrewStudioTask[];
  connections: CrewStudioConnection[];
  actions: CrewStudioAction[];
  subCrewInvocations: SubCrewInvocation[];
}

/**
 * Filter the workspace's render-time entity arrays to the subset that
 * belongs on the canvas for the given active crew. See module docstring
 * for the fallback semantics when `crewId` is null or unknown.
 *
 * NOTE: trigger / output nodes are NOT in the returned set — they're
 * always rendered by the canvas itself.
 */
export function scopeWorkspaceToCrew(
  workspace: CrewStudioWorkspace,
  crewId: string | null,
): ScopedWorkspaceEntities {
  // Fallback: no crew context → return everything.
  const activeCrew = crewId
    ? workspace.crews.find((c) => c.id === crewId) ?? null
    : null;
  if (!activeCrew) {
    return {
      agents: [...workspace.agents],
      tasks: [...workspace.tasks],
      connections: [...workspace.connections],
      actions: [...workspace.actions],
      subCrewInvocations: [...workspace.subCrewInvocations],
    };
  }

  // Lookup sets — Set membership keeps each filter O(n) over its entity.
  const agentIdSet = new Set(activeCrew.agentIds);
  const taskIdSet = new Set(activeCrew.taskIds);

  const agents = workspace.agents.filter((a) => agentIdSet.has(a.id));

  const tasks = workspace.tasks.filter((t) => taskIdSet.has(t.id));

  // Sub-crew invocations: any invocation referenced by ANY agent in this
  // crew via the agent's `subCrewToolIds`. We don't filter by target crew
  // membership — the invocation belongs to the calling crew.
  const referencedSubCrewIds = new Set<string>();
  for (const agent of agents) {
    for (const invId of agent.subCrewToolIds) {
      referencedSubCrewIds.add(invId);
    }
  }
  const subCrewInvocations = workspace.subCrewInvocations.filter((inv) =>
    referencedSubCrewIds.has(inv.id),
  );

  // Connections: any connection referenced by an agent in this crew via
  // `agent.connectionIds`. A connection unused by this crew's agents is
  // hidden, matching the rendering rule "only show what's wired in".
  const referencedConnectionIds = new Set<string>();
  for (const agent of agents) {
    for (const connId of agent.connectionIds) {
      referencedConnectionIds.add(connId);
    }
  }
  const connections = workspace.connections.filter((c) =>
    referencedConnectionIds.has(c.id),
  );

  // Actions: any action whose `afterTaskId` resolves to a task in this
  // crew's task list. Actions with a null `afterTaskId` (unassigned) are
  // hidden from a scoped view — the canvas has no anchor for them in this
  // crew. They reappear in the fallback / single-crew view.
  const actions = workspace.actions.filter(
    (a) => a.afterTaskId !== null && taskIdSet.has(a.afterTaskId),
  );

  return {
    agents,
    tasks,
    connections,
    actions,
    subCrewInvocations,
  };
}
