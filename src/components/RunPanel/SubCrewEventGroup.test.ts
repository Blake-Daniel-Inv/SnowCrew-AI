// PR γ — focused tests for groupSubCrewEvents().
//
// We don't render JSX here (component output is exercised by manual smoke
// test). What we want to nail down is the grouping logic: given a flat
// list of TraceEvents with subcrew_call / subcrew_complete brackets,
// produce a tree where nested invocations are grouped under their
// parents.

import { describe, expect, it } from 'vitest';
import { groupSubCrewEvents } from './SubCrewEventGroup';
import type { TraceEvent } from '@/types';

function ev(
  id: string,
  type: TraceEvent['type'],
  title: string,
  metadata?: TraceEvent['metadata']
): TraceEvent {
  return {
    id,
    timestamp: '2026-01-01T00:00:00Z',
    sequence: parseInt(id.replace(/\D/g, ''), 10) || 0,
    type,
    title,
    metadata,
  };
}

describe('groupSubCrewEvents', () => {
  it('passes through leaf events when no brackets are present', () => {
    const out = groupSubCrewEvents([
      ev('e1', 'agent_started', 'a'),
      ev('e2', 'agent_completed', 'a done'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.kind === 'leaf')).toBe(true);
  });

  it('groups events between a subcrew_call and subcrew_complete', () => {
    const out = groupSubCrewEvents([
      ev('e1', 'log', 'before'),
      ev('e2', 'subcrew_call', 'kick', {
        parentInvocationId: 'inv1',
        invocationDepth: 1,
        invocationNumber: 1,
        invocationTotal: 2,
      }),
      ev('e3', 'agent_started', 'nested agent'),
      ev('e4', 'agent_completed', 'nested done'),
      ev('e5', 'subcrew_complete', 'done', { parentInvocationId: 'inv1' }),
      ev('e6', 'log', 'after'),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].kind).toBe('leaf');
    expect(out[1].kind).toBe('group');
    expect(out[2].kind).toBe('leaf');
    if (out[1].kind === 'group') {
      expect(out[1].group.header.id).toBe('e2');
      expect(out[1].group.footer?.id).toBe('e5');
      // children: nested agent_started, agent_completed
      expect(out[1].group.children.map((c) => c.id)).toEqual(['e3', 'e4']);
    }
  });

  it('nests groups when a subcrew_call appears inside another', () => {
    const out = groupSubCrewEvents([
      ev('e1', 'subcrew_call', 'outer', {
        parentInvocationId: 'inv1',
        invocationDepth: 1,
      }),
      ev('e2', 'subcrew_call', 'inner', {
        parentInvocationId: 'inv2',
        invocationDepth: 2,
      }),
      ev('e3', 'log', 'inside inner'),
      ev('e4', 'subcrew_complete', 'inner done', {
        parentInvocationId: 'inv2',
      }),
      ev('e5', 'subcrew_complete', 'outer done', {
        parentInvocationId: 'inv1',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('group');
    if (out[0].kind === 'group') {
      expect(out[0].group.header.id).toBe('e1');
      expect(out[0].group.footer?.id).toBe('e5');
      // children should contain the inner call/complete pair AND the
      // log between them — exact membership preserves ordering.
      const childIds = out[0].group.children.map((c) => c.id);
      expect(childIds[0]).toBe('e2');
    }
  });

  it('tolerates a missing subcrew_complete (open group flushed to result)', () => {
    const out = groupSubCrewEvents([
      ev('e1', 'subcrew_call', 'kick', {
        parentInvocationId: 'inv1',
        invocationDepth: 1,
      }),
      ev('e2', 'agent_started', 'nested'),
      // no complete — run probably terminated early.
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('group');
    if (out[0].kind === 'group') {
      expect(out[0].group.header.id).toBe('e1');
      expect(out[0].group.footer).toBeNull();
      expect(out[0].group.children.map((c) => c.id)).toEqual(['e2']);
    }
  });
});
