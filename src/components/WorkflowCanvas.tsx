'use client';

import { useCallback, useEffect, useMemo, useRef, type DragEvent } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type IsValidConnection,
  type Node,
  type OnNodesChange,
  type OnEdgesChange,
  BackgroundVariant,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { isCrewStudioConnectionReady, isWireableEdge } from '@/lib/crew-studio';
import { scopeWorkspaceToCrew } from '@/lib/workspace/canvas-scope';
import type { CrewRun, CrewStudioWorkspace, CanvasLayout, CanvasRunPhase } from '@/types';
import { TriggerNode } from './nodes/TriggerNode';
import { OutputNode } from './nodes/OutputNode';
import { TaskNode } from './nodes/TaskNode';
import { AgentNode } from './nodes/AgentNode';
import { ConnectionNode } from './nodes/ConnectionNode';
import { ActionNode } from './nodes/ActionNode';
import { SubCrewNode } from './nodes/SubCrewNode';
import type { SelectedEntity } from './NodeConfigPanel';

const NODE_TYPES: NodeTypes = {
  trigger: TriggerNode,
  output: OutputNode,
  task: TaskNode,
  agent: AgentNode,
  connection: ConnectionNode,
  action: ActionNode,
  // PR 21: sub-crew invocation node — the visual half of the
  // Coordinator pattern (call another crew as a tool).
  subcrew: SubCrewNode,
};

function entityForNode(node: Node): SelectedEntity {
  if (node.type === 'trigger') return { kind: 'trigger' };
  if (node.type === 'output') return { kind: 'output' };
  if (node.type === 'task') return { kind: 'task', id: node.id };
  if (node.type === 'agent') return { kind: 'agent', id: node.id };
  if (node.type === 'connection') return { kind: 'connection', id: node.id };
  if (node.type === 'action') return { kind: 'action', id: node.id };
  if (node.type === 'subcrew') {
    // Node id is 'subcrew-<invocationId>'; strip the prefix so the
    // SelectedEntity carries the raw invocation id that the editor
    // panel expects.
    const invId = node.id.startsWith('subcrew-') ? node.id.slice('subcrew-'.length) : node.id;
    return { kind: 'subcrew', id: invId };
  }
  return null;
}

function eventTaskId(workspace: CrewStudioWorkspace, eventTaskId?: string, taskName?: string): string | null {
  if (eventTaskId && workspace.tasks.some((task) => task.id === eventTaskId)) return eventTaskId;
  if (!taskName) return null;
  const normalized = taskName.trim().toLowerCase();
  return (
    workspace.tasks.find(
      (task) =>
        task.name.trim().toLowerCase() === normalized ||
        task.description.trim().toLowerCase() === normalized
    )?.id || null
  );
}

function eventAgentId(workspace: CrewStudioWorkspace, eventAgentId?: string, agentName?: string): string | null {
  if (eventAgentId && workspace.agents.some((agent) => agent.id === eventAgentId)) return eventAgentId;
  if (!agentName) return null;
  const normalized = agentName.trim().toLowerCase();
  return (
    workspace.agents.find(
      (agent) =>
        agent.name.trim().toLowerCase() === normalized ||
        agent.role.trim().toLowerCase() === normalized
    )?.id || null
  );
}

function strongestPhase(phases: Array<CanvasRunPhase | undefined>): CanvasRunPhase {
  if (phases.includes('failed')) return 'failed';
  if (phases.includes('running')) return 'running';
  if (phases.includes('completed')) return 'completed';
  return 'idle';
}

/**
 * PR γ — runtime state passed to canvas nodes. Splits the old phase map
 * into two slices so the SubCrewNode can read its current/max counter
 * alongside the existing phase tag. Existing nodes that only consume
 * `phase` continue to work unchanged.
 */
interface CanvasRuntimeState {
  phaseByEntityId: Record<string, CanvasRunPhase>;
  subcrewInvocationCount: Record<string, { current: number; max: number }>;
}

function deriveRuntimeState(
  workspace: CrewStudioWorkspace,
  activeRun: CrewRun | null
): CanvasRuntimeState {
  const phaseByEntityId = deriveRunState(workspace, activeRun);
  // Count subcrew_call events per invocation in the active run. The
  // `max` comes from the workspace's invocation entity; the `current`
  // comes from the trace. We initialize every declared invocation to
  // 0/max so freshly-running crews show 0/N before the first kickoff.
  const subcrewInvocationCount: Record<
    string,
    { current: number; max: number }
  > = {};
  for (const inv of workspace.subCrewInvocations) {
    subcrewInvocationCount[inv.id] = { current: 0, max: inv.maxInvocations };
  }
  if (activeRun) {
    for (const ev of activeRun.events) {
      if (ev.type !== 'subcrew_call') continue;
      const invocationId = ev.metadata?.parentInvocationId;
      if (!invocationId) continue;
      const entry = subcrewInvocationCount[invocationId];
      if (!entry) continue;
      // We trust `invocationNumber` when present (the Python wrapper
      // emits 1-based call counts in order), otherwise we fall back
      // to a simple count. Math.max guards against a stale event
      // arriving after a higher one.
      const reportedCurrent =
        typeof ev.metadata?.invocationNumber === 'number'
          ? ev.metadata.invocationNumber
          : entry.current + 1;
      entry.current = Math.max(entry.current, reportedCurrent);
      if (
        typeof ev.metadata?.invocationTotal === 'number' &&
        ev.metadata.invocationTotal > 0
      ) {
        entry.max = ev.metadata.invocationTotal;
      }
    }
  }
  return { phaseByEntityId, subcrewInvocationCount };
}

function deriveRunState(workspace: CrewStudioWorkspace, activeRun: CrewRun | null): Record<string, CanvasRunPhase> {
  const state: Record<string, CanvasRunPhase> = {};
  if (!activeRun) return state;

  state.trigger = activeRun.status === 'queued' ? 'running' : 'completed';
  if (activeRun.status === 'completed') {
    state.output = 'completed';
  } else if (activeRun.status === 'errored') {
    state.output = 'failed';
  } else if (activeRun.status === 'running') {
    state.output = 'running';
  }

  for (const event of activeRun.events) {
    if (event.nodeId && event.phase) {
      state[event.nodeId] = event.phase;
    }

    const taskId = eventTaskId(workspace, event.taskId, event.taskName);
    if (taskId) {
      if (event.type === 'task_started') state[taskId] = 'running';
      if (event.type === 'task_completed') state[taskId] = 'completed';
      if (event.type === 'task_failed') state[taskId] = 'failed';
    }

    const agentId = eventAgentId(workspace, event.agentId, event.agentName);
    if (agentId) {
      if (event.type === 'agent_started') state[agentId] = 'running';
      if (event.type === 'agent_completed') state[agentId] = 'completed';
      if (event.type === 'agent_failed') state[agentId] = 'failed';
    }
  }

  for (const agent of workspace.agents) {
    const taskPhases = workspace.tasks
      .filter((task) => task.agentId === agent.id)
      .map((task) => state[task.id])
      .filter(Boolean);
    const derived = strongestPhase([state[agent.id], ...taskPhases]);
    if (derived !== 'idle') state[agent.id] = derived;
  }

  for (const connection of workspace.connections) {
    const agentPhases = workspace.agents
      .filter((agent) => agent.connectionIds.includes(connection.id))
      .map((agent) => state[agent.id])
      .filter(Boolean);
    const derived = strongestPhase(agentPhases);
    if (derived !== 'idle') state[connection.id] = derived;
  }

  for (const action of workspace.actions) {
    if (!activeRun || !action.enabled) continue;
    if (activeRun.status === 'completed' && !state[action.id]) state[action.id] = 'completed';
    if ((activeRun.status === 'errored' || activeRun.status === 'cancelled') && !state[action.id]) {
      state[action.id] = 'failed';
    }
  }

  return state;
}

function buildNodesAndEdges(
  workspace: CrewStudioWorkspace,
  revealEntity: SelectedEntity,
  activeRun: CrewRun | null,
  selectedCrewId: string | null
): { nodes: Node[]; edges: Edge[] } {
  const layout = workspace.canvasLayout;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const runtimeState = deriveRuntimeState(workspace, activeRun);
  const runState = runtimeState.phaseByEntityId;
  const subcrewCounts = runtimeState.subcrewInvocationCount;

  // PR 23 — render only the active crew's slice. Trigger/output are
  // always shown; the rest comes from the filter (which falls back to
  // the unfiltered set when selectedCrewId is null or unknown, so a
  // single-crew workspace still looks identical to before this PR).
  const scoped = scopeWorkspaceToCrew(workspace, selectedCrewId);
  const activeCrew =
    (selectedCrewId
      ? workspace.crews.find((c) => c.id === selectedCrewId)
      : null) || workspace.crews[0] || null;

  // Trigger node
  nodes.push({
    id: 'trigger',
    type: 'trigger',
    position: layout.nodes['trigger'] || { x: 50, y: 200 },
    data: {
      label: 'Crew Kickoff',
      crewName: activeCrew?.name || workspace.name,
      process: activeCrew?.process || 'sequential',
      runState: runState.trigger || 'idle',
    },
  });

  // Output node
  nodes.push({
    id: 'output',
    type: 'output',
    position: layout.nodes['output'] || { x: 900, y: 200 },
    data: { label: 'Crew Result', runState: runState.output || 'idle' },
  });

  // Task nodes
  let taskX = 350;
  scoped.tasks.forEach((task) => {
    const pos = layout.nodes[task.id] || { x: taskX, y: 100 };
    taskX += 300;
    const assignedAgent = scoped.agents.find((a) => a.id === task.agentId);
    nodes.push({
      id: task.id,
      type: 'task',
      position: pos,
      data: {
        taskId: task.id,
        label: task.name,
        agentName: assignedAgent?.name || '',
        outputFile: task.outputFile,
        dependencyCount: task.contextTaskIds.length,
        humanInput: task.humanInput,
        asyncExecution: task.asyncExecution,
        runState: runState[task.id] || 'idle',
      },
    });
  });

  // Agent nodes
  let agentX = 350;
  scoped.agents.forEach((agent) => {
    const pos = layout.nodes[agent.id] || { x: agentX, y: 380 };
    agentX += 300;
    nodes.push({
      id: agent.id,
      type: 'agent',
      position: pos,
      data: {
        agentId: agent.id,
        label: agent.name,
        role: agent.role,
        llm: agent.llm,
        toolCount: agent.tools.length,
        connectionCount: agent.connectionIds.length,
        allowDelegation: agent.allowDelegation,
        runState: runState[agent.id] || 'idle',
      },
    });
  });

  // Connection nodes
  let connX = 50;
  scoped.connections.forEach((conn) => {
    const pos = layout.nodes[conn.id] || { x: connX, y: 550 };
    connX += 280;
    nodes.push({
      id: conn.id,
      type: 'connection',
      position: pos,
      data: {
        connectionId: conn.id,
        label: conn.name,
        mode: conn.mode,
        ready: isCrewStudioConnectionReady(conn),
        runState: runState[conn.id] || 'idle',
      },
    });
  });

  // Action nodes
  scoped.actions.forEach((action) => {
    const afterTask = scoped.tasks.find((task) => task.id === action.afterTaskId);
    const fallback = afterTask
      ? {
          x: (layout.nodes[afterTask.id]?.x || 600) + 260,
          y: (layout.nodes[afterTask.id]?.y || 100) + 140,
        }
      : { x: 900, y: 260 };
    const pos = layout.nodes[action.id] || fallback;
    nodes.push({
      id: action.id,
      type: 'action',
      position: pos,
      data: {
        actionId: action.id,
        label: action.name,
        type: action.type,
        enabled: action.enabled,
        afterTaskName: afterTask?.name || '',
        recipientCount: action.recipients.length,
        runState: runState[action.id] || 'idle',
      },
    });
  });

  // PR 21: Sub-crew invocation nodes. Layout falls back to a row
  // beneath agents so a fresh template doesn't pile them on top of
  // existing nodes. Real positions persist via canvasLayout once the
  // user drags them.
  let subcrewX = 350;
  scoped.subCrewInvocations.forEach((inv) => {
    const nodeId = `subcrew-${inv.id}`;
    const pos = layout.nodes[nodeId] || layout.nodes[inv.id] || { x: subcrewX, y: 720 };
    subcrewX += 300;
    const targetCrew = workspace.crews.find((c) => c.id === inv.targetCrewId);
    const liveCount = subcrewCounts[inv.id];
    nodes.push({
      id: nodeId,
      type: 'subcrew',
      position: pos,
      data: {
        invocationId: inv.id,
        label: inv.name,
        targetCrewName: targetCrew?.name || '',
        maxInvocations: inv.maxInvocations,
        runState: runState[nodeId] || runState[inv.id] || 'idle',
        // PR γ — live loop counter. Only present when a run is active.
        // `current` starts at 0 and increments on each subcrew_call;
        // `max` comes from the invocation entity (or the wrapper's
        // emitted invocationTotal if it ever disagrees).
        liveCurrent: activeRun ? liveCount?.current ?? 0 : undefined,
        liveMax: activeRun ? liveCount?.max ?? inv.maxInvocations : undefined,
      },
    });
  });

  // PR 21: Edge for sub-crew invocations.
  //  - agent → subcrew (dashed): the agent CAN call this invocation as
  //    a tool. Not a workflow-ordering edge.
  // PR 23 removed the subcrew → target-crew edge because the target
  // crew's task nodes are filtered off this canvas. SubCrewNode's body
  // already labels its target ("→ <crew name>") which is sufficient.
  scoped.subCrewInvocations.forEach((inv) => {
    const subcrewNodeId = `subcrew-${inv.id}`;
    scoped.agents.forEach((agent) => {
      if (!agent.subCrewToolIds.includes(inv.id)) return;
      edges.push({
        id: `subcrew-tool-${agent.id}-${inv.id}`,
        source: agent.id,
        sourceHandle: 'top',
        target: subcrewNodeId,
        targetHandle: 'bottom',
        className: 'canvas-edge-subcrew-tool',
        style: { strokeDasharray: '4 4', opacity: 0.55 },
      });
    });
  });

  // Edges: trigger -> first task (if crew has tasks)
  // Workflow edges use left/right handles (horizontal flow)
  // Workflow-ordering edges (trigger → first task → … → last task →
  // output) are derived from crew.taskIds. They aren't backed by a
  // single editable field, so we mark them deletable=false to keep
  // users from "deleting" what is actually a multi-field reorder.
  const crew = activeCrew;
  if (crew && crew.taskIds.length > 0) {
    edges.push({
      id: 'trigger-to-first',
      source: 'trigger',
      sourceHandle: 'right',
      target: crew.taskIds[0],
      targetHandle: 'left',
      className: 'canvas-edge',
      deletable: false,
    });

    // Sequential task edges
    for (let i = 0; i < crew.taskIds.length - 1; i++) {
      edges.push({
        id: `task-${crew.taskIds[i]}-to-${crew.taskIds[i + 1]}`,
        source: crew.taskIds[i],
        sourceHandle: 'right',
        target: crew.taskIds[i + 1],
        targetHandle: 'left',
        className: 'canvas-edge',
        deletable: false,
      });
    }

    const lastTaskId = crew.taskIds[crew.taskIds.length - 1];
    const lastTaskActions = workspace.actions.filter((action) => action.enabled && action.afterTaskId === lastTaskId);
    if (lastTaskActions.length > 0) {
      lastTaskActions.forEach((action, index) => {
        edges.push({
          id: `task-${lastTaskId}-action-${action.id}`,
          source: lastTaskId,
          sourceHandle: 'right',
          target: action.id,
          targetHandle: 'left',
          className: 'canvas-edge-action',
        });
        edges.push({
          id: `action-${action.id}-output-${index}`,
          source: action.id,
          sourceHandle: 'right',
          target: 'output',
          targetHandle: 'left',
          className: 'canvas-edge-action',
          deletable: false,
        });
      });
    } else {
      edges.push({
        id: 'last-to-output',
        source: lastTaskId,
        sourceHandle: 'right',
        target: 'output',
        targetHandle: 'left',
        className: 'canvas-edge',
        deletable: false,
      });
    }
  }

  scoped.actions
    .filter((action) => action.enabled && action.afterTaskId && action.afterTaskId !== (crew ? crew.taskIds[crew.taskIds.length - 1] : undefined))
    .forEach((action) => {
      edges.push({
        id: `task-${action.afterTaskId}-action-${action.id}`,
        source: action.afterTaskId!,
        sourceHandle: 'right',
        target: action.id,
        targetHandle: 'left',
        className: 'canvas-edge-action',
      });
    });

  const revealContextEdges = revealEntity?.kind === 'task'
    ? scoped.tasks.filter((task) => task.id === revealEntity.id)
    : [];
  revealContextEdges.forEach((task) => {
    task.contextTaskIds.forEach((depId) => {
      edges.push({
        id: `ctx-${depId}-${task.id}`,
        source: depId,
        sourceHandle: 'bottom-source',
        target: task.id,
        targetHandle: 'bottom',
        className: 'canvas-edge-context canvas-edge-revealed',
        style: { strokeDasharray: '5 5', opacity: 0.55 },
      });
    });
  });

  scoped.tasks.forEach((task) => {
    if (!task.agentId) return;
    edges.push({
      id: `agent-${task.agentId}-task-${task.id}`,
      source: task.agentId,
      sourceHandle: 'top',
      target: task.id,
      targetHandle: 'bottom',
      className: 'canvas-edge-assignment',
      style: { strokeDasharray: '3 3', opacity: 0.5 },
    });
  });

  scoped.agents.forEach((agent) => {
    agent.connectionIds.forEach((connId) => {
      edges.push({
        id: `conn-${connId}-agent-${agent.id}`,
        source: connId,
        sourceHandle: 'top',
        target: agent.id,
        targetHandle: 'bottom',
        className: 'canvas-edge-connection',
        style: { strokeDasharray: '3 3', opacity: 0.45 },
      });
    });
  });

  return { nodes, edges };
}

export function WorkflowCanvas({
  workspace,
  selectedEntity,
  activeRun,
  selectedCrewId,
  onSelect,
  onLayoutChange,
  onAddEdge,
  onEdgesDelete,
  onDropNode,
}: {
  workspace: CrewStudioWorkspace;
  selectedEntity: SelectedEntity;
  activeRun: CrewRun | null;
  /**
   * PR 23 — id of the crew whose slice of the workspace should render
   * on the canvas. Optional: when omitted (or null, or pointing at a
   * crew that no longer exists), the canvas falls back to the legacy
   * "render everything" behavior so nothing disappears unexpectedly.
   * Once PR 24 wires the crew-tab UI on the parent, it will supply
   * this prop; before that, callers can leave it unset.
   */
  selectedCrewId?: string | null;
  onSelect: (entity: SelectedEntity) => void;
  onLayoutChange: (layout: Partial<CanvasLayout>) => void;
  onAddEdge: (source: string, target: string) => void;
  onEdgesDelete: (edges: Edge[]) => void;
  onDropNode: (type: string, x: number, y: number) => void;
}) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const revealEntity = selectedEntity;

  // Resolve the effective active-crew id once per render. The filter
  // module accepts null and treats it as the fallback, but we surface
  // the resolved value here so logging / debug breakpoints in this
  // component can see exactly which crew slice is on screen.
  const effectiveCrewId = selectedCrewId ?? null;

  const initial = useMemo(
    () => buildNodesAndEdges(workspace, revealEntity, activeRun, effectiveCrewId),
    [workspace, revealEntity, activeRun, effectiveCrewId]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);

  // Track whether a drag is in progress to avoid re-syncing mid-drag
  const isDragging = useRef(false);
  const activeRunEventCount = activeRun?.events.length || 0;
  const activeRunStatus = activeRun?.status || null;
  const activeRunCanvasId = activeRun?.id || null;

  // Sync when workspace data changes (but not during drag to avoid flashing)
  const workspaceKey = useMemo(() => {
    // Build a fingerprint of workspace data excluding canvas positions
    const { canvasLayout, ...rest } = workspace;
    void canvasLayout;
    return JSON.stringify({
      workspace: rest,
      revealEntity,
      runId: activeRunCanvasId,
      runStatus: activeRunStatus,
      eventCount: activeRunEventCount,
      selectedCrewId: effectiveCrewId,
    });
  }, [workspace, revealEntity, activeRunCanvasId, activeRunStatus, activeRunEventCount, effectiveCrewId]);

  useEffect(() => {
    if (isDragging.current) return;
    const next = buildNodesAndEdges(workspace, revealEntity, activeRun, effectiveCrewId);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [workspaceKey, setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
    },
    [onNodesChange]
  );

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes);
    },
    [onEdgesChange]
  );

  // Only persist positions when drag finishes - prevents flashing during drag
  const handleNodeDragStart = useCallback(() => {
    isDragging.current = true;
  }, []);

  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node, draggedNodes: Node[]) => {
      isDragging.current = false;
      const nodeUpdates: Record<string, { x: number; y: number }> = {};
      for (const n of draggedNodes) {
        nodeUpdates[n.id] = n.position;
      }
      if (Object.keys(nodeUpdates).length === 0 && node.position) {
        nodeUpdates[node.id] = node.position;
      }
      onLayoutChange({ nodes: nodeUpdates });
    },
    [onLayoutChange]
  );

  // Don't push the new edge into local edge state — buildNodesAndEdges
  // will re-derive it from the next workspace render. If we set it here
  // too we'd see a flash of a duplicate edge during the data round-trip.
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        onAddEdge(connection.source, connection.target);
      }
    },
    [onAddEdge]
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      onEdgesDelete(deleted);
    },
    [onEdgesDelete]
  );

  // Pre-validate during the drag so invalid drops show a no-drop cursor
  // and never reach onConnect. Must read from the latest workspace, so
  // wrap in a closure that re-binds on workspace change.
  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => isWireableEdge(workspace, connection.source, connection.target),
    [workspace]
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelect(entityForNode(node));
    },
    [onSelect]
  );

  const handlePaneClick = useCallback(() => {
    onSelect(null);
  }, [onSelect]);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const nodeType = event.dataTransfer.getData('application/crewai-node-type');
      if (!nodeType || !reactFlowWrapper.current) return;

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      onDropNode(nodeType, x, y);
    },
    [onDropNode]
  );

  return (
    <div
      ref={reactFlowWrapper}
      className="canvas-wrapper"
      role="application"
      aria-label="Workflow canvas — use the node palette and right panel to author"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        isValidConnection={isValidConnection}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        nodeTypes={NODE_TYPES}
        fitView
        snapToGrid
        snapGrid={[20, 20]}
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: false,
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="canvas-bg" />
        <Controls className="canvas-controls" />
        <MiniMap
          className="canvas-minimap"
          nodeColor={(node) => {
            switch (node.type) {
              case 'trigger': return 'var(--accent)';
              case 'output': return 'var(--accent)';
              case 'task': return '#60a5fa';
              case 'agent': return '#a78bfa';
              case 'connection': return '#f59e0b';
              case 'subcrew': return '#5eead4';
              default: return 'var(--text-muted)';
            }
          }}
        />
      </ReactFlow>
    </div>
  );
}
