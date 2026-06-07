// PR 21: tests for the cycle-preview logic the SubCrewInvocationEditor
// uses to decorate disabled <option>s in the target-crew dropdown.
//
// The editor calls `wouldCreateSubCrewCycle` against a "what-if"
// workspace built from the current state with a candidate target. We
// don't render the component here (jsdom is heavy and these contracts
// are pure-function); instead we exercise the same predicate against
// fixture workspaces and assert the per-crew cycle map the editor
// would compute.

import { describe, expect, it } from 'vitest';
import {
  formatSubCrewCyclePath,
  wouldCreateSubCrewCycle,
} from '@/lib/workspace/cycle-preview';
import { normalizeCrewStudioWorkspace } from '@/lib/workspace/normalize';
import type { CrewStudioWorkspace } from '@/types';

function build(): CrewStudioWorkspace {
  // crewA's agent calls invAB (target: crewB).
  // crewB's agent currently has no invocations.
  // Adding "target = crewA" to invAB would close a cycle:
  //   crewA → crewA (self-target).
  return normalizeCrewStudioWorkspace({
    agents: [
      { id: 'agentA', name: 'a', subCrewToolIds: ['invAB'] },
      { id: 'agentB', name: 'b', subCrewToolIds: [] },
    ],
    crews: [
      { id: 'crewA', name: 'A', agentIds: ['agentA'], taskIds: [] },
      { id: 'crewB', name: 'B', agentIds: ['agentB'], taskIds: [] },
    ],
    subCrewInvocations: [
      { id: 'invAB', name: 'A→B', targetCrewId: 'crewB', maxInvocations: 3 },
    ],
  } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
}

describe('SubCrewInvocationEditor — target-dropdown cycle preview (PR 21)', () => {
  it('flags a cycle when re-targeting an invocation back at its owner crew', () => {
    const ws = build();
    // Simulate: user changes invAB.targetCrewId from crewB to crewA.
    const probe: CrewStudioWorkspace = {
      ...ws,
      subCrewInvocations: ws.subCrewInvocations.map((i) =>
        i.id === 'invAB' ? { ...i, targetCrewId: 'crewA' } : i
      ),
    };
    const preview = wouldCreateSubCrewCycle(probe, 'agentA', 'invAB');
    expect(preview.wouldCycle).toBe(true);
  });

  it('does not flag a cycle for a benign re-target', () => {
    const ws = build();
    // crewB exists but agentA's invocation already targets crewB —
    // re-pointing at crewB is a no-op.
    const preview = wouldCreateSubCrewCycle(ws, 'agentA', 'invAB');
    expect(preview.wouldCycle).toBe(false);
  });

  it('formatSubCrewCyclePath labels nodes with crew names where available', () => {
    const ws = build();
    const probe: CrewStudioWorkspace = {
      ...ws,
      subCrewInvocations: ws.subCrewInvocations.map((i) =>
        i.id === 'invAB' ? { ...i, targetCrewId: 'crewA' } : i
      ),
    };
    const preview = wouldCreateSubCrewCycle(probe, 'agentA', 'invAB');
    if (!preview.wouldCycle) throw new Error('expected cycle');
    const formatted = formatSubCrewCyclePath(probe, preview.cyclePath);
    expect(formatted).toContain('A');
  });
});
