// @@TRACE@@ stdout line decoder for the python runner protocol.
//
// PR γ — sub-crew nesting context. The python SubCrewTool emits
// `subcrew_call` / `subcrew_complete` events to bracket each nested
// kickoff. Between them, any events the sub-crew produces (agent_started,
// task_started, llm_call, etc.) are tagged with the parent invocation
// id and the current depth so the UI can indent them.
//
// The context is maintained as a per-line-handler STACK. Multiple
// concurrent runs each carry their own handler instance (the runner's
// `executeRun` creates handlers in its local scope), so there's no
// global state to leak across runs.

import type { TraceEvent, TraceEventType } from '@/types';

export type TraceLlmCall = {
  model: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  taskName?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs?: number | null;
};

export type TraceLineHandlers = {
  recordLlmCall: (call: TraceLlmCall) => void;
  emitEvent: (ev: Omit<TraceEvent, 'id' | 'sequence' | 'timestamp'>) => void;
  emitOutput: (chunk: string) => void;
};

/**
 * Per-run sub-crew context stack. Each entry remembers the invocation
 * currently in flight + the depth at which it's running so events
 * emitted while it's at the top of the stack inherit the right
 * parent / depth metadata.
 *
 * Created by `createSubCrewContextStack` and threaded through
 * `handleTraceLine` via the optional `context` parameter. The runner
 * keeps one stack per run (in scope of `executeRun`), so concurrent
 * runs cannot bleed into each other.
 */
export interface SubCrewContextEntry {
  invocationId: string;
  depth: number;
}

export interface SubCrewContextStack {
  /** Read-only inspection — callers should not mutate this array. */
  readonly stack: SubCrewContextEntry[];
  push(entry: SubCrewContextEntry): void;
  pop(invocationId: string): void;
  /** Returns the entry currently at the top of the stack, or undefined. */
  top(): SubCrewContextEntry | undefined;
}

export function createSubCrewContextStack(): SubCrewContextStack {
  const stack: SubCrewContextEntry[] = [];
  return {
    stack,
    push(entry) {
      // Cap defensively. The python tool already enforces a depth ceiling
      // (MAX_NESTING_DEPTH=5); we just refuse to stack deeper than 32 to
      // catch any runaway producer bug without unbounded growth.
      if (stack.length >= 32) return;
      stack.push(entry);
    },
    pop(invocationId) {
      // Tolerant pop: if the top doesn't match, walk back looking for
      // the right invocation. This guards against a runaway producer
      // skipping a subcrew_complete — we still recover the right depth
      // for subsequent events. If no match is found, no-op (the event
      // was emitted out of context, e.g., trailing log after the run
      // ended).
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].invocationId === invocationId) {
          stack.length = i;
          return;
        }
      }
    },
    top() {
      return stack[stack.length - 1];
    },
  };
}

/**
 * Channel the trace line arrived on. PR 33 split trace I/O off stdout
 * onto a dedicated FD 3 pipe so LLM-authored text on stdout cannot
 * inject phantom trace events. Stdout recognition stays as a legacy
 * fallback (warn-and-pass-through) for cases where FD 3 is not wired.
 */
export type TraceLineSource = 'fd3' | 'stdout';

export function handleTraceLine(
  line: string,
  handlers: TraceLineHandlers,
  context?: SubCrewContextStack,
  source: TraceLineSource = 'stdout'
): void {
  // Structured trace lines start with @@TRACE@@ JSON
  if (line.startsWith('@@TRACE@@ ')) {
    // PR 33 — when a trace line arrives on stdout (the legacy / fallback
    // channel), it's still parsed (so a misconfigured spawn doesn't
    // silently lose telemetry) but we treat the Python-side one-shot
    // "trace on stdout" warning as the operator-visible signal — no
    // per-line nag here, just pass-through. FD 3 is the preferred
    // channel for new deployments.
    void source;
    const raw = line.slice('@@TRACE@@ '.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      handlers.emitEvent({
        type: 'warning',
        title: 'Failed to parse trace line',
        detail,
      });
      handlers.emitOutput(line + '\n');
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { type?: unknown }).type !== 'string'
    ) {
      handlers.emitEvent({
        type: 'warning',
        title: 'Malformed trace payload',
        detail: 'Trace line is not an object with a string `type` field.',
      });
      handlers.emitOutput(line + '\n');
      return;
    }

    const payload = parsed as {
      type: TraceEventType;
      title: string;
      detail?: string;
      taskName?: string;
      agentName?: string;
      toolName?: string;
      taskId?: string;
      agentId?: string;
      nodeId?: string;
      phase?: TraceEvent['phase'];
      tokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      latencyMs?: number | null;
    };

    // token_usage carries Cortex/LiteLLM call metrics that we
    // persist separately so they can be aggregated for cost
    // analysis. The trace event itself just records the total
    // for in-line display.
    if (payload.type === 'token_usage') {
      const { promptTokens, completionTokens, latencyMs, ...traceFields } = payload;
      const totalTokens =
        payload.tokens ??
        (promptTokens ?? 0) + (completionTokens ?? 0);
      handlers.recordLlmCall({
        model: payload.toolName || 'unknown',
        agentId: payload.agentId,
        agentName: payload.agentName,
        taskId: payload.taskId,
        taskName: payload.taskName,
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        totalTokens,
        latencyMs: latencyMs ?? null,
      });
      // token_usage may also fire while a sub-crew kickoff is active
      // (LLM calls inside the nested crew). Stamp the parent context
      // so the per-event nesting indentation still works.
      const enriched = stampContext({ ...traceFields, tokens: totalTokens }, context);
      handlers.emitEvent(enriched);
      return;
    }

    // ----- PR γ: subcrew_call / subcrew_complete bracket handling -----
    //
    // We process these BEFORE the generic emit path so the call event
    // itself carries the right depth (incremented to the level at which
    // it runs), and so the complete event pops the stack AFTER emitting
    // — that keeps any synchronous downstream logging from the python
    // wrapper itself tied to the parent. The python wrapper emits its
    // own depth on the call event, so we trust it (clamped to >=1) and
    // push onto the stack at that depth for subsequent child events.
    if (payload.type === 'subcrew_call') {
      const meta = (payload as { metadata?: TraceEvent['metadata'] }).metadata || {};
      const invocationId = meta.parentInvocationId;
      const reportedDepth =
        typeof meta.invocationDepth === 'number' ? meta.invocationDepth : 1;
      // Emit BEFORE push so the call event is tagged with the PARENT's
      // depth context (i.e., what is currently on top of the stack)
      // PLUS its own invocation metadata. This keeps the call event
      // indented under its enclosing parent (if any) and not under
      // itself.
      handlers.emitEvent(stampContext(payload, context));
      if (invocationId) {
        context?.push({
          invocationId,
          depth: Math.max(1, reportedDepth),
        });
      }
      return;
    }
    if (payload.type === 'subcrew_complete') {
      const meta = (payload as { metadata?: TraceEvent['metadata'] }).metadata || {};
      // Emit while still in context so the complete event shows under
      // the call event in the UI, THEN pop.
      handlers.emitEvent(stampContext(payload, context));
      if (meta.parentInvocationId) {
        context?.pop(meta.parentInvocationId);
      }
      return;
    }

    handlers.emitEvent(stampContext(payload, context));
    return;
  }
  handlers.emitOutput(line + '\n');
}

/**
 * Tag an outgoing event with the parent invocation context if a
 * sub-crew is currently in flight. Strictly additive: if the event
 * already carries a `metadata.parentInvocationId` (e.g., the python
 * wrapper supplied one explicitly), that wins. Otherwise we copy in
 * the top-of-stack entry's fields.
 */
function stampContext(
  ev: Omit<TraceEvent, 'id' | 'sequence' | 'timestamp'>,
  context?: SubCrewContextStack
): Omit<TraceEvent, 'id' | 'sequence' | 'timestamp'> {
  if (!context) return ev;
  const top = context.top();
  if (!top) return ev;
  const existing = ev.metadata || {};
  // If the event already declares a parent (it's a subcrew_call /
  // subcrew_complete with explicit metadata), keep it as authoritative.
  // For everything else, inherit the stack-top invocation.
  if (existing.parentInvocationId) return ev;
  return {
    ...ev,
    metadata: {
      ...existing,
      parentInvocationId: top.invocationId,
      invocationDepth:
        typeof existing.invocationDepth === 'number'
          ? existing.invocationDepth
          : top.depth,
    },
  };
}
