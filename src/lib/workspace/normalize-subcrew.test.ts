// PR 20: tests for the sub-crew additions to normalize.ts.
//
// What we're protecting:
//   - normalizeSubCrewInvocation clamps + defaults the way the design
//     doc promises (1..MAX cap, default 3, contextMode forced isolated).
//   - normalizeCrewStudioWorkspace filters orphan invocations whose
//     targetCrewId no longer exists in the workspace.
//   - normalizeCrewStudioWorkspace + pruneSubCrewToolIdsOnAgents drop
//     dangling agent.subCrewToolIds entries.
//   - filterAcyclicSubCrewToolIds catches a direct 2-crew cycle
//     (crew A's lead invokes crew B; B's lead would invoke A back).
//   - filterAcyclicSubCrewToolIds catches a self-cycle (lead in crew A
//     tries to invoke crew A itself).
//   - Backwards compat: a workspace blob with no subCrewInvocations /
//     subCrewToolIds fields normalizes to empty arrays without errors.

import { describe, expect, it } from 'vitest';
import {
  filterAcyclicSubCrewToolIds,
  normalizeCrewStudioWorkspace as _norm,
  normalizeSubCrewInvocation,
} from './normalize';
import { SUBCREW_LIMITS } from '@/lib/schemas/field-limits';
import type { CrewStudioWorkspace, SubCrewInvocation } from '@/types';

// Wrapper that lets tests pass deeply-partial inputs without filling in
// every required field on every fixture. The real exporter pipeline
// only invokes normalize on data from the wire (already-validated by
// Zod) so this cast is test-only sugar.
const normalizeCrewStudioWorkspace = (
  ws: Parameters<typeof _norm>[0],
) => _norm(ws as unknown as Parameters<typeof _norm>[0]);

describe('normalizeSubCrewInvocation', () => {
  it('fills defaults for every missing field', () => {
    const inv = normalizeSubCrewInvocation({});
    expect(inv.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inv.name).toBe('Sub-crew invocation');
    expect(inv.description).toBe('');
    expect(inv.targetCrewId).toBe('');
    expect(inv.maxInvocations).toBe(SUBCREW_LIMITS.DEFAULT_INVOCATIONS);
    expect(inv.inputMapping).toBe('');
    expect(inv.successCriteria).toBeNull();
    expect(inv.contextMode).toBe('isolated');
    expect(inv.tags).toEqual([]);
  });

  it('clamps maxInvocations to 1..MAX', () => {
    expect(normalizeSubCrewInvocation({ maxInvocations: 0 }).maxInvocations).toBe(
      SUBCREW_LIMITS.DEFAULT_INVOCATIONS
    );
    expect(normalizeSubCrewInvocation({ maxInvocations: 999 }).maxInvocations).toBe(
      SUBCREW_LIMITS.MAX_INVOCATIONS_PER_BOX
    );
    expect(normalizeSubCrewInvocation({ maxInvocations: 4 }).maxInvocations).toBe(4);
  });

  it('forces contextMode to isolated even when smuggled', () => {
    const smuggled = { contextMode: 'shared' } as unknown as Partial<SubCrewInvocation>;
    expect(normalizeSubCrewInvocation(smuggled).contextMode).toBe('isolated');
  });

  it('treats blank-string successCriteria as null', () => {
    expect(normalizeSubCrewInvocation({ successCriteria: '   ' }).successCriteria).toBeNull();
    expect(normalizeSubCrewInvocation({ successCriteria: 'ok' }).successCriteria).toBe('ok');
  });
});

describe('normalizeCrewStudioWorkspace — subcrew handling', () => {
  it('returns empty arrays for a workspace blob with no subcrew fields', () => {
    const ws = normalizeCrewStudioWorkspace({} as unknown as Parameters<typeof _norm>[0]);
    expect(ws.subCrewInvocations).toEqual([]);
    for (const agent of ws.agents) {
      expect(agent.subCrewToolIds).toEqual([]);
    }
  });

  it('drops invocations whose targetCrewId points at a missing crew', () => {
    const ws = normalizeCrewStudioWorkspace({
      crews: [{ id: 'real-crew', name: 'r', agentIds: [], taskIds: [] }],
      subCrewInvocations: [
        { id: 'inv1', name: 'good', targetCrewId: 'real-crew' },
        { id: 'inv2', name: 'orphan', targetCrewId: 'ghost-crew' },
      ],
    } as unknown as Parameters<typeof _norm>[0]);
    expect(ws.subCrewInvocations.map((i) => i.id)).toEqual(['inv1']);
  });

  it('drops dangling agent.subCrewToolIds (point at no longer present invocation)', () => {
    // Two crews: agent a1 belongs to source-crew, the invocation targets
    // target-crew (avoiding the self-loop case which is exercised in the
    // filterAcyclicSubCrewToolIds suite below).
    const ws = normalizeCrewStudioWorkspace({
      agents: [
        {
          id: 'a1',
          name: 'lead',
          subCrewToolIds: ['inv-real', 'inv-ghost'],
        },
      ],
      crews: [
        { id: 'source-crew', name: 's', agentIds: ['a1'], taskIds: [] },
        { id: 'target-crew', name: 't', agentIds: [], taskIds: [] },
      ],
      subCrewInvocations: [
        { id: 'inv-real', name: 'good', targetCrewId: 'target-crew' },
      ],
    } as unknown as Parameters<typeof _norm>[0]);
    expect(ws.agents[0].subCrewToolIds).toEqual(['inv-real']);
  });

  it('clears every agent subCrewToolIds when no invocations exist', () => {
    const ws = normalizeCrewStudioWorkspace({
      agents: [
        {
          id: 'a1',
          name: 'lead',
          subCrewToolIds: ['some-id'],
        },
      ],
      // Note: no subCrewInvocations.
    } as unknown as Parameters<typeof _norm>[0]);
    expect(ws.agents[0].subCrewToolIds).toEqual([]);
  });
});

describe('filterAcyclicSubCrewToolIds', () => {
  function makeTwoCrewWorkspace(opts: {
    invocations: Array<{ id: string; targetCrewId: string }>;
    agentATools: string[];
    agentBTools: string[];
  }): CrewStudioWorkspace {
    return normalizeCrewStudioWorkspace({
      agents: [
        { id: 'agentA', name: 'lead-a', subCrewToolIds: opts.agentATools },
        { id: 'agentB', name: 'lead-b', subCrewToolIds: opts.agentBTools },
      ],
      crews: [
        { id: 'crewA', name: 'A', agentIds: ['agentA'], taskIds: [] },
        { id: 'crewB', name: 'B', agentIds: ['agentB'], taskIds: [] },
      ],
      subCrewInvocations: opts.invocations.map((i) => ({
        id: i.id,
        name: i.id,
        targetCrewId: i.targetCrewId,
        // sensible defaults to clear the schema cap
        maxInvocations: 3,
      })),
    } as unknown as Parameters<typeof _norm>[0]);
  }

  it('flags a 2-crew cycle (A→B, B→A)', () => {
    // Build the half cycle (A→B), then ask filter what happens if we try
    // to add the back edge B→A to agentB.
    const ws = makeTwoCrewWorkspace({
      invocations: [
        { id: 'invAB', targetCrewId: 'crewB' },
        { id: 'invBA', targetCrewId: 'crewA' },
      ],
      agentATools: ['invAB'],
      agentBTools: [], // start without the back-edge
    });
    // Now ask: if agentB tries to subscribe to invBA, would it cycle?
    const kept = filterAcyclicSubCrewToolIds(ws, 'agentB', ['invBA']);
    expect(kept).toEqual([]);
  });

  it('allows a non-cycling addition (A→B with no back edge)', () => {
    const ws = makeTwoCrewWorkspace({
      invocations: [{ id: 'invAB', targetCrewId: 'crewB' }],
      agentATools: [],
      agentBTools: [],
    });
    const kept = filterAcyclicSubCrewToolIds(ws, 'agentA', ['invAB']);
    expect(kept).toEqual(['invAB']);
  });

  it('flags a self-loop (agent in crewA invokes crewA)', () => {
    const ws = makeTwoCrewWorkspace({
      invocations: [{ id: 'invSelf', targetCrewId: 'crewA' }],
      agentATools: [],
      agentBTools: [],
    });
    const kept = filterAcyclicSubCrewToolIds(ws, 'agentA', ['invSelf']);
    expect(kept).toEqual([]);
  });

  it('drops dangling references (id with no matching invocation)', () => {
    const ws = makeTwoCrewWorkspace({
      invocations: [{ id: 'invReal', targetCrewId: 'crewB' }],
      agentATools: [],
      agentBTools: [],
    });
    const kept = filterAcyclicSubCrewToolIds(ws, 'agentA', ['invReal', 'invGhost']);
    expect(kept).toEqual(['invReal']);
  });

  it('dedupes repeated candidates', () => {
    const ws = makeTwoCrewWorkspace({
      invocations: [{ id: 'invAB', targetCrewId: 'crewB' }],
      agentATools: [],
      agentBTools: [],
    });
    const kept = filterAcyclicSubCrewToolIds(ws, 'agentA', ['invAB', 'invAB']);
    expect(kept).toEqual(['invAB']);
  });
});
