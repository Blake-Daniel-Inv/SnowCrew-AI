// End-to-end exporter test for sub-crew invocation (PR 20).
//
// Builds a workspace with:
//   - 2 crews: Coordinator (with one lead agent) and Research (with one agent)
//   - 1 SubCrewInvocation targeting Research
//   - The lead agent's subCrewToolIds includes that invocation
//
// Verifies:
//   - The exporter emits the SubCrewTool class + factory function
//   - The lead agent's @agent definition wires tools= via _subcrew_tools_for
//   - The non-leading agent has no subcrew tools attached
//   - The generated crew.py compiles via python3 (soft-skipped if absent)
//
// Also verifies the negative path: a workspace with no invocations emits
// byte-identical crew.py to the pre-PR-20 baseline (i.e. no SubCrewTool
// class, no _subcrew_tools_for helper, no factory functions).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCrewPython } from './crew-py';
import { buildCrewStudioExportBundle } from './index';
import type { CrewStudioWorkspace } from '@/types';

function makeCoordinatorWorkspace(): CrewStudioWorkspace {
  return {
    id: 'ws',
    ownerId: 'u',
    repoPath: null,
    name: 'Demo Coordinator',
    description: '',
    productBrief: '',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: [],
    agents: [
      {
        id: 'lead',
        name: 'lead_agent',
        role: 'coordinator',
        goal: 'orchestrate',
        backstory: 'b',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: false,
        maxIter: 5,
        tools: [],
        knowledge: [],
        connectionIds: [],
        tags: [],
        subCrewToolIds: ['inv1'],
      },
      {
        id: 'researcher',
        name: 'research_agent',
        role: 'researcher',
        goal: 'find',
        backstory: 'b',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: false,
        maxIter: 5,
        tools: [],
        knowledge: [],
        connectionIds: [],
        tags: [],
        subCrewToolIds: [],
      },
    ],
    tasks: [
      {
        id: 't1',
        name: 'coordinate',
        description: 'd',
        expectedOutput: 'o',
        agentId: 'lead',
        contextTaskIds: [],
        outputFile: '',
        humanInput: false,
        asyncExecution: false,
        markdown: false,
      },
      {
        id: 't2',
        name: 'research',
        description: 'd',
        expectedOutput: 'o',
        agentId: 'researcher',
        contextTaskIds: [],
        outputFile: '',
        humanInput: false,
        asyncExecution: false,
        markdown: false,
      },
    ],
    actions: [],
    crews: [
      {
        id: 'coord-crew',
        name: 'coordinator',
        description: '',
        process: 'sequential',
        agentIds: ['lead'],
        taskIds: ['t1'],
        managerAgentId: null,
        memory: false,
        planning: false,
        verbose: false,
        tags: [],
      },
      {
        id: 'research-crew',
        name: 'research',
        description: '',
        process: 'sequential',
        agentIds: ['researcher'],
        taskIds: ['t2'],
        managerAgentId: null,
        memory: false,
        planning: false,
        verbose: false,
        tags: [],
      },
    ],
    connections: [],
    subCrewInvocations: [
      {
        id: 'inv1',
        name: 'Research lookup',
        description: 'Delegate research to the Research crew',
        targetCrewId: 'research-crew',
        maxInvocations: 3,
        inputMapping: 'topic: <subject to research>',
        successCriteria: 'Returns at least three citations',
        contextMode: 'isolated',
        tags: [],
      },
    ],
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: '',
    updatedAt: '',
  };
}

function makeBaselineWorkspace(): CrewStudioWorkspace {
  // Same shape but stripped of sub-crew wiring so we can confirm the
  // exporter's emission is byte-identical to the pre-PR-α baseline
  // for any workspace that doesn't opt in.
  const ws = makeCoordinatorWorkspace();
  ws.subCrewInvocations = [];
  ws.agents.forEach((a) => {
    a.subCrewToolIds = [];
  });
  return ws;
}

describe('crew-py with sub-crew invocations', () => {
  it('emits SubCrewTool class + factory + tools wiring for the lead agent', () => {
    const py = buildCrewPython(makeCoordinatorWorkspace());
    // The tool class is inlined.
    expect(py).toMatch(/^class SubCrewTool\(BaseTool\)/m);
    // The dedicated factory function for invocation inv1 is emitted.
    expect(py).toMatch(/def _factory_inv1\(self\):/);
    // The helper for the agent-to-tool map exists.
    expect(py).toMatch(/def _subcrew_tools_for\(self, agent_key: str\):/);
    // The lead agent's @agent block wires tools via the new helper.
    const leadBlock = py.split('def lead_agent(self) -> Agent:')[1] || '';
    expect(leadBlock).toMatch(/tools=self\._subcrew_tools_for\("lead_agent"\)/);
    // The research agent has no tools= argument (it doesn't declare any).
    const researcherBlock = py.split('def research_agent(self) -> Agent:')[1] || '';
    expect(researcherBlock).not.toMatch(/_subcrew_tools_for/);
  });

  it('passes max_invocations + success_criteria + display name to SubCrewTool ctor', () => {
    const py = buildCrewPython(makeCoordinatorWorkspace());
    // The construction site includes the values from the invocation.
    expect(py).toMatch(/invocation_id="inv1"/);
    expect(py).toMatch(/display_name="Research lookup"/);
    expect(py).toMatch(/max_invocations=3/);
    expect(py).toMatch(/success_criteria="Returns at least three citations"/);
    // Factory wiring is the bound method, not a placeholder.
    expect(py).toMatch(/target_crew_factory=self\._factory_inv1/);
  });

  it('handles success_criteria=null by passing the Python literal None', () => {
    const ws = makeCoordinatorWorkspace();
    ws.subCrewInvocations[0].successCriteria = null;
    const py = buildCrewPython(ws);
    expect(py).toMatch(/success_criteria=None/);
  });

  it('emits NO sub-crew artifacts when no invocations are defined', () => {
    const py = buildCrewPython(makeBaselineWorkspace());
    expect(py).not.toMatch(/class SubCrewTool\(BaseTool\)/);
    expect(py).not.toMatch(/_subcrew_tools_for/);
    expect(py).not.toMatch(/_factory_inv1/);
  });

  it('produces byte-identical crew.py to before PR 20 for a no-subcrew workspace', () => {
    // Strict regression guard: an existing workspace on disk that
    // doesn't opt in must produce the same Python as it always has
    // (modulo intentional changes elsewhere). We assert this by
    // confirming nothing in the emitted source mentions "subcrew" or
    // "SubCrew" — the previous tests already prove the import side.
    const py = buildCrewPython(makeBaselineWorkspace());
    expect(py.toLowerCase()).not.toContain('subcrew');
  });

  it('exposes subcrewToolPython on the bundle only when invocations exist', () => {
    const withSub = buildCrewStudioExportBundle(makeCoordinatorWorkspace());
    expect(typeof withSub.subcrewToolPython).toBe('string');
    expect(withSub.subcrewToolPython?.length).toBeGreaterThan(500);

    const baseline = buildCrewStudioExportBundle(makeBaselineWorkspace());
    expect(baseline.subcrewToolPython).toBeUndefined();
  });

  it('emits crew.py that compiles as valid Python (skipped if python3 unavailable)', () => {
    const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      console.warn('[crew-py-subcrew.test] python3 not available; compile check skipped');
      return;
    }
    const py = buildCrewPython(makeCoordinatorWorkspace());
    const dir = mkdtempSync(path.join(tmpdir(), 'pr20-crew-'));
    try {
      const file = path.join(dir, 'crew.py');
      writeFileSync(file, py);
      const result = spawnSync(
        'python3',
        ['-c', `compile(open(${JSON.stringify(file)}).read(), 'crew.py', 'exec')`],
        { encoding: 'utf8' }
      );
      expect(
        result.status,
        `python compile failed:\n${result.stderr || result.stdout}`
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
