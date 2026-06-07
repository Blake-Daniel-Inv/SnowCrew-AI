import { describe, it, expect } from 'vitest';
import { wouldCreateCycle, formatCyclePath } from './cycle-preview';
import type {
  CrewStudioTask,
  CrewStudioWorkspace,
} from '@/types';

// Minimal task fixture — the picker preview only inspects id, name,
// and contextTaskIds, so we don't need to pretend to be a full
// CrewStudioWorkspace shape. Cast through `unknown` at the call site.
function task(id: string, contextTaskIds: string[] = [], name = id): CrewStudioTask {
  return {
    id,
    name,
    description: '',
    expectedOutput: '',
    agentId: null,
    contextTaskIds,
    outputFile: '',
    humanInput: false,
    asyncExecution: false,
    markdown: true,
  };
}

function workspace(tasks: CrewStudioTask[]): CrewStudioWorkspace {
  return {
    id: 'ws',
    ownerId: 'u',
    repoPath: null,
    name: 'ws',
    description: '',
    productBrief: '',
    defaultLlm: '',
    tags: [],
    agents: [],
    tasks,
    actions: [],
    crews: [],
    connections: [],
    subCrewInvocations: [],
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: '',
    updatedAt: '',
  };
}

describe('wouldCreateCycle', () => {
  it('flags self-reference with a single-id path', () => {
    const ws = workspace([task('A')]);
    const result = wouldCreateCycle(ws, 'A', 'A');
    expect(result).toEqual({ wouldCycle: true, cyclePath: ['A'] });
  });

  it('flags a direct 2-node cycle A->B and adding A as context to B', () => {
    // A already has B in its context; checking "add A to B's context"
    // would create A -> B -> A.
    const ws = workspace([
      task('A', ['B']),
      task('B', []),
    ]);
    const result = wouldCreateCycle(ws, 'B', 'A');
    expect(result.wouldCycle).toBe(true);
    if (result.wouldCycle) {
      expect(result.cyclePath).toEqual(['B', 'A', 'B']);
    }
  });

  it('flags a transitive 3-node cycle', () => {
    // A -> B -> C; user tries to add A to C's contexts (C -> A -> B -> C).
    const ws = workspace([
      task('A', ['B']),
      task('B', ['C']),
      task('C', []),
    ]);
    const result = wouldCreateCycle(ws, 'C', 'A');
    expect(result.wouldCycle).toBe(true);
    if (result.wouldCycle) {
      // Path semantics: starting node is the task being edited (C),
      // then candidate (A), then DFS hops back to C.
      expect(result.cyclePath).toEqual(['C', 'A', 'B', 'C']);
    }
  });

  it('returns wouldCycle: false for a deep acyclic chain', () => {
    // Linear DAG: A -> B -> C -> D. Adding D as context to A is safe.
    const ws = workspace([
      task('A', ['B']),
      task('B', ['C']),
      task('C', ['D']),
      task('D', []),
    ]);
    const result = wouldCreateCycle(ws, 'A', 'D');
    expect(result.wouldCycle).toBe(false);
  });

  it('returns wouldCycle: false for a diamond DAG', () => {
    // Diamond: A -> B, A -> C, B -> D, C -> D. Adding D as context to
    // A means A -> D, A -> B -> D, A -> C -> D. Still acyclic.
    const ws = workspace([
      task('A', ['B', 'C']),
      task('B', ['D']),
      task('C', ['D']),
      task('D', []),
    ]);
    const result = wouldCreateCycle(ws, 'A', 'D');
    expect(result.wouldCycle).toBe(false);
  });

  it('returns wouldCycle: false when the candidate id is not in the workspace', () => {
    // The save-time normalizer drops orphan refs; mirror that here so
    // we don't pop a misleading cycle warning for a deleted task.
    const ws = workspace([task('A')]);
    const result = wouldCreateCycle(ws, 'A', 'ghost');
    expect(result.wouldCycle).toBe(false);
  });

  it('handles a cycle that already exists in the workspace', () => {
    // If the workspace itself already contains a cycle B -> C -> B
    // (which the normalizer would normally filter out at save), the
    // preview should still terminate and report correctly when asked
    // about adding B as context to A.
    const ws = workspace([
      task('A', []),
      task('B', ['C']),
      task('C', ['B']),
    ]);
    // Adding B to A doesn't loop back to A; expect no cycle.
    const result = wouldCreateCycle(ws, 'A', 'B');
    expect(result.wouldCycle).toBe(false);
  });
});

describe('formatCyclePath', () => {
  it('joins names with arrows', () => {
    const ws = workspace([
      task('A', [], 'Analyze'),
      task('B', [], 'Report'),
    ]);
    expect(formatCyclePath(ws, ['A', 'B', 'A'])).toBe('Analyze → Report → Analyze');
  });

  it('falls back to id when a name lookup misses', () => {
    const ws = workspace([task('A', [], 'Analyze')]);
    expect(formatCyclePath(ws, ['A', 'X', 'A'])).toBe('Analyze → X → Analyze');
  });
});

// ============================================================
// PR 20 — wouldCreateSubCrewCycle
// ============================================================
// Same DFS shape as wouldCreateCycle but operates on the crew-call
// graph rather than task contexts. We exercise the documented edge
// cases: candidate missing, self-loop, simple A→B / B→A flag, and a
// 3-crew transitive cycle.

import {
  wouldCreateSubCrewCycle,
  formatSubCrewCyclePath,
} from './cycle-preview';
import type {
  CrewStudioAgent,
  CrewStudioCrew,
  SubCrewInvocation,
} from '@/types';

function makeAgent(id: string, toolIds: string[] = []): CrewStudioAgent {
  return {
    id,
    name: id,
    role: '',
    goal: '',
    backstory: '',
    llm: '',
    allowDelegation: false,
    verbose: false,
    maxIter: 1,
    tools: [],
    knowledge: [],
    connectionIds: [],
    tags: [],
    subCrewToolIds: toolIds,
  };
}

function makeCrew(id: string, agentIds: string[]): CrewStudioCrew {
  return {
    id,
    name: id,
    description: '',
    process: 'sequential',
    agentIds,
    taskIds: [],
    managerAgentId: null,
    memory: false,
    planning: false,
    verbose: false,
    tags: [],
  };
}

function makeInvocation(id: string, targetCrewId: string): SubCrewInvocation {
  return {
    id,
    name: id,
    description: '',
    targetCrewId,
    maxInvocations: 1,
    inputMapping: '',
    successCriteria: null,
    contextMode: 'isolated',
    tags: [],
  };
}

function subcrewWorkspace(opts: {
  agents: CrewStudioAgent[];
  crews: CrewStudioCrew[];
  invocations: SubCrewInvocation[];
}): CrewStudioWorkspace {
  return {
    id: 'ws',
    ownerId: 'u',
    repoPath: null,
    name: 'ws',
    description: '',
    productBrief: '',
    defaultLlm: '',
    tags: [],
    agents: opts.agents,
    tasks: [],
    actions: [],
    crews: opts.crews,
    connections: [],
    subCrewInvocations: opts.invocations,
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: '',
    updatedAt: '',
  };
}

describe('wouldCreateSubCrewCycle', () => {
  it('flags a self-loop (agent in crewA invokes crewA itself)', () => {
    const ws = subcrewWorkspace({
      agents: [makeAgent('a1')],
      crews: [makeCrew('crewA', ['a1'])],
      invocations: [makeInvocation('inv1', 'crewA')],
    });
    const result = wouldCreateSubCrewCycle(ws, 'a1', 'inv1');
    expect(result.wouldCycle).toBe(true);
    if (result.wouldCycle) {
      expect(result.cyclePath).toEqual(['crewA', 'crewA']);
    }
  });

  it('flags a 2-crew cycle (A→B exists; adding B→A closes the loop)', () => {
    // agentA in crewA already has invAB (target crewB).
    // We ask: would adding invBA (target crewA) to agentB cycle? Yes.
    const ws = subcrewWorkspace({
      agents: [makeAgent('agentA', ['invAB']), makeAgent('agentB')],
      crews: [makeCrew('crewA', ['agentA']), makeCrew('crewB', ['agentB'])],
      invocations: [
        makeInvocation('invAB', 'crewB'),
        makeInvocation('invBA', 'crewA'),
      ],
    });
    const result = wouldCreateSubCrewCycle(ws, 'agentB', 'invBA');
    expect(result.wouldCycle).toBe(true);
    if (result.wouldCycle) {
      expect(result.cyclePath).toEqual(['crewB', 'crewA', 'crewB']);
    }
  });

  it('flags a 3-crew transitive cycle', () => {
    // A→B and B→C already wired. Adding C→A closes the loop.
    const ws = subcrewWorkspace({
      agents: [
        makeAgent('agentA', ['invAB']),
        makeAgent('agentB', ['invBC']),
        makeAgent('agentC'),
      ],
      crews: [
        makeCrew('crewA', ['agentA']),
        makeCrew('crewB', ['agentB']),
        makeCrew('crewC', ['agentC']),
      ],
      invocations: [
        makeInvocation('invAB', 'crewB'),
        makeInvocation('invBC', 'crewC'),
        makeInvocation('invCA', 'crewA'),
      ],
    });
    const result = wouldCreateSubCrewCycle(ws, 'agentC', 'invCA');
    expect(result.wouldCycle).toBe(true);
    if (result.wouldCycle) {
      // Path semantics: start at the candidate's source crew (crewC),
      // hop to the target (crewA), then walk back to crewC.
      expect(result.cyclePath).toEqual(['crewC', 'crewA', 'crewB', 'crewC']);
    }
  });

  it('returns wouldCycle:false for an acyclic addition', () => {
    // Two independent crews, no existing tool refs. Adding A→B is safe.
    const ws = subcrewWorkspace({
      agents: [makeAgent('agentA'), makeAgent('agentB')],
      crews: [makeCrew('crewA', ['agentA']), makeCrew('crewB', ['agentB'])],
      invocations: [makeInvocation('invAB', 'crewB')],
    });
    const result = wouldCreateSubCrewCycle(ws, 'agentA', 'invAB');
    expect(result.wouldCycle).toBe(false);
  });

  it('returns wouldCycle:false when the candidate invocation id is missing', () => {
    const ws = subcrewWorkspace({
      agents: [makeAgent('agentA')],
      crews: [makeCrew('crewA', ['agentA'])],
      invocations: [],
    });
    const result = wouldCreateSubCrewCycle(ws, 'agentA', 'ghost-invocation');
    expect(result.wouldCycle).toBe(false);
  });

  it('returns wouldCycle:false when the agent is not in any crew', () => {
    // Agent is orphaned (canvas-only): no source node, so no cycle.
    const ws = subcrewWorkspace({
      agents: [makeAgent('lone')],
      crews: [makeCrew('crewA', [])],
      invocations: [makeInvocation('inv1', 'crewA')],
    });
    const result = wouldCreateSubCrewCycle(ws, 'lone', 'inv1');
    expect(result.wouldCycle).toBe(false);
  });
});

describe('formatSubCrewCyclePath', () => {
  it('joins crew names with arrows', () => {
    const ws = subcrewWorkspace({
      agents: [],
      crews: [
        { ...makeCrew('crewA', []), name: 'Coordinator' },
        { ...makeCrew('crewB', []), name: 'Research' },
      ],
      invocations: [],
    });
    expect(formatSubCrewCyclePath(ws, ['crewA', 'crewB', 'crewA'])).toBe(
      'Coordinator → Research → Coordinator'
    );
  });

  it('falls back to id when a name lookup misses', () => {
    const ws = subcrewWorkspace({
      agents: [],
      crews: [{ ...makeCrew('crewA', []), name: 'Coordinator' }],
      invocations: [],
    });
    expect(formatSubCrewCyclePath(ws, ['crewA', 'ghost', 'crewA'])).toBe(
      'Coordinator → ghost → Coordinator'
    );
  });
});
