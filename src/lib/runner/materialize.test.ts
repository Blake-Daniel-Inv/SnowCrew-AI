// PR γ — focused materialize() test for the subcrew_tool.py write.
//
// PR α set bundle.subcrewToolPython on workspaces that declare sub-crew
// invocations. PR γ closes the loop by writing that file to the
// materialized run directory so the generated crew.py's inlined
// SubCrewTool class has its filesystem twin.
//
// We assert:
//   1. A workspace WITH invocations gets subcrew_tool.py on disk.
//   2. A workspace WITHOUT invocations does NOT (no dead file).
//   3. The file contents match the bundle (no truncation / corruption).

import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { materializeRun } from './materialize';
import { buildCrewStudioExportBundle } from '@/lib/workspace/export';
import type { CrewStudioWorkspace } from '@/types';

function makeWorkspace(opts: { withSubCrew: boolean }): CrewStudioWorkspace {
  return {
    id: 'ws-1',
    ownerId: 'u1',
    repoPath: null,
    name: 'demo',
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
        subCrewToolIds: opts.withSubCrew ? ['inv1'] : [],
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
    ],
    actions: [],
    crews: [
      {
        id: 'coord',
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
        id: 'research',
        name: 'research',
        description: '',
        process: 'sequential',
        agentIds: [],
        taskIds: [],
        managerAgentId: null,
        memory: false,
        planning: false,
        verbose: false,
        tags: [],
      },
    ],
    connections: [],
    subCrewInvocations: opts.withSubCrew
      ? [
          {
            id: 'inv1',
            name: 'Research lookup',
            description: 'd',
            targetCrewId: 'research',
            maxInvocations: 3,
            inputMapping: '',
            successCriteria: null,
            contextMode: 'isolated',
            tags: [],
          },
        ]
      : [],
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: '',
    updatedAt: '',
  };
}

describe('materializeRun — subcrew_tool.py (PR γ)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    tmpDirs.length = 0;
  });

  it('writes subcrew_tool.py when bundle.subcrewToolPython is present', () => {
    const ws = makeWorkspace({ withSubCrew: true });
    const dir = materializeRun('run-pr-gamma-1', ws, {});
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'subcrew_tool.py');
    expect(existsSync(filePath)).toBe(true);
    const contents = readFileSync(filePath, 'utf-8');
    // Spot-check the bundle round-trip.
    expect(contents).toContain('class SubCrewTool(BaseTool)');
    expect(contents).toContain('MAX_NESTING_DEPTH');
  });

  it('does NOT write subcrew_tool.py when no invocations exist', () => {
    const ws = makeWorkspace({ withSubCrew: false });
    const dir = materializeRun('run-pr-gamma-2', ws, {});
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'subcrew_tool.py');
    expect(existsSync(filePath)).toBe(false);
  });

  it('writes the exact bundle contents byte-for-byte', () => {
    const ws = makeWorkspace({ withSubCrew: true });
    const bundle = buildCrewStudioExportBundle(ws);
    expect(bundle.subcrewToolPython).toBeDefined();
    const dir = materializeRun('run-pr-gamma-3', ws, {});
    tmpDirs.push(dir);
    const onDisk = readFileSync(path.join(dir, 'subcrew_tool.py'), 'utf-8');
    expect(onDisk).toBe(bundle.subcrewToolPython);
  });
});
