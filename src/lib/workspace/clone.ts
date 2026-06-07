// Deep-clone a workspace, minting fresh UUIDs for every entity and
// rewiring all cross-references through an old→new id map. Used by the
// "Duplicate workspace" feature (POST /api/workspaces/[id]/clone).
//
// Invariants the implementation must preserve:
//   1. Every entity id is freshly minted via crypto.randomUUID() — no
//      object aliasing the source workspace's entities.
//   2. Cross-references (agent.connectionIds, task.agentId,
//      task.contextTaskIds, action.afterTaskId, action.connectionId,
//      crew.agentIds, crew.taskIds, crew.managerAgentId,
//      canvasLayout.nodes keys) resolve to the new ids.
//   3. References that point at an id not in the mapping (e.g. a stale
//      pointer to a deleted entity) are dropped to null/excluded — we
//      do NOT preserve dangling references.
//   4. The result is normalized via normalizeCrewStudioWorkspace before
//      return so structural constraints (acyclic context, env-var
//      regex, etc.) are re-enforced.
//   5. forkedFromId records provenance (source workspace id) so a future
//      UI can show "X was forked from Y".

import type {
  CrewStudioAction,
  CrewStudioAgent,
  CrewStudioConnection,
  CrewStudioCrew,
  CrewStudioTask,
  CrewStudioWorkspace,
  CanvasLayout,
  SubCrewInvocation,
} from '@/types';
import { normalizeCrewStudioWorkspace } from './normalize';

export interface CloneWorkspaceOptions {
  /** Owner id for the cloned workspace. Defaults to source.ownerId. */
  newOwnerId?: string;
  /** Name for the cloned workspace. Defaults to `${source.name} (copy)`. */
  newName?: string;
}

/**
 * Map an optional id through the dictionary. If the id is null or not
 * present in the map (a dangling reference in the source), returns null.
 * This is intentionally permissive: we never want to leak a stale id
 * from the source into the clone.
 */
function mapOptionalId(
  id: string | null | undefined,
  idMap: Map<string, string>
): string | null {
  if (!id) return null;
  return idMap.get(id) ?? null;
}

/**
 * Map every id in `ids` through the dictionary, dropping any that have
 * no mapping. Mirrors mapOptionalId's "drop danglers" stance for arrays.
 */
function mapIdArray(ids: string[], idMap: Map<string, string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const mapped = idMap.get(id);
    if (mapped) out.push(mapped);
  }
  return out;
}

/**
 * Deep-clone a workspace, minting new UUIDs everywhere and rewiring
 * every cross-reference. The result is normalized before return.
 */
export function cloneWorkspace(
  source: CrewStudioWorkspace,
  opts: CloneWorkspaceOptions = {}
): CrewStudioWorkspace {
  // --- Phase 1: build the id-mapping dictionary. -----------------
  // We mint new ids for every entity up-front so cross-references can
  // be resolved in a single pass below.
  const idMap = new Map<string, string>();
  for (const c of source.connections) idMap.set(c.id, crypto.randomUUID());
  for (const a of source.agents) idMap.set(a.id, crypto.randomUUID());
  for (const t of source.tasks) idMap.set(t.id, crypto.randomUUID());
  for (const a of source.actions) idMap.set(a.id, crypto.randomUUID());
  for (const c of source.crews) idMap.set(c.id, crypto.randomUUID());
  for (const i of source.subCrewInvocations ?? []) idMap.set(i.id, crypto.randomUUID());

  const newWorkspaceId = crypto.randomUUID();

  // --- Phase 2: rebuild every entity with the new id + rewired refs. -
  const connections: CrewStudioConnection[] = source.connections.map((c) => ({
    ...c,
    id: idMap.get(c.id) as string,
  }));

  const agents: CrewStudioAgent[] = source.agents.map((a) => ({
    ...a,
    id: idMap.get(a.id) as string,
    connectionIds: mapIdArray(a.connectionIds, idMap),
    // Defensive copies for arrays we don't rewire but mustn't alias.
    tools: [...a.tools],
    knowledge: [...a.knowledge],
    tags: [...a.tags],
    // Sub-crew tool ids (PR 20) — defensive copy; rewired below once the
    // invocations idMap entries are minted alongside the workspace
    // assembly. Default to [] for pre-PR-20 workspaces on disk that
    // omit the field entirely.
    subCrewToolIds: [...(a.subCrewToolIds ?? [])],
  }));

  const tasks: CrewStudioTask[] = source.tasks.map((t) => ({
    ...t,
    id: idMap.get(t.id) as string,
    agentId: mapOptionalId(t.agentId, idMap),
    contextTaskIds: mapIdArray(t.contextTaskIds, idMap),
  }));

  const actions: CrewStudioAction[] = source.actions.map((a) => ({
    ...a,
    id: idMap.get(a.id) as string,
    afterTaskId: mapOptionalId(a.afterTaskId, idMap),
    connectionId: mapOptionalId(a.connectionId, idMap),
    recipients: [...a.recipients],
  }));

  const crews: CrewStudioCrew[] = source.crews.map((c) => ({
    ...c,
    id: idMap.get(c.id) as string,
    agentIds: mapIdArray(c.agentIds, idMap),
    taskIds: mapIdArray(c.taskIds, idMap),
    managerAgentId: mapOptionalId(c.managerAgentId, idMap),
    tags: [...c.tags],
  }));

  // Sub-crew invocations: rewire targetCrewId through the same idMap.
  // Orphan refs (target crew already missing in source) flatten to ''
  // and are dropped by normalizeCrewStudioWorkspace.
  const subCrewInvocations: SubCrewInvocation[] = (source.subCrewInvocations ?? []).map(
    (inv) => ({
      ...inv,
      id: idMap.get(inv.id) as string,
      targetCrewId: idMap.get(inv.targetCrewId) ?? '',
      tags: [...inv.tags],
    })
  );

  // Now that invocation ids are minted, rewire each agent's
  // subCrewToolIds. mapIdArray drops references that don't resolve.
  for (const a of agents) {
    a.subCrewToolIds = mapIdArray(a.subCrewToolIds, idMap);
  }

  // Canvas layout: nodes is keyed by entity id. We rebuild it with new
  // keys preserving positions. Keys that aren't in the id map are
  // preserved verbatim because they may be sentinel keys ('trigger',
  // 'output') the templates emit for input/output anchors.
  const layoutNodes: Record<string, { x: number; y: number }> = {};
  for (const [key, pos] of Object.entries(source.canvasLayout?.nodes ?? {})) {
    const mapped = idMap.get(key);
    const nextKey = mapped ?? key;
    layoutNodes[nextKey] = { x: pos.x, y: pos.y };
  }
  const canvasLayout: CanvasLayout = {
    nodes: layoutNodes,
    zoom: source.canvasLayout?.zoom ?? 1,
    panX: source.canvasLayout?.panX ?? 0,
    panY: source.canvasLayout?.panY ?? 0,
  };

  const now = new Date().toISOString();

  // --- Phase 3: assemble + normalize. ----------------------------
  // The normalize step re-enforces structural constraints (acyclic
  // task context, env-var regex on connections, etc.) on the clone.
  // Never return a workspace that hasn't been normalized — the store
  // assumes valid shape.
  const cloned: CrewStudioWorkspace = {
    id: newWorkspaceId,
    ownerId: opts.newOwnerId ?? source.ownerId,
    repoPath: source.repoPath ?? null,
    name: opts.newName ?? `${source.name} (copy)`,
    description: source.description,
    productBrief: source.productBrief,
    defaultLlm: source.defaultLlm,
    tags: [...source.tags],
    agents,
    tasks,
    actions,
    crews,
    connections,
    subCrewInvocations,
    canvasLayout,
    createdAt: now,
    updatedAt: now,
    forkedFromId: source.id,
  };

  // Normalize fills in any missing fields, clamps invalid values, and
  // drops cycles in task contexts that survived the rewrite.
  const normalized = normalizeCrewStudioWorkspace(cloned);

  // normalize stamps a fresh updatedAt; we want to preserve our own
  // createdAt/forkedFromId stamping so the caller sees the values they
  // asked for. Re-apply over the normalized result.
  return {
    ...normalized,
    id: cloned.id,
    ownerId: cloned.ownerId,
    name: cloned.name,
    createdAt: cloned.createdAt,
    updatedAt: cloned.updatedAt,
    forkedFromId: cloned.forkedFromId,
  };
}
