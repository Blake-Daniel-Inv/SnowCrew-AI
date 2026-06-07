// Node-kind classification and edge-wireability rules for the CrewStudio canvas.

import type { CrewStudioConnection, CrewStudioWorkspace } from '@/types';

/**
 * Canvas-edge wiring needs to know what kind of node a given id refers
 * to so it can decide which workspace field to mutate. The two pseudo-
 * nodes ('trigger' / 'output') are reserved string ids the canvas uses
 * for the workflow start/end markers.
 */
export type CrewStudioNodeKind =
  | 'agent'
  | 'task'
  | 'connection'
  | 'action'
  | 'crew'
  | 'subcrew'
  | 'trigger'
  | 'output';

export function findNodeKind(
  workspace: CrewStudioWorkspace,
  nodeId: string
): CrewStudioNodeKind | null {
  if (nodeId === 'trigger') return 'trigger';
  if (nodeId === 'output') return 'output';
  if (workspace.agents.some((a) => a.id === nodeId)) return 'agent';
  if (workspace.tasks.some((t) => t.id === nodeId)) return 'task';
  if (workspace.connections.some((c) => c.id === nodeId)) return 'connection';
  if (workspace.actions.some((a) => a.id === nodeId)) return 'action';
  if (workspace.crews.some((c) => c.id === nodeId)) return 'crew';
  // PR 21: sub-crew invocations live in workspace.subCrewInvocations.
  // The canvas prefixes their node ids with 'subcrew-' to avoid
  // collisions, but we also accept a bare id so call-sites that
  // hold the raw invocation id (e.g. validation issue targets) can
  // route through the same predicate.
  if (
    nodeId.startsWith('subcrew-') &&
    workspace.subCrewInvocations.some(
      (i) => `subcrew-${i.id}` === nodeId
    )
  ) {
    return 'subcrew';
  }
  if (workspace.subCrewInvocations.some((i) => i.id === nodeId))
    return 'subcrew';
  return null;
}

/**
 * Pairs that are wireable by drawing an edge on the canvas. Order is
 * (source, target). Anything not in this set should fail validation and
 * show a no-drop cursor before it ever reaches the data layer.
 */
const VALID_EDGE_PAIRS: ReadonlyArray<readonly [CrewStudioNodeKind, CrewStudioNodeKind]> = [
  ['agent', 'task'],
  ['task', 'task'],
  ['task', 'action'],
  ['connection', 'agent'],
  ['connection', 'action'],
];

export function isWireableEdge(
  workspace: CrewStudioWorkspace,
  source: string | null | undefined,
  target: string | null | undefined
): boolean {
  if (!source || !target || source === target) return false;
  const sk = findNodeKind(workspace, source);
  const tk = findNodeKind(workspace, target);
  if (!sk || !tk) return false;
  return VALID_EDGE_PAIRS.some(([s, t]) => s === sk && t === tk);
}

export function isCrewStudioConnectionReady(connection: CrewStudioConnection): boolean {
  if (!connection.enabled) return false;
  return Boolean(
    connection.account && connection.user && connection.passwordEnvVar
  );
}
