// Cycle-preview helper for the task context-picker UI.
//
// `filterAcyclicContextTaskIds` (in normalize.ts) silently drops any
// context-id that would close a cycle. That's the right behavior at
// save time (we don't want a malformed YAML to crash a run) but it
// hides the problem from the user. This module exposes the same DFS
// shaped to answer a different question for the UI:
//
//   "If the user adds candidateId to task.contextTaskIds, what
//    cycle path does that produce — and what tasks are on it?"
//
// The save path keeps using `filterAcyclicContextTaskIds` as the
// authoritative dropper; this preview is informational only.

import type {
  CrewStudioTask,
  CrewStudioWorkspace,
} from '@/types';

export type CyclePreview =
  | { wouldCycle: false }
  | { wouldCycle: true; cyclePath: string[] };

/**
 * Determine whether adding `candidateContextId` to `taskId`'s context
 * list would create a cycle, and if so return the path of task ids
 * that closes the loop (starting and ending at `taskId`).
 *
 * The candidate need not already be in the task's contextTaskIds.
 * We're asking: "If I added it, would the resulting graph cycle?"
 *
 * Returns `wouldCycle: false` when:
 *   - the candidate id doesn't exist in the workspace (the save path
 *     would also drop it — see filterAcyclicContextTaskIds — so we
 *     don't show a misleading cycle warning), or
 *   - the candidate is not self and has no path back to taskId.
 *
 * Returns `wouldCycle: true` with `cyclePath` set when:
 *   - candidate === taskId (the trivial self-loop), or
 *   - some path from candidate leads back to taskId.
 */
export function wouldCreateCycle(
  workspace: CrewStudioWorkspace,
  taskId: string,
  candidateContextId: string
): CyclePreview {
  // Self-reference: shortest possible cycle, path is just [taskId].
  if (candidateContextId === taskId) {
    return { wouldCycle: true, cyclePath: [taskId] };
  }

  const tasksById = new Map<string, CrewStudioTask>();
  for (const t of workspace.tasks) {
    tasksById.set(t.id, t);
  }

  // If the candidate isn't in the workspace, the save-time normalizer
  // would drop it anyway and no cycle can form. Don't fire a warning.
  if (!tasksById.has(candidateContextId)) {
    return { wouldCycle: false };
  }

  // DFS from the candidate looking for a path back to taskId. Track
  // the parent of each visited node so we can reconstruct the path
  // when the target is reached.
  const parents = new Map<string, string | null>();
  parents.set(candidateContextId, null);
  const stack: string[] = [candidateContextId];
  const visited = new Set<string>();

  while (stack.length) {
    const current = stack.pop() as string;
    if (current === taskId) {
      // Reconstruct candidate → ... → taskId. The cycle the user is
      // about to introduce is taskId → candidate → ... → taskId, so
      // prepend taskId for a complete loop description.
      const reverse: string[] = [];
      let cursor: string | null = current;
      while (cursor !== null) {
        reverse.push(cursor);
        cursor = parents.get(cursor) ?? null;
      }
      const fromCandidate = reverse.reverse();
      return {
        wouldCycle: true,
        cyclePath: [taskId, ...fromCandidate],
      };
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const node = tasksById.get(current);
    if (!node) continue;
    for (const next of node.contextTaskIds) {
      if (!parents.has(next)) parents.set(next, current);
      stack.push(next);
    }
  }

  return { wouldCycle: false };
}

/**
 * Resolve cycle path ids into a human-readable arrow-joined string
 * using task names where available. Mirrors the format used by
 * `validateWorkspace`'s task-context-cycle issue so users see the
 * same vocabulary in the picker hint and the save-time toast.
 */
export function formatCyclePath(
  workspace: CrewStudioWorkspace,
  cyclePath: string[]
): string {
  const byId = new Map(workspace.tasks.map((t) => [t.id, t.name] as const));
  return cyclePath.map((id) => byId.get(id) || id).join(' → ');
}

// ============================================================
// Sub-crew cycle preview (PR 20)
// ============================================================
// Mirrors `wouldCreateCycle` for task contexts but answers a
// different question:
//
//   "If we add invocation I (targetCrew T) to agent A's tool list,
//    does the resulting crew-call graph form a cycle?"
//
// This is the helper PR β's NodeConfigPanel will call when the user
// hovers over a sub-crew tool option in the picker. It's a strict
// preview — shipping the helper now lets PR β render the warning UI
// against a stable contract.

export type SubCrewCyclePreview =
  | { wouldCycle: false }
  | { wouldCycle: true; cyclePath: string[] };

/**
 * Determine whether adding invocation `candidateInvocationId` to the
 * agent identified by `agentId` would create a cycle in the sub-crew
 * call graph. The graph nodes are crews; an edge exists when any
 * member agent of crew S has a subCrewToolIds entry whose target is
 * crew T. The hypothetical edge added by this preview is
 * (sourceCrew(agentId)) → (targetCrew(candidateInvocationId)).
 *
 * Returns `wouldCycle: true` with `cyclePath` (a list of crew ids
 * starting and ending at the source crew) when the addition closes
 * a loop; `wouldCycle: false` otherwise. Mirrors the contract of
 * `wouldCreateCycle` for the task-context-picker UI.
 *
 * Edge cases:
 *   - candidate id not in workspace.subCrewInvocations → no cycle
 *     (the save path drops the ref anyway).
 *   - target crew not in workspace.crews → no cycle.
 *   - agent not in any crew → no cycle (no source node).
 */
export function wouldCreateSubCrewCycle(
  workspace: CrewStudioWorkspace,
  agentId: string,
  candidateInvocationId: string
): SubCrewCyclePreview {
  const inv = workspace.subCrewInvocations.find(
    (i) => i.id === candidateInvocationId
  );
  if (!inv) return { wouldCycle: false };
  if (!inv.targetCrewId) return { wouldCycle: false };

  // Find the source crew this agent participates in.
  const sourceCrew = workspace.crews.find((c) =>
    c.agentIds.includes(agentId)
  );
  if (!sourceCrew) return { wouldCycle: false };

  // Self-loop: source crew is the same as the target. Always a cycle.
  if (sourceCrew.id === inv.targetCrewId) {
    return { wouldCycle: true, cyclePath: [sourceCrew.id, sourceCrew.id] };
  }

  // BFS from targetCrew looking for sourceCrew. Track parents so the
  // returned cyclePath can be reconstructed in user-facing order
  // (sourceCrew → targetCrew → ... → sourceCrew).
  const invById = new Map(
    workspace.subCrewInvocations.map((i) => [i.id, i] as const)
  );
  const crewById = new Map(workspace.crews.map((c) => [c.id, c] as const));
  const parents = new Map<string, string | null>();
  parents.set(inv.targetCrewId, null);
  const queue: string[] = [inv.targetCrewId];
  const visited = new Set<string>();

  while (queue.length) {
    const current = queue.shift() as string;
    if (current === sourceCrew.id) {
      // Reconstruct path target → ... → source.
      const reverse: string[] = [];
      let cursor: string | null = current;
      while (cursor !== null) {
        reverse.push(cursor);
        cursor = parents.get(cursor) ?? null;
      }
      const fromTarget = reverse.reverse();
      return {
        wouldCycle: true,
        // Final cycle path: source → target → ... → source.
        cyclePath: [sourceCrew.id, ...fromTarget],
      };
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const crew = crewById.get(current);
    if (!crew) continue;
    for (const memberAgentId of crew.agentIds) {
      const memberAgent = workspace.agents.find((a) => a.id === memberAgentId);
      if (!memberAgent) continue;
      for (const toolId of memberAgent.subCrewToolIds) {
        const memberInv = invById.get(toolId);
        if (!memberInv || !memberInv.targetCrewId) continue;
        if (!parents.has(memberInv.targetCrewId)) {
          parents.set(memberInv.targetCrewId, current);
        }
        queue.push(memberInv.targetCrewId);
      }
    }
  }

  return { wouldCycle: false };
}

/**
 * Format a sub-crew cycle path using crew names where available. Same
 * arrow-separator convention as `formatCyclePath` for tasks.
 */
export function formatSubCrewCyclePath(
  workspace: CrewStudioWorkspace,
  cyclePath: string[]
): string {
  const byId = new Map(workspace.crews.map((c) => [c.id, c.name] as const));
  return cyclePath.map((id) => byId.get(id) || id).join(' → ');
}

