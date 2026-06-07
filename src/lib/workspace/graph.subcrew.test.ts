// PR 21: tests for graph.ts's sub-crew node-kind support.
//
// What we're protecting:
//   - findNodeKind recognizes 'subcrew-<id>' prefixed canvas ids and
//     resolves them to kind 'subcrew' when the id is on the workspace.
//   - findNodeKind also accepts a bare invocation id (validation issue
//     targets and other call-sites hold raw ids without the prefix).
//   - Unrecognized prefixed ids return null instead of misclassifying.
//   - Existing kinds (agent/task/etc.) are unaffected by the change.

import { describe, expect, it } from 'vitest';
import { findNodeKind } from './graph';
import { normalizeCrewStudioWorkspace } from './normalize';

function makeWorkspace() {
  return normalizeCrewStudioWorkspace({
    agents: [{ id: 'agent-a', name: 'a', subCrewToolIds: [] }],
    tasks: [{ id: 'task-a', name: 't', agentId: 'agent-a' }],
    crews: [
      { id: 'crew-source', name: 'source', agentIds: ['agent-a'], taskIds: ['task-a'] },
      { id: 'crew-target', name: 'target', agentIds: [], taskIds: [] },
    ],
    subCrewInvocations: [
      { id: 'inv-1', name: 'call target', targetCrewId: 'crew-target' },
    ],
  } as unknown as Parameters<typeof normalizeCrewStudioWorkspace>[0]);
}

describe('findNodeKind — sub-crew support (PR 21)', () => {
  it('resolves canvas-prefixed subcrew ids to kind subcrew', () => {
    const ws = makeWorkspace();
    expect(findNodeKind(ws, 'subcrew-inv-1')).toBe('subcrew');
  });

  it('resolves bare invocation ids to kind subcrew', () => {
    const ws = makeWorkspace();
    expect(findNodeKind(ws, 'inv-1')).toBe('subcrew');
  });

  it('returns null for a prefixed id that does not match any invocation', () => {
    const ws = makeWorkspace();
    expect(findNodeKind(ws, 'subcrew-does-not-exist')).toBeNull();
  });

  it('keeps existing kinds intact', () => {
    const ws = makeWorkspace();
    expect(findNodeKind(ws, 'agent-a')).toBe('agent');
    expect(findNodeKind(ws, 'task-a')).toBe('task');
    expect(findNodeKind(ws, 'crew-source')).toBe('crew');
    expect(findNodeKind(ws, 'trigger')).toBe('trigger');
    expect(findNodeKind(ws, 'output')).toBe('output');
  });
});
