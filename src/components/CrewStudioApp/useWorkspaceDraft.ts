// Draft workspace state and the entity mutator callbacks for agents,
// tasks, actions, crews, and connections.
import { useCallback, useState } from 'react';
import { v4 as uuid } from 'uuid';
import type {
  CrewStudioAgent,
  CrewStudioAction,
  CrewStudioConnection,
  CrewStudioCrew,
  CrewStudioTask,
  CrewStudioWorkspace,
  SubCrewInvocation,
} from '@/types';
import { SUBCREW_LIMITS } from '@/lib/schemas/field-limits';
import type { SelectedEntity } from '../NodeConfigPanel';

function createBlankAgent(defaultLlm: string): CrewStudioAgent {
  return {
    id: uuid(),
    name: 'new_agent',
    role: 'Crew specialist',
    goal: 'Handle a concrete part of the crew objective.',
    backstory: 'Designed locally to support a focused CrewAI workflow.',
    llm: defaultLlm || 'snowflake/claude-sonnet-4-6',
    allowDelegation: true,
    verbose: true,
    maxIter: 10,
    tools: [],
    knowledge: [],
    connectionIds: [],
    tags: [],
    subCrewToolIds: [],
  };
}

function createBlankTask(): CrewStudioTask {
  return {
    id: uuid(),
    name: 'new_task',
    description: 'Describe the work to complete.',
    expectedOutput: 'A clear artifact the crew can hand off.',
    agentId: null,
    contextTaskIds: [],
    outputFile: '',
    humanInput: false,
    asyncExecution: false,
    markdown: true,
  };
}

function createBlankCrew(): CrewStudioCrew {
  return {
    id: uuid(),
    name: 'new_crew',
    description: 'Coordinate agents and tasks around one outcome.',
    process: 'sequential',
    agentIds: [],
    taskIds: [],
    managerAgentId: null,
    memory: false,
    planning: true,
    verbose: true,
    tags: [],
  };
}

function createBlankConnection(): CrewStudioConnection {
  return {
    id: uuid(),
    name: 'Snowflake API',
    description: '',
    mode: 'snowflake-api',
    enabled: true,
    isDefault: false,
    account: '',
    user: '',
    passwordEnvVar: '',
    warehouse: '',
    database: '',
    schema: '',
    role: '',
    queryGuide: '',
    toolName: 'snowflake_search',
    allowedTools: [],
    emailNotificationIntegration: '',
    emailDefaultRecipients: [],
    notes: '',
  };
}

/**
 * Mint a fresh `SubCrewInvocation` for palette-drop / quick-add (PR 21).
 *
 * Defaults follow the design doc:
 *   - name: 'New sub-crew'
 *   - description: blank (the editor surfaces a placeholder hint)
 *   - targetCrewId: the first crew in the workspace, or '' when the
 *     workspace has no crews (the editor will surface the missing-target
 *     warning and the validator flags it as `subcrew_orphaned`)
 *   - maxInvocations: SUBCREW_LIMITS.DEFAULT_INVOCATIONS (3)
 *   - contextMode: 'isolated' (v1 only)
 */
function createBlankSubCrewInvocation(
  workspace: CrewStudioWorkspace | null
): SubCrewInvocation {
  return {
    id: uuid(),
    name: 'New sub-crew',
    description: '',
    targetCrewId: workspace?.crews[0]?.id || '',
    maxInvocations: SUBCREW_LIMITS.DEFAULT_INVOCATIONS,
    inputMapping: '',
    successCriteria: null,
    contextMode: 'isolated',
    tags: [],
  };
}

function createBlankAction(workspace: CrewStudioWorkspace | null): CrewStudioAction {
  const lastCrewTaskId = workspace?.crews[0]?.taskIds.at(-1) || workspace?.tasks.at(-1)?.id || null;
  const defaultConnection =
    workspace?.connections.find((connection) => connection.mode === 'snowflake-api' && connection.enabled && connection.isDefault) ||
    workspace?.connections.find((connection) => connection.mode === 'snowflake-api' && connection.enabled) ||
    null;

  return {
    id: uuid(),
    name: 'email_result',
    type: 'email',
    enabled: true,
    afterTaskId: lastCrewTaskId,
    connectionId: defaultConnection?.id || null,
    recipients: defaultConnection?.emailDefaultRecipients || [],
    subject: '',
    emailBodyMode: 'clean',
    notes: '',
  };
}

export function useWorkspaceDraft(opts: {
  setSelection: (entity: SelectedEntity) => void;
  setRightOpen: (open: boolean) => void;
}) {
  const { setSelection, setRightOpen } = opts;
  const [draft, setDraft] = useState<CrewStudioWorkspace | null>(null);

  /* --- draft mutation helpers --- */
  function updateDraft(fn: (w: CrewStudioWorkspace) => CrewStudioWorkspace) {
    setDraft((cur) => (cur ? fn(cur) : cur));
  }

  /* --- entity mutators --- */
  const updateAgent = useCallback((id: string, fn: (a: CrewStudioAgent) => CrewStudioAgent) => {
    updateDraft((w) => ({ ...w, agents: w.agents.map((a) => (a.id === id ? fn(a) : a)) }));
  }, []);

  const updateTask = useCallback((id: string, fn: (t: CrewStudioTask) => CrewStudioTask) => {
    updateDraft((w) => ({ ...w, tasks: w.tasks.map((t) => (t.id === id ? fn(t) : t)) }));
  }, []);

  const updateAction = useCallback((id: string, fn: (a: CrewStudioAction) => CrewStudioAction) => {
    updateDraft((w) => ({ ...w, actions: w.actions.map((a) => (a.id === id ? fn(a) : a)) }));
  }, []);

  const updateCrew = useCallback((id: string, fn: (c: CrewStudioCrew) => CrewStudioCrew) => {
    updateDraft((w) => ({ ...w, crews: w.crews.map((c) => (c.id === id ? fn(c) : c)) }));
  }, []);

  const updateConnection = useCallback((id: string, fn: (c: CrewStudioConnection) => CrewStudioConnection) => {
    updateDraft((w) => ({ ...w, connections: w.connections.map((c) => (c.id === id ? fn(c) : c)) }));
  }, []);

  const addAgent = useCallback(() => {
    if (!draft) return;
    const agent = createBlankAgent(draft.defaultLlm);
    updateDraft((w) => ({
      ...w,
      agents: [...w.agents, agent],
      canvasLayout: {
        ...w.canvasLayout,
        nodes: { ...w.canvasLayout.nodes, [agent.id]: { x: 200 + Math.random() * 200, y: 350 + Math.random() * 100 } },
      },
    }));
    setSelection({ kind: 'agent', id: agent.id });
    setRightOpen(true);
  }, [draft, setSelection, setRightOpen]);

  const addTask = useCallback(() => {
    const task = createBlankTask();
    updateDraft((w) => ({
      ...w,
      tasks: [...w.tasks, task],
      crews: w.crews.length > 0
        ? w.crews.map((c, i) => i === 0 ? { ...c, taskIds: [...c.taskIds, task.id] } : c)
        : w.crews,
      canvasLayout: {
        ...w.canvasLayout,
        nodes: { ...w.canvasLayout.nodes, [task.id]: { x: 300 + w.tasks.length * 280, y: 120 + Math.random() * 60 } },
      },
    }));
    setSelection({ kind: 'task', id: task.id });
    setRightOpen(true);
  }, [setSelection, setRightOpen]);

  const addConnection = useCallback(() => {
    const conn = createBlankConnection();
    updateDraft((w) => ({
      ...w,
      connections: [...w.connections, conn],
      canvasLayout: {
        ...w.canvasLayout,
        nodes: { ...w.canvasLayout.nodes, [conn.id]: { x: 50 + w.connections.length * 260, y: 550 + Math.random() * 40 } },
      },
    }));
    setSelection({ kind: 'connection', id: conn.id });
    setRightOpen(true);
  }, [setSelection, setRightOpen]);

  const addAction = useCallback(() => {
    const action = createBlankAction(draft);
    updateDraft((w) => {
      const afterTaskPosition = action.afterTaskId ? w.canvasLayout.nodes[action.afterTaskId] : null;
      return {
        ...w,
        actions: [...w.actions, action],
        canvasLayout: {
          ...w.canvasLayout,
          nodes: {
            ...w.canvasLayout.nodes,
            [action.id]: {
              x: (afterTaskPosition?.x || 780) + 260,
              y: (afterTaskPosition?.y || 120) + 120,
            },
          },
        },
      };
    });
    setSelection({ kind: 'action', id: action.id });
    setRightOpen(true);
  }, [draft, setSelection, setRightOpen]);

  /* --- sub-crew invocation CRUD (PR 21) --- */
  const addSubCrewInvocation = useCallback(() => {
    if (!draft) return;
    const inv = createBlankSubCrewInvocation(draft);
    updateDraft((w) => ({
      ...w,
      subCrewInvocations: [...w.subCrewInvocations, inv],
      canvasLayout: {
        ...w.canvasLayout,
        nodes: {
          ...w.canvasLayout.nodes,
          [`subcrew-${inv.id}`]: {
            x: 200 + (w.subCrewInvocations.length % 4) * 300,
            y: 720,
          },
        },
      },
    }));
    setSelection({ kind: 'subcrew', id: inv.id });
    setRightOpen(true);
  }, [draft, setSelection, setRightOpen]);

  const updateSubCrewInvocation = useCallback(
    (id: string, next: SubCrewInvocation) => {
      updateDraft((w) => ({
        ...w,
        subCrewInvocations: w.subCrewInvocations.map((i) =>
          i.id === id ? { ...next, id } : i
        ),
      }));
    },
    []
  );

  const removeSubCrewInvocation = useCallback((id: string) => {
    updateDraft((w) => ({
      ...w,
      subCrewInvocations: w.subCrewInvocations.filter((i) => i.id !== id),
      // Also drop the dangling reference from every agent's
      // subCrewToolIds. The normalizer would do this on the next save,
      // but doing it eagerly keeps the picker UI in sync immediately.
      agents: w.agents.map((a) => ({
        ...a,
        subCrewToolIds: a.subCrewToolIds.filter((toolId) => toolId !== id),
      })),
    }));
  }, []);

  const removeAgent = useCallback((id: string) => {
    updateDraft((w) => ({
      ...w,
      agents: w.agents.filter((a) => a.id !== id),
      tasks: w.tasks.map((t) => (t.agentId === id ? { ...t, agentId: null } : t)),
      crews: w.crews.map((c) => ({
        ...c,
        agentIds: c.agentIds.filter((x) => x !== id),
        managerAgentId: c.managerAgentId === id ? null : c.managerAgentId,
      })),
    }));
  }, []);

  const removeTask = useCallback((id: string) => {
    updateDraft((w) => ({
      ...w,
      tasks: w.tasks.filter((t) => t.id !== id).map((t) => ({
        ...t,
        contextTaskIds: t.contextTaskIds.filter((x) => x !== id),
      })),
      actions: w.actions.map((action) => (
        action.afterTaskId === id ? { ...action, afterTaskId: null } : action
      )),
      crews: w.crews.map((c) => ({ ...c, taskIds: c.taskIds.filter((x) => x !== id) })),
    }));
  }, []);

  const removeAction = useCallback((id: string) => {
    updateDraft((w) => ({
      ...w,
      actions: w.actions.filter((action) => action.id !== id),
    }));
  }, []);

  const removeCrew = useCallback((id: string) => {
    updateDraft((w) => ({
      ...w,
      crews: w.crews.filter((c) => c.id !== id),
      // When the source crew goes away, any sub-crew invocation
      // targeting it becomes orphan. Save-time normalize would prune
      // them; doing it eagerly keeps the canvas / picker in sync now.
      subCrewInvocations: w.subCrewInvocations.filter((inv) => inv.targetCrewId !== id),
    }));
  }, []);

  const removeConnection = useCallback((id: string) => {
    updateDraft((w) => {
      const remaining = w.connections.filter((c) => c.id !== id);
      if (remaining.length > 0 && !remaining.some((c) => c.isDefault)) {
        remaining[0] = { ...remaining[0], isDefault: true };
      }
      return {
        ...w,
        connections: remaining,
        agents: w.agents.map((a) => ({ ...a, connectionIds: a.connectionIds.filter((x) => x !== id) })),
        actions: w.actions.map((action) => (
          action.connectionId === id ? { ...action, connectionId: null } : action
        )),
      };
    });
  }, []);

  const setDefaultConnection = useCallback((id: string) => {
    updateDraft((w) => ({
      ...w,
      connections: w.connections.map((c) => ({ ...c, isDefault: c.id === id })),
    }));
  }, []);

  return {
    draft,
    setDraft,
    updateDraft,
    updateAgent,
    updateTask,
    updateAction,
    updateCrew,
    updateConnection,
    addAgent,
    addTask,
    addAction,
    addConnection,
    addSubCrewInvocation,
    updateSubCrewInvocation,
    removeSubCrewInvocation,
    removeAgent,
    removeTask,
    removeAction,
    removeCrew,
    removeConnection,
    setDefaultConnection,
    createBlankAgent,
    createBlankTask,
    createBlankCrew,
    createBlankConnection,
    createBlankAction,
    createBlankSubCrewInvocation,
  };
}
