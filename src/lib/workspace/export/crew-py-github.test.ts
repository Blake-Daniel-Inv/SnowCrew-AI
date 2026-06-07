// End-to-end check for the GitHub-tool emission path: build a crew.py
// from a workspace with an agent declaring `tools: ['github']` and
// verify (a) the GitHubTool class is inlined, (b) only declaring agents
// get tools=self._github_tools_for(...) wiring, and (c) the resulting
// python source compiles. Pure-python crews are also checked to confirm
// nothing GitHub-related leaks in when no agent uses it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCrewPython } from './crew-py';
import type { CrewStudioWorkspace } from '@/types';

function makeWorkspace(): CrewStudioWorkspace {
  return {
    id: 'w1',
    ownerId: 'u1',
    repoPath: null,
    name: 'Demo',
    description: '',
    productBrief: '',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: [],
    agents: [
      {
        id: 'a1',
        name: 'Repo Inspector',
        role: 'inspect',
        goal: 'g',
        backstory: 'b',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: false,
        maxIter: 5,
        tools: ['github'],
        knowledge: [],
        connectionIds: [],
        tags: [],
        subCrewToolIds: [],
      },
      {
        id: 'a2',
        name: 'Pure',
        role: 'r',
        goal: 'g',
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
        name: 'Look',
        description: 'd',
        expectedOutput: 'o',
        agentId: 'a1',
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
        id: 'c1',
        name: 'demo',
        description: '',
        process: 'sequential',
        agentIds: ['a1', 'a2'],
        taskIds: ['t1'],
        managerAgentId: null,
        memory: false,
        planning: false,
        verbose: false,
        tags: [],
      },
    ],
    connections: [],
    subCrewInvocations: [],
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: '',
    updatedAt: '',
  };
}

describe('crew-py with GitHub tool agent', () => {
  it('emits GitHubTool class and tools= wiring for declaring agents only', () => {
    const py = buildCrewPython(makeWorkspace());
    // Tool class inlined.
    expect(py).toMatch(/^class GitHubTool\(BaseTool\)/m);
    // Helper emitted.
    expect(py).toMatch(/def _github_tools_for/);
    // The declaring agent gets tools=...
    expect(py).toMatch(
      /def repo_inspector\(self\) -> Agent:[\s\S]*tools=self\._github_tools_for\("repo_inspector"\)/
    );
    // The non-declaring agent has NO tools= argument.
    const pureBlock = py.split('def pure(self) -> Agent:')[1] || '';
    expect(pureBlock).not.toMatch(/tools=self\._github_tools_for/);
  });

  it('does NOT emit GitHubTool when no agent declares the tool', () => {
    const ws = makeWorkspace();
    ws.agents[0].tools = [];
    const py = buildCrewPython(ws);
    expect(py).not.toMatch(/class GitHubTool\(BaseTool\)/);
    expect(py).not.toMatch(/_github_tools_for/);
  });

  it('emits crew.py that compiles as valid Python (skipped if python3 unavailable)', () => {
    const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      console.warn('[__pr3-integration] python3 not available; compile check skipped');
      return;
    }
    const py = buildCrewPython(makeWorkspace());
    const dir = mkdtempSync(path.join(tmpdir(), 'pr3-crew-'));
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
