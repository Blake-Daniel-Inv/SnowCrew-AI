// PR 23 — Tests for canvas-scope.ts.
//
// What we're protecting:
//   - Fallback semantics: null / unknown crewId returns the full set so the
//     canvas never blanks out when the active-crew anchor goes stale.
//   - Crew-scoped filtering correctly walks agentIds, taskIds, and the
//     transitive references from agents into connections / sub-crew
//     invocations, plus the action.afterTaskId → task linkage.
//   - The filter is PURE: input workspace is not mutated, and the returned
//     arrays don't alias workspace internals (so the caller can mutate them
//     freely).

import { describe, expect, it } from 'vitest';
import { scopeWorkspaceToCrew } from './canvas-scope';
import { normalizeCrewStudioWorkspace } from './normalize';
import type { CrewStudioWorkspace } from '@/types';

// Helper: build a richly-populated multi-crew workspace.
//
// Structure:
//   - crew-lead has agent-lead (which calls sub-crew inv-1 → crew-worker)
//     and task-lead (assigned to agent-lead).
//   - crew-worker has agent-worker + task-worker.
//   - connection-snow is wired to agent-lead only.
//   - connection-unused exists but no agent references it.
//   - action-after-lead fires after task-lead.
//   - action-after-worker fires after task-worker.
//   - action-orphan has afterTaskId=null and should never show in a scoped
//     view (only in the fallback).
function makeMultiCrewWorkspace(): CrewStudioWorkspace {
  return normalizeCrewStudioWorkspace({
    agents: [
      {
        id: 'agent-lead',
        name: 'Lead',
        subCrewToolIds: ['inv-1'],
        connectionIds: ['connection-snow'],
      },
      {
        id: 'agent-worker',
        name: 'Worker',
        subCrewToolIds: [],
        connectionIds: [],
      },
    ],
    tasks: [
      { id: 'task-lead', name: 'lead', agentId: 'agent-lead' },
      { id: 'task-worker', name: 'work', agentId: 'agent-worker' },
    ],
    actions: [
      {
        id: 'action-after-lead',
        name: 'email-after-lead',
        afterTaskId: 'task-lead',
        type: 'email',
        enabled: true,
      },
      {
        id: 'action-after-worker',
        name: 'email-after-worker',
        afterTaskId: 'task-worker',
        type: 'email',
        enabled: true,
      },
      {
        id: 'action-orphan',
        name: 'email-unanchored',
        afterTaskId: null,
        type: 'email',
        enabled: true,
      },
    ],
    connections: [
      { id: 'connection-snow', name: 'snow' },
      { id: 'connection-unused', name: 'unused' },
    ],
    crews: [
      {
        id: 'crew-lead',
        name: 'lead crew',
        agentIds: ['agent-lead'],
        taskIds: ['task-lead'],
      },
      {
        id: 'crew-worker',
        name: 'worker crew',
        agentIds: ['agent-worker'],
        taskIds: ['task-worker'],
      },
    ],
    subCrewInvocations: [
      { id: 'inv-1', name: 'call worker', targetCrewId: 'crew-worker' },
    ],
  } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
}

function emptyWorkspace(): CrewStudioWorkspace {
  return normalizeCrewStudioWorkspace({
    agents: [],
    tasks: [],
    actions: [],
    connections: [],
    crews: [],
    subCrewInvocations: [],
  } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
}

describe('scopeWorkspaceToCrew', () => {
  it('returns the full set when crewId is null (fallback)', () => {
    const ws = makeMultiCrewWorkspace();
    const out = scopeWorkspaceToCrew(ws, null);
    expect(out.agents.map((a) => a.id).sort()).toEqual([
      'agent-lead',
      'agent-worker',
    ]);
    expect(out.tasks.map((t) => t.id).sort()).toEqual([
      'task-lead',
      'task-worker',
    ]);
    expect(out.connections.map((c) => c.id).sort()).toEqual([
      'connection-snow',
      'connection-unused',
    ]);
    expect(out.actions.map((a) => a.id).sort()).toEqual([
      'action-after-lead',
      'action-after-worker',
      'action-orphan',
    ]);
    expect(out.subCrewInvocations.map((i) => i.id)).toEqual(['inv-1']);
  });

  it('returns the full set when crewId does not match any crew (fallback)', () => {
    const ws = makeMultiCrewWorkspace();
    const out = scopeWorkspaceToCrew(ws, 'crew-does-not-exist');
    expect(out.agents).toHaveLength(2);
    expect(out.tasks).toHaveLength(2);
    expect(out.connections).toHaveLength(2);
    expect(out.actions).toHaveLength(3);
    expect(out.subCrewInvocations).toHaveLength(1);
  });

  it('scopes agents and tasks to the active crew only', () => {
    const ws = makeMultiCrewWorkspace();
    const out = scopeWorkspaceToCrew(ws, 'crew-lead');
    expect(out.agents.map((a) => a.id)).toEqual(['agent-lead']);
    expect(out.tasks.map((t) => t.id)).toEqual(['task-lead']);
  });

  it('includes sub-crew invocations that any active-crew agent references', () => {
    const ws = makeMultiCrewWorkspace();
    const leadView = scopeWorkspaceToCrew(ws, 'crew-lead');
    expect(leadView.subCrewInvocations.map((i) => i.id)).toEqual(['inv-1']);
    // The worker crew has no agent referencing inv-1, so it disappears.
    const workerView = scopeWorkspaceToCrew(ws, 'crew-worker');
    expect(workerView.subCrewInvocations).toEqual([]);
  });

  it('includes connections only when referenced by an active-crew agent', () => {
    const ws = makeMultiCrewWorkspace();
    const leadView = scopeWorkspaceToCrew(ws, 'crew-lead');
    expect(leadView.connections.map((c) => c.id)).toEqual(['connection-snow']);
    // connection-unused is filtered out even in the lead view because no
    // agent references it. This matches the rule "only show what's wired".
    expect(
      leadView.connections.some((c) => c.id === 'connection-unused'),
    ).toBe(false);
    const workerView = scopeWorkspaceToCrew(ws, 'crew-worker');
    expect(workerView.connections).toEqual([]);
  });

  it('includes actions only when their afterTaskId is in the active crew', () => {
    const ws = makeMultiCrewWorkspace();
    const leadView = scopeWorkspaceToCrew(ws, 'crew-lead');
    expect(leadView.actions.map((a) => a.id)).toEqual(['action-after-lead']);
    const workerView = scopeWorkspaceToCrew(ws, 'crew-worker');
    expect(workerView.actions.map((a) => a.id)).toEqual([
      'action-after-worker',
    ]);
    // action-orphan (afterTaskId=null) never appears in either scoped view.
    expect(leadView.actions.some((a) => a.id === 'action-orphan')).toBe(false);
    expect(workerView.actions.some((a) => a.id === 'action-orphan')).toBe(
      false,
    );
  });

  it('returns empty arrays for an empty workspace regardless of crewId', () => {
    const ws = emptyWorkspace();
    const fallback = scopeWorkspaceToCrew(ws, null);
    expect(fallback.agents).toEqual([]);
    expect(fallback.tasks).toEqual([]);
    expect(fallback.connections).toEqual([]);
    expect(fallback.actions).toEqual([]);
    expect(fallback.subCrewInvocations).toEqual([]);
    const scoped = scopeWorkspaceToCrew(ws, 'whatever');
    // Unknown crewId → fallback → still empty.
    expect(scoped.agents).toEqual([]);
  });

  it('handles a crew with taskIds but no agentIds (rare but valid)', () => {
    // Edge case: a crew can declare taskIds but no agentIds (e.g., a
    // stub crew under construction). We keep the tasks visible so the
    // user can see what they've placed; agents/connections/subcrews
    // come out empty because none are owned by the crew.
    const ws = normalizeCrewStudioWorkspace({
      agents: [{ id: 'a1', name: 'a', connectionIds: ['c1'], subCrewToolIds: [] }],
      tasks: [{ id: 't1', name: 't', agentId: null }],
      actions: [],
      connections: [{ id: 'c1', name: 'c' }],
      crews: [
        { id: 'crew-empty', name: 'empty', agentIds: [], taskIds: ['t1'] },
      ],
      subCrewInvocations: [],
    } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
    const out = scopeWorkspaceToCrew(ws, 'crew-empty');
    expect(out.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(out.agents).toEqual([]);
    expect(out.connections).toEqual([]);
    expect(out.subCrewInvocations).toEqual([]);
    expect(out.actions).toEqual([]);
  });

  it('does not mutate the input workspace', () => {
    const ws = makeMultiCrewWorkspace();
    const before = JSON.stringify(ws);
    const out = scopeWorkspaceToCrew(ws, 'crew-lead');
    // Mutating the returned arrays must not affect the workspace.
    out.agents.push({ ...out.agents[0], id: 'injected' });
    out.tasks.length = 0;
    expect(JSON.stringify(ws)).toBe(before);
  });

  it('returns arrays that do not alias workspace.agents etc. (fresh copies)', () => {
    const ws = makeMultiCrewWorkspace();
    const out = scopeWorkspaceToCrew(ws, null);
    // Even the fallback returns spread copies, so reference identity
    // differs while element identity is preserved.
    expect(out.agents).not.toBe(ws.agents);
    expect(out.tasks).not.toBe(ws.tasks);
    expect(out.connections).not.toBe(ws.connections);
    expect(out.actions).not.toBe(ws.actions);
    expect(out.subCrewInvocations).not.toBe(ws.subCrewInvocations);
  });
});
