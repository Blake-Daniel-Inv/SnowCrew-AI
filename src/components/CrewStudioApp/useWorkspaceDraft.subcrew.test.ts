// PR 21: tests for the sub-crew CRUD additions in useWorkspaceDraft.
//
// These exercise the pure-shape behaviour of:
//   - createBlankSubCrewInvocation
// and the cascade-side-effects we wired into the existing handlers:
//   - removeCrew also drops invocations whose targetCrewId pointed at
//     that crew (so the canvas doesn't keep painting an orphan after
//     the source crew is gone).
//   - removeSubCrewInvocation also drops dangling subCrewToolIds on
//     every agent (the picker UI stays in sync without waiting for
//     save-time normalize).
//
// We can't easily render-test the hook here (it needs the surrounding
// app), so this file exercises the imperative shape via fresh inputs
// into normalize + the small helper logic. The hook itself is covered
// indirectly by the existing CrewStudioApp integration smoke tests.

import { describe, expect, it } from 'vitest';
import { normalizeCrewStudioWorkspace } from '@/lib/workspace/normalize';
import { SUBCREW_LIMITS } from '@/lib/schemas/field-limits';

describe('PR 21 — sub-crew CRUD shape contracts', () => {
  it('a fresh blank invocation defaults pass normalize unchanged', () => {
    // Mirrors `createBlankSubCrewInvocation` output shape.
    const ws = normalizeCrewStudioWorkspace({
      crews: [{ id: 'crew-x', name: 'x', agentIds: [], taskIds: [] }],
      subCrewInvocations: [
        {
          id: 'inv-fresh',
          name: 'New sub-crew',
          description: '',
          targetCrewId: 'crew-x',
          maxInvocations: SUBCREW_LIMITS.DEFAULT_INVOCATIONS,
          inputMapping: '',
          successCriteria: null,
          contextMode: 'isolated',
          tags: [],
        },
      ],
    } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
    expect(ws.subCrewInvocations).toHaveLength(1);
    expect(ws.subCrewInvocations[0].maxInvocations).toBe(
      SUBCREW_LIMITS.DEFAULT_INVOCATIONS
    );
    expect(ws.subCrewInvocations[0].contextMode).toBe('isolated');
  });

  it('removing a crew should orphan invocations targeting it (validated by normalize cascade)', () => {
    // After the hook's removeCrew filters, normalize will drop the
    // orphan invocation. The hook also pre-filters eagerly, but this
    // test guards the post-normalize endpoint.
    const ws = normalizeCrewStudioWorkspace({
      crews: [{ id: 'survivor', name: 's', agentIds: [], taskIds: [] }],
      subCrewInvocations: [
        { id: 'orphan', name: 'orphan', targetCrewId: 'deleted-crew' },
      ],
    } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
    expect(ws.subCrewInvocations).toHaveLength(0);
  });

  it('removing an invocation should orphan agent.subCrewToolIds entries', () => {
    // After the hook's removeSubCrewInvocation drops the dangling
    // refs, normalize-on-save would do the same. This guards the
    // post-normalize endpoint.
    const ws = normalizeCrewStudioWorkspace({
      agents: [{ id: 'agent-a', name: 'a', subCrewToolIds: ['inv-gone'] }],
      crews: [
        { id: 'source-crew', name: 's', agentIds: ['agent-a'], taskIds: [] },
      ],
      // Note: no subCrewInvocations.
    } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
    expect(ws.agents[0].subCrewToolIds).toEqual([]);
  });
});
