// PR γ — focused tests for the sub-crew nesting context stack threaded
// through handleTraceLine. The full runner flow is exercised by manager
// tests; here we just want to prove the stack push/pop logic and the
// stampContext enrichment behave as documented.

import { describe, expect, it } from 'vitest';
import {
  createSubCrewContextStack,
  handleTraceLine,
  type TraceLineHandlers,
} from './trace-parser';
import type { TraceEvent } from '@/types';

type EmittedEvent = Omit<TraceEvent, 'id' | 'sequence' | 'timestamp'>;

function makeHandlers() {
  const events: EmittedEvent[] = [];
  const outputs: string[] = [];
  const llmCalls: unknown[] = [];
  const handlers: TraceLineHandlers = {
    emitEvent: (ev) => {
      events.push(ev);
    },
    emitOutput: (chunk) => {
      outputs.push(chunk);
    },
    recordLlmCall: (call) => {
      llmCalls.push(call);
    },
  };
  return { handlers, events, outputs, llmCalls };
}

function traceLine(payload: Record<string, unknown>): string {
  return `@@TRACE@@ ${JSON.stringify(payload)}`;
}

describe('createSubCrewContextStack', () => {
  it('starts empty', () => {
    const ctx = createSubCrewContextStack();
    expect(ctx.top()).toBeUndefined();
    expect(ctx.stack).toEqual([]);
  });

  it('push/pop maintains a LIFO stack', () => {
    const ctx = createSubCrewContextStack();
    ctx.push({ invocationId: 'inv1', depth: 1 });
    ctx.push({ invocationId: 'inv2', depth: 2 });
    expect(ctx.top()?.invocationId).toBe('inv2');
    ctx.pop('inv2');
    expect(ctx.top()?.invocationId).toBe('inv1');
    ctx.pop('inv1');
    expect(ctx.top()).toBeUndefined();
  });

  it('tolerant pop walks back to find the matching invocation', () => {
    // The python wrapper could in theory skip a subcrew_complete (bug or
    // crash mid-call). The stack must still recover when the next
    // outer completion arrives.
    const ctx = createSubCrewContextStack();
    ctx.push({ invocationId: 'inv1', depth: 1 });
    ctx.push({ invocationId: 'inv2', depth: 2 });
    ctx.push({ invocationId: 'inv3', depth: 3 });
    // Pop inv1 directly — should clear all three (inv2/inv3 were
    // children of inv1).
    ctx.pop('inv1');
    expect(ctx.top()).toBeUndefined();
  });

  it('caps the stack defensively to prevent unbounded growth', () => {
    const ctx = createSubCrewContextStack();
    for (let i = 0; i < 100; i++) {
      ctx.push({ invocationId: `inv${i}`, depth: i });
    }
    // The cap is 32; anything beyond is silently dropped.
    expect(ctx.stack.length).toBeLessThanOrEqual(32);
  });
});

describe('handleTraceLine with context stack (PR γ)', () => {
  it('treats events without subcrew context as top-level (no metadata)', () => {
    const { handlers, events } = makeHandlers();
    const ctx = createSubCrewContextStack();
    handleTraceLine(traceLine({ type: 'log', title: 'hello' }), handlers, ctx);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toBeUndefined();
  });

  it('pushes onto the stack when a subcrew_call arrives', () => {
    const { handlers, events } = makeHandlers();
    const ctx = createSubCrewContextStack();
    handleTraceLine(
      traceLine({
        type: 'subcrew_call',
        title: 'Sub-crew kickoff 1/3',
        metadata: {
          parentInvocationId: 'inv1',
          invocationDepth: 1,
          invocationNumber: 1,
          invocationTotal: 3,
        },
      }),
      handlers,
      ctx
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('subcrew_call');
    expect(ctx.top()).toEqual({ invocationId: 'inv1', depth: 1 });
  });

  it('stamps child events with the parent invocation id', () => {
    const { handlers, events } = makeHandlers();
    const ctx = createSubCrewContextStack();
    handleTraceLine(
      traceLine({
        type: 'subcrew_call',
        title: 'kick',
        metadata: {
          parentInvocationId: 'inv1',
          invocationDepth: 1,
          invocationNumber: 1,
          invocationTotal: 3,
        },
      }),
      handlers,
      ctx
    );
    handleTraceLine(
      traceLine({ type: 'agent_started', title: 'researcher started' }),
      handlers,
      ctx
    );
    handleTraceLine(
      traceLine({
        type: 'subcrew_complete',
        title: 'done',
        metadata: {
          parentInvocationId: 'inv1',
          invocationDepth: 1,
          invocationNumber: 1,
          invocationTotal: 3,
        },
      }),
      handlers,
      ctx
    );
    handleTraceLine(
      traceLine({ type: 'log', title: 'top-level' }),
      handlers,
      ctx
    );
    expect(events).toHaveLength(4);
    // call event is emitted in PARENT context (i.e., top-level, no
    // metadata stamp from the stack since the stack was empty when it
    // arrived). Its own metadata (parentInvocationId, depth, etc.)
    // is preserved from the python wrapper.
    expect(events[0].metadata?.parentInvocationId).toBe('inv1');
    // child event: inherits the stamp.
    expect(events[1].metadata?.parentInvocationId).toBe('inv1');
    expect(events[1].metadata?.invocationDepth).toBe(1);
    // complete event: still in the parent's context (emit-before-pop).
    expect(events[2].metadata?.parentInvocationId).toBe('inv1');
    // after pop: back to top-level (no stamp).
    expect(events[3].metadata).toBeUndefined();
  });

  it('handles nested sub-crew kickoffs with correct depth on each event', () => {
    const { handlers, events } = makeHandlers();
    const ctx = createSubCrewContextStack();
    handleTraceLine(
      traceLine({
        type: 'subcrew_call',
        title: 'level1',
        metadata: {
          parentInvocationId: 'inv1',
          invocationDepth: 1,
          invocationNumber: 1,
          invocationTotal: 2,
        },
      }),
      handlers,
      ctx
    );
    handleTraceLine(
      traceLine({
        type: 'subcrew_call',
        title: 'level2',
        metadata: {
          parentInvocationId: 'inv2',
          invocationDepth: 2,
          invocationNumber: 1,
          invocationTotal: 1,
        },
      }),
      handlers,
      ctx
    );
    handleTraceLine(
      traceLine({ type: 'agent_started', title: 'inside level 2' }),
      handlers,
      ctx
    );
    expect(events[2].metadata?.parentInvocationId).toBe('inv2');
    expect(events[2].metadata?.invocationDepth).toBe(2);
  });

  it('isolates context across two independent stacks (multi-run safety)', () => {
    // The runner creates one stack per run; two concurrent runs must
    // not see each other's nesting.
    const runA = makeHandlers();
    const runB = makeHandlers();
    const ctxA = createSubCrewContextStack();
    const ctxB = createSubCrewContextStack();
    handleTraceLine(
      traceLine({
        type: 'subcrew_call',
        title: 'a-kick',
        metadata: { parentInvocationId: 'inv-a', invocationDepth: 1 },
      }),
      runA.handlers,
      ctxA
    );
    // Run B sees a top-level event — must not inherit run A's stamp.
    handleTraceLine(
      traceLine({ type: 'log', title: 'b-top' }),
      runB.handlers,
      ctxB
    );
    expect(runA.events[0].metadata?.parentInvocationId).toBe('inv-a');
    expect(runB.events[0].metadata).toBeUndefined();
  });

  it('still parses tokens_usage events and stamps them with parent context', () => {
    const { handlers, events, llmCalls } = makeHandlers();
    const ctx = createSubCrewContextStack();
    handleTraceLine(
      traceLine({
        type: 'subcrew_call',
        title: 'kick',
        metadata: { parentInvocationId: 'inv1', invocationDepth: 1 },
      }),
      handlers,
      ctx
    );
    handleTraceLine(
      traceLine({
        type: 'token_usage',
        title: 'llm call',
        toolName: 'snowflake/claude-sonnet-4-6',
        promptTokens: 100,
        completionTokens: 50,
      }),
      handlers,
      ctx
    );
    expect(llmCalls).toHaveLength(1);
    expect(events[1].metadata?.parentInvocationId).toBe('inv1');
  });
});


describe('PR 33 — channel-aware handleTraceLine', () => {
  it('accepts source="fd3" without altering behavior for valid trace lines', () => {
    // FD 3 is the authoritative trace channel post-PR-33. A well-formed
    // payload arriving on fd3 should round-trip cleanly with no extra
    // warning events.
    const { handlers, events, outputs } = makeHandlers();
    handleTraceLine(
      traceLine({ type: 'log', title: 'hello' }),
      handlers,
      undefined,
      'fd3'
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('log');
    expect(events[0].title).toBe('hello');
    expect(outputs).toHaveLength(0);
  });

  it('accepts source="stdout" as legacy fallback (silent pass-through)', () => {
    // Stdout-arriving traces are still parsed for backward compatibility
    // with any legacy emitter that hasn't moved to FD 3. We do NOT emit
    // a per-line warning — the Python side already emits a one-shot
    // fallback marker, and a per-line nag would spam.
    const { handlers, events } = makeHandlers();
    handleTraceLine(
      traceLine({ type: 'log', title: 'legacy' }),
      handlers,
      undefined,
      'stdout'
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('log');
    expect(events[0].title).toBe('legacy');
  });

  it('defaults source to "stdout" when omitted (backward compatible)', () => {
    // Existing callers that pass only three args must keep working.
    const { handlers, events } = makeHandlers();
    handleTraceLine(traceLine({ type: 'log', title: 'default' }), handlers);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('default');
  });

  it('routes non-trace lines to emitOutput regardless of source', () => {
    const { handlers, events, outputs } = makeHandlers();
    handleTraceLine('plain agent text', handlers, undefined, 'fd3');
    expect(events).toHaveLength(0);
    expect(outputs).toEqual(['plain agent text\n']);
  });
});
