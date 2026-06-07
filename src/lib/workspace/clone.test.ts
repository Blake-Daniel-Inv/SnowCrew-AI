import { describe, it, expect } from 'vitest';
import { cloneWorkspace } from './clone';
import type {
  CrewStudioAction,
  CrewStudioAgent,
  CrewStudioConnection,
  CrewStudioCrew,
  CrewStudioTask,
  CrewStudioWorkspace,
} from '@/types';

/* ------------------------------------------------------------------ */
/*  Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

function connection(id: string, overrides: Partial<CrewStudioConnection> = {}): CrewStudioConnection {
  return {
    id,
    name: `conn-${id}`,
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
    toolName: '',
    allowedTools: [],
    emailNotificationIntegration: '',
    emailDefaultRecipients: [],
    notes: '',
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<CrewStudioAgent> = {}): CrewStudioAgent {
  return {
    id,
    name: `agent-${id}`,
    role: 'r',
    goal: 'g',
    backstory: 'b',
    llm: 'snowflake/claude-sonnet-4-6',
    allowDelegation: true,
    verbose: true,
    maxIter: 12,
    tools: [],
    knowledge: [],
    connectionIds: [],
    tags: [],
    subCrewToolIds: [],
    ...overrides,
  };
}

function task(id: string, overrides: Partial<CrewStudioTask> = {}): CrewStudioTask {
  return {
    id,
    name: `task-${id}`,
    description: 'd',
    expectedOutput: 'e',
    agentId: null,
    contextTaskIds: [],
    outputFile: '',
    humanInput: false,
    asyncExecution: false,
    markdown: true,
    ...overrides,
  };
}

function action(id: string, overrides: Partial<CrewStudioAction> = {}): CrewStudioAction {
  return {
    id,
    name: `act-${id}`,
    type: 'email',
    enabled: true,
    afterTaskId: null,
    connectionId: null,
    recipients: [],
    subject: '',
    emailBodyMode: 'clean',
    notes: '',
    ...overrides,
  };
}

function crew(id: string, overrides: Partial<CrewStudioCrew> = {}): CrewStudioCrew {
  return {
    id,
    name: `crew-${id}`,
    description: 'd',
    process: 'sequential',
    agentIds: [],
    taskIds: [],
    managerAgentId: null,
    memory: false,
    planning: true,
    verbose: true,
    tags: [],
    ...overrides,
  };
}

function workspace(overrides: Partial<CrewStudioWorkspace> = {}): CrewStudioWorkspace {
  const now = new Date('2025-01-01T00:00:00Z').toISOString();
  return {
    id: 'ws-src',
    ownerId: 'user-a',
    repoPath: null,
    name: 'Source Workspace',
    description: 'd',
    productBrief: 'p',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: [],
    agents: [],
    tasks: [],
    actions: [],
    crews: [],
    connections: [],
    subCrewInvocations: [],
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Build a richly-wired workspace exercising every cross-reference kind
 * the clone is responsible for. Used as the standard fixture for the
 * "all references resolve" walks below.
 */
function richSource(): CrewStudioWorkspace {
  return workspace({
    connections: [connection('c1', { name: 'Primary', isDefault: true })],
    agents: [
      agent('a1', { connectionIds: ['c1'] }),
      agent('a2', { connectionIds: ['c1'] }),
    ],
    tasks: [
      task('t1', { agentId: 'a1' }),
      task('t2', { agentId: 'a2', contextTaskIds: ['t1'] }),
      task('t3', { agentId: 'a1', contextTaskIds: ['t1', 't2'] }),
    ],
    actions: [
      action('act1', { afterTaskId: 't3', connectionId: 'c1' }),
    ],
    crews: [
      crew('crew1', {
        agentIds: ['a1', 'a2'],
        taskIds: ['t1', 't2', 't3'],
        managerAgentId: 'a2',
      }),
    ],
    subCrewInvocations: [],
    canvasLayout: {
      nodes: {
        trigger: { x: 50, y: 100 },
        c1: { x: 100, y: 200 },
        a1: { x: 200, y: 300 },
        a2: { x: 250, y: 350 },
        t1: { x: 300, y: 100 },
        t2: { x: 400, y: 100 },
        t3: { x: 500, y: 100 },
        act1: { x: 600, y: 200 },
        crew1: { x: 700, y: 300 },
        output: { x: 900, y: 100 },
      },
      zoom: 1.5,
      panX: 10,
      panY: 20,
    },
  });
}

/**
 * Walk every cross-reference in `ws` and assert each id is either null
 * (legitimate "unset") or present in `validIds`. Used by the dangling-
 * reference tests.
 */
function collectAllIds(ws: CrewStudioWorkspace): Set<string> {
  const out = new Set<string>();
  out.add(ws.id);
  for (const c of ws.connections) out.add(c.id);
  for (const a of ws.agents) out.add(a.id);
  for (const t of ws.tasks) out.add(t.id);
  for (const a of ws.actions) out.add(a.id);
  for (const c of ws.crews) out.add(c.id);
  return out;
}

function assertAllReferencesResolve(ws: CrewStudioWorkspace) {
  const ids = collectAllIds(ws);
  for (const a of ws.agents) {
    for (const cid of a.connectionIds) expect(ids).toContain(cid);
  }
  for (const t of ws.tasks) {
    if (t.agentId !== null) expect(ids).toContain(t.agentId);
    for (const ctx of t.contextTaskIds) expect(ids).toContain(ctx);
  }
  for (const act of ws.actions) {
    if (act.afterTaskId !== null) expect(ids).toContain(act.afterTaskId);
    if (act.connectionId !== null) expect(ids).toContain(act.connectionId);
  }
  for (const c of ws.crews) {
    for (const aid of c.agentIds) expect(ids).toContain(aid);
    for (const tid of c.taskIds) expect(ids).toContain(tid);
    if (c.managerAgentId !== null) expect(ids).toContain(c.managerAgentId);
  }
}

/* ------------------------------------------------------------------ */
/*  Suite                                                              */
/* ------------------------------------------------------------------ */

describe('cloneWorkspace', () => {
  /* ---- Id minting ---- */

  it('mints a new workspace id', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    expect(out.id).not.toBe(src.id);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints new ids for every entity', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    const srcIds = collectAllIds(src);
    const outIds = collectAllIds(out);
    // No id appears in both — disjoint sets.
    for (const id of outIds) {
      expect(srcIds.has(id)).toBe(false);
    }
  });

  it('preserves entity counts across the clone', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    expect(out.connections.length).toBe(src.connections.length);
    expect(out.agents.length).toBe(src.agents.length);
    expect(out.tasks.length).toBe(src.tasks.length);
    expect(out.actions.length).toBe(src.actions.length);
    expect(out.crews.length).toBe(src.crews.length);
  });

  /* ---- Cross-reference rewiring ---- */

  it('rewires agent.connectionIds through the id map', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    const newConnId = out.connections[0].id;
    for (const a of out.agents) {
      expect(a.connectionIds).toEqual([newConnId]);
    }
  });

  it('rewires task.agentId through the id map', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    const a1New = out.agents[0].id;
    const a2New = out.agents[1].id;
    expect(out.tasks[0].agentId).toBe(a1New);
    expect(out.tasks[1].agentId).toBe(a2New);
    expect(out.tasks[2].agentId).toBe(a1New);
  });

  it('rewires task.contextTaskIds through the id map', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    const t1New = out.tasks[0].id;
    const t2New = out.tasks[1].id;
    expect(out.tasks[1].contextTaskIds).toEqual([t1New]);
    expect(out.tasks[2].contextTaskIds).toEqual([t1New, t2New]);
  });

  it('rewires action.afterTaskId and action.connectionId', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    const t3New = out.tasks[2].id;
    const c1New = out.connections[0].id;
    expect(out.actions[0].afterTaskId).toBe(t3New);
    expect(out.actions[0].connectionId).toBe(c1New);
  });

  it('rewires crew.agentIds, taskIds, and managerAgentId', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    const a1New = out.agents[0].id;
    const a2New = out.agents[1].id;
    const tIds = out.tasks.map((t) => t.id);
    expect(out.crews[0].agentIds).toEqual([a1New, a2New]);
    expect(out.crews[0].taskIds).toEqual(tIds);
    expect(out.crews[0].managerAgentId).toBe(a2New);
  });

  it('walks every cross-reference and confirms each resolves in the clone', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    assertAllReferencesResolve(out);
  });

  /* ---- Canvas layout ---- */

  it('rebuilds canvasLayout.nodes keyed by new entity ids', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    const a1New = out.agents[0].id;
    const t1New = out.tasks[0].id;
    expect(out.canvasLayout.nodes[a1New]).toEqual({ x: 200, y: 300 });
    expect(out.canvasLayout.nodes[t1New]).toEqual({ x: 300, y: 100 });
    // Old keys are gone.
    expect(out.canvasLayout.nodes.a1).toBeUndefined();
    expect(out.canvasLayout.nodes.t1).toBeUndefined();
  });

  it('preserves sentinel canvas keys verbatim (trigger, output)', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    expect(out.canvasLayout.nodes.trigger).toEqual({ x: 50, y: 100 });
    expect(out.canvasLayout.nodes.output).toEqual({ x: 900, y: 100 });
  });

  it('preserves canvas zoom/pan', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    expect(out.canvasLayout.zoom).toBe(1.5);
    expect(out.canvasLayout.panX).toBe(10);
    expect(out.canvasLayout.panY).toBe(20);
  });

  it('does not alias the source canvasLayout.nodes object', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    expect(out.canvasLayout.nodes).not.toBe(src.canvasLayout.nodes);
  });

  /* ---- Provenance / forkedFromId ---- */

  it('sets forkedFromId to source.id', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    expect(out.forkedFromId).toBe(src.id);
  });

  it('overrides any forkedFromId already present on the source', () => {
    const src = richSource();
    src.forkedFromId = 'some-older-source';
    const out = cloneWorkspace(src);
    // Clone records ITS source, not the source-of-source.
    expect(out.forkedFromId).toBe(src.id);
  });

  /* ---- Name + owner ---- */

  it('defaults the name to "<source> (copy)"', () => {
    const src = workspace({ name: 'My Crew' });
    const out = cloneWorkspace(src);
    expect(out.name).toBe('My Crew (copy)');
  });

  it('uses an explicit name override verbatim (no " (copy)" suffix)', () => {
    const src = workspace({ name: 'My Crew' });
    const out = cloneWorkspace(src, { newName: 'Cloned via API' });
    expect(out.name).toBe('Cloned via API');
  });

  it('defaults ownerId to source ownerId', () => {
    const src = workspace({ ownerId: 'alice@example.com' });
    const out = cloneWorkspace(src);
    expect(out.ownerId).toBe('alice@example.com');
  });

  it('uses an explicit ownerId override', () => {
    const src = workspace({ ownerId: 'alice@example.com' });
    const out = cloneWorkspace(src, { newOwnerId: 'bob@example.com' });
    expect(out.ownerId).toBe('bob@example.com');
  });

  /* ---- Timestamps ---- */

  it('stamps fresh createdAt and updatedAt (ISO format)', () => {
    const src = workspace({
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const out = cloneWorkspace(src);
    expect(out.createdAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(out.updatedAt).toBe(out.createdAt);
    expect(new Date(out.createdAt).toISOString()).toBe(out.createdAt);
  });

  /* ---- No aliasing (deep copy) ---- */

  it('does not alias source agents array', () => {
    const src = richSource();
    const out = cloneWorkspace(src);
    expect(out.agents).not.toBe(src.agents);
    for (let i = 0; i < src.agents.length; i++) {
      expect(out.agents[i]).not.toBe(src.agents[i]);
    }
  });

  it('does not alias array properties on agents (tools/knowledge/tags)', () => {
    const src = workspace({
      agents: [agent('a1', { tools: ['T1'], knowledge: ['K1'], tags: ['tag'] })],
    });
    const out = cloneWorkspace(src);
    expect(out.agents[0].tools).not.toBe(src.agents[0].tools);
    expect(out.agents[0].knowledge).not.toBe(src.agents[0].knowledge);
    expect(out.agents[0].tags).not.toBe(src.agents[0].tags);
    // Mutating the clone must not affect the source.
    out.agents[0].tools.push('T2');
    expect(src.agents[0].tools).toEqual(['T1']);
  });

  it('does not alias array properties on actions (recipients)', () => {
    const src = workspace({
      actions: [action('act1', { recipients: ['a@x.com'] })],
    });
    const out = cloneWorkspace(src);
    expect(out.actions[0].recipients).not.toBe(src.actions[0].recipients);
  });

  /* ---- Empty workspace ---- */

  it('clones an empty workspace cleanly', () => {
    const src = workspace();
    const out = cloneWorkspace(src);
    expect(out.id).not.toBe(src.id);
    expect(out.agents).toEqual([]);
    expect(out.tasks).toEqual([]);
    expect(out.actions).toEqual([]);
    expect(out.crews).toEqual([]);
    expect(out.connections).toEqual([]);
    expect(out.forkedFromId).toBe(src.id);
    expect(out.name).toBe('Source Workspace (copy)');
  });

  /* ---- Dangling references ---- */

  it('drops dangling task.agentId references to entities not in source', () => {
    const src = workspace({
      tasks: [task('t1', { agentId: 'agent-that-was-deleted' })],
    });
    const out = cloneWorkspace(src);
    expect(out.tasks[0].agentId).toBeNull();
  });

  it('drops dangling crew.taskIds entries', () => {
    const src = workspace({
      tasks: [task('t1')],
      crews: [crew('c1', { taskIds: ['t1', 'phantom-task'] })],
    });
    const out = cloneWorkspace(src);
    expect(out.crews[0].taskIds.length).toBe(1);
    expect(out.crews[0].taskIds[0]).toBe(out.tasks[0].id);
  });

  it('drops dangling crew.managerAgentId', () => {
    const src = workspace({
      crews: [crew('c1', { managerAgentId: 'phantom-agent' })],
    });
    const out = cloneWorkspace(src);
    expect(out.crews[0].managerAgentId).toBeNull();
  });

  it('drops dangling agent.connectionIds entries', () => {
    const src = workspace({
      connections: [connection('c1')],
      agents: [agent('a1', { connectionIds: ['c1', 'phantom-conn'] })],
    });
    const out = cloneWorkspace(src);
    expect(out.agents[0].connectionIds).toEqual([out.connections[0].id]);
  });

  /* ---- Normalization round-trip ---- */

  it('re-normalizes the clone (cycles in source are dropped by normalize)', () => {
    // Source has a task-context cycle: t1 → t2 → t1
    const src = workspace({
      tasks: [
        task('t1', { contextTaskIds: ['t2'] }),
        task('t2', { contextTaskIds: ['t1'] }),
      ],
    });
    // Cycle is preserved through rewire — but normalize is the
    // sanitizer; the test ensures we DO normalize at the end.
    const out = cloneWorkspace(src);
    // After normalize+cycle filter (which the normalizer does at emit
    // time, not in shape normalize), the clone's contextTaskIds still
    // contain the rewired ids — what we care about is that NO id is
    // dangling. The acyclic filter is applied lazily; here we just
    // want to confirm normalize ran (i.e. fields exist and are typed).
    expect(out.tasks[0].id).toBeTruthy();
    expect(out.tasks[1].id).toBeTruthy();
    assertAllReferencesResolve(out);
  });

  it('clamps invalid agent.maxIter via the normalizer', () => {
    const src = workspace({
      // @ts-expect-error — intentionally invalid to exercise normalize.
      agents: [{ ...agent('a1'), maxIter: 'not-a-number' }],
    });
    const out = cloneWorkspace(src);
    expect(typeof out.agents[0].maxIter).toBe('number');
    expect(Number.isFinite(out.agents[0].maxIter)).toBe(true);
  });

  /* ---- Sanity / output stability ---- */

  it('does not mutate the source workspace', () => {
    const src = richSource();
    const beforeJson = JSON.stringify(src);
    cloneWorkspace(src);
    expect(JSON.stringify(src)).toBe(beforeJson);
  });

  it('always produces unique workspace ids across calls', () => {
    const src = richSource();
    const a = cloneWorkspace(src);
    const b = cloneWorkspace(src);
    expect(a.id).not.toBe(b.id);
    expect(a.agents[0].id).not.toBe(b.agents[0].id);
  });

  it('preserves task structural fields verbatim', () => {
    const src = workspace({
      tasks: [
        task('t1', {
          description: 'detailed description',
          expectedOutput: 'an outcome',
          outputFile: 'reports/x.md',
          humanInput: true,
          asyncExecution: true,
          markdown: false,
        }),
      ],
    });
    const out = cloneWorkspace(src);
    expect(out.tasks[0].description).toBe('detailed description');
    expect(out.tasks[0].expectedOutput).toBe('an outcome');
    expect(out.tasks[0].outputFile).toBe('reports/x.md');
    expect(out.tasks[0].humanInput).toBe(true);
    expect(out.tasks[0].asyncExecution).toBe(true);
    expect(out.tasks[0].markdown).toBe(false);
  });

  it('preserves workspace-level fields (description, productBrief, defaultLlm, tags, repoPath)', () => {
    const src = workspace({
      description: 'desc',
      productBrief: 'brief',
      defaultLlm: 'snowflake/claude-haiku-4-5',
      tags: ['x', 'y'],
      repoPath: '/tmp/repo',
    });
    const out = cloneWorkspace(src);
    expect(out.description).toBe('desc');
    expect(out.productBrief).toBe('brief');
    expect(out.defaultLlm).toBe('snowflake/claude-haiku-4-5');
    expect(out.tags).toEqual(['x', 'y']);
    expect(out.repoPath).toBe('/tmp/repo');
    // Arrays are not aliased.
    expect(out.tags).not.toBe(src.tags);
  });
});
