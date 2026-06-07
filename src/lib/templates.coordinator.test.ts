// PR 21: integration tests for the Coordinator template.
//
// The coordinator template is the canonical sub-crew demo that ships
// with PR 21. It must:
//   - Produce a 4-crew workspace (Coordinator + Research + Review +
//     Implementation).
//   - Wire exactly three SubCrewInvocations, one per specialist crew.
//   - Have a single coordinator agent that references all three
//     invocations via subCrewToolIds.
//   - Survive normalize without dropping any invocation (no orphan
//     refs) and without pruning any of the coordinator's tool ids
//     (the topology is a DAG, not a cycle).
//   - Validate cleanly: no `subcrew_orphaned`, `subcrew_dangling_ref`,
//     or `subcrew_cycle` issues.

import { describe, expect, it } from 'vitest';
import { buildFromTemplate } from './templates';
import { validateWorkspace } from './validation';

describe('coordinator template', () => {
  it('builds a workspace with 4 crews and 3 sub-crew invocations', () => {
    const ws = buildFromTemplate('coordinator');
    expect(ws.crews.length).toBe(4);
    expect(ws.subCrewInvocations.length).toBe(3);
  });

  it('wires the coordinator agent to all three sub-crew tool ids', () => {
    const ws = buildFromTemplate('coordinator');
    const coordinator = ws.agents.find((a) => a.name === 'project_coordinator');
    expect(coordinator).toBeTruthy();
    expect(coordinator?.subCrewToolIds.length).toBe(3);
    // Every tool id must point at a real invocation after normalize.
    const invIds = new Set(ws.subCrewInvocations.map((i) => i.id));
    for (const toolId of coordinator!.subCrewToolIds) {
      expect(invIds.has(toolId)).toBe(true);
    }
  });

  it('targets the three specialist crews, not the coordinator crew', () => {
    const ws = buildFromTemplate('coordinator');
    const coordCrew = ws.crews.find((c) => c.name === 'coordinator_crew');
    expect(coordCrew).toBeTruthy();
    for (const inv of ws.subCrewInvocations) {
      expect(inv.targetCrewId).not.toBe(coordCrew?.id);
    }
    const targetNames = new Set(
      ws.subCrewInvocations
        .map((inv) => ws.crews.find((c) => c.id === inv.targetCrewId)?.name)
        .filter(Boolean)
    );
    expect(targetNames.has('research_crew')).toBe(true);
    expect(targetNames.has('review_crew')).toBe(true);
    expect(targetNames.has('implementation_crew')).toBe(true);
  });

  it('passes validation with no sub-crew issues', () => {
    const ws = buildFromTemplate('coordinator');
    const issues = validateWorkspace(ws);
    const subcrewCodes = issues
      .map((i) => i.code)
      .filter((c) => c.startsWith('subcrew_'));
    expect(subcrewCodes).toEqual([]);
  });
});
