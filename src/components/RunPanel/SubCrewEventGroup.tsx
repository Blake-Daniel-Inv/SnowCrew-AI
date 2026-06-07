// PR γ — collapsible group renderer for sub-crew nested events in RunPanel.
//
// Each subcrew_call event becomes a <details> header; the events that
// follow it WITHIN the same invocation window (parentInvocationId
// matching the call's invocation id) render indented underneath.
// A trailing subcrew_complete closes the group.
//
// Indentation depth is `invocationDepth * 16px`, capped at depth 5
// (the system ceiling — see MAX_NESTING_DEPTH in subcrew-tool.py.ts).
// We use native <details> for accessibility — the keyboard + screen
// reader support comes for free, and React 19 handles its open state
// without an extra effect.

'use client';

import { useMemo, type ReactNode } from 'react';
import type { TraceEvent } from '@/types';

const INDENT_PX = 16;
const MAX_VISUAL_DEPTH = 5;

export interface NestedGroup {
  /** The subcrew_call event that opens this group. */
  header: TraceEvent;
  /** Events emitted between header and the closing subcrew_complete. */
  children: TraceEvent[];
  /** The subcrew_complete event, if seen. */
  footer: TraceEvent | null;
}

/**
 * Group consecutive events by the parent invocation id active at the
 * time they were emitted. Returns a flat list of group + leaf entries
 * preserving order so the caller can render them top-to-bottom.
 *
 * Nesting deeper than one level is rendered by recursion in the
 * renderer below (the call event of a sub-sub-crew becomes a child
 * of its parent's group AND a header of its own group).
 */
export function groupSubCrewEvents(events: TraceEvent[]): Array<
  | { kind: 'leaf'; event: TraceEvent }
  | { kind: 'group'; group: NestedGroup }
> {
  type Frame = { invocationId: string; group: NestedGroup };
  const result: Array<
    | { kind: 'leaf'; event: TraceEvent }
    | { kind: 'group'; group: NestedGroup }
  > = [];
  const stack: Frame[] = [];

  function addToCurrent(
    entry:
      | { kind: 'leaf'; event: TraceEvent }
      | { kind: 'group'; group: NestedGroup }
  ): void {
    if (stack.length === 0) {
      result.push(entry);
      return;
    }
    const top = stack[stack.length - 1];
    if (entry.kind === 'leaf') {
      top.group.children.push(entry.event);
    } else {
      // Nested group: push a leaf-shaped marker into the parent's
      // children list, plus its own footer/children will be filled
      // in via subsequent events. We piggyback on the trace event
      // ordering so the renderer can re-detect groups via the event
      // type when it walks children.
      top.group.children.push(entry.group.header);
      if (entry.group.footer) top.group.children.push(entry.group.footer);
    }
  }

  for (const ev of events) {
    const meta = ev.metadata;
    const parentInvocationId = meta?.parentInvocationId;
    if (ev.type === 'subcrew_call') {
      // Push a new group frame. The HEADER may itself be a child of
      // the enclosing group (when nested), so emit it into the
      // current frame first.
      const group: NestedGroup = { header: ev, children: [], footer: null };
      // The call event renders as its own group header AND counts as
      // a child of its enclosing parent (so the parent's collapse
      // toggles it too). We add the new group entry to the parent
      // first (or to result if top-level), then push it onto the
      // stack so subsequent events nest under it.
      addToCurrent({ kind: 'group', group });
      const invocationId = parentInvocationId || `__inv-${ev.id}`;
      stack.push({ invocationId, group });
      continue;
    }
    if (ev.type === 'subcrew_complete') {
      // Pop the matching frame. The complete event renders as the
      // group's footer; tolerantly walk back if the top doesn't
      // match (mirrors the parser's tolerant pop).
      if (parentInvocationId) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].invocationId === parentInvocationId) {
            stack[i].group.footer = ev;
            stack.length = i;
            break;
          }
        }
      } else if (stack.length > 0) {
        // No invocation id on the event — pop the top defensively.
        stack[stack.length - 1].group.footer = ev;
        stack.pop();
      }
      continue;
    }
    // Regular event: attach to the current frame if one is open.
    addToCurrent({ kind: 'leaf', event: ev });
  }
  return result;
}

/**
 * Render a single sub-crew group as a <details> with all child events
 * indented underneath. The caller is responsible for providing
 * `renderLeaf` so we can keep the actual trace-item markup centralized
 * in RunPanel.
 */
export function SubCrewEventGroup({
  group,
  renderLeaf,
}: {
  group: NestedGroup;
  renderLeaf: (event: TraceEvent) => ReactNode;
}): ReactNode {
  const { header, children, footer } = group;
  const meta = header.metadata || {};
  const target = meta.target || 'sub-crew';
  const num = meta.invocationNumber ?? 1;
  const total = meta.invocationTotal ?? 1;
  const depth = Math.min(meta.invocationDepth ?? 1, MAX_VISUAL_DEPTH);
  const indent = (depth - 1) * INDENT_PX;

  // Re-group the children so a nested sub-crew call renders as its
  // own collapsible block too. Walking via groupSubCrewEvents on the
  // children re-detects nested groups in the same flat list.
  const childEntries = useMemo(() => {
    return groupSubCrewEvents(
      // Include the explicit footer at the end so it renders inside
      // the <details> too. Header itself is the <summary> — exclude.
      footer ? [...children, footer] : children
    );
  }, [children, footer]);

  return (
    <details
      className="run-trace-subcrew-group"
      open
      style={{ marginLeft: indent }}
    >
      <summary className="run-trace-subcrew-summary">
        <span className="run-trace-subcrew-icon" aria-hidden="true">
          {/* Loop glyph — matches the SubCrewNode canvas badge. */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </span>
        <span className="run-trace-subcrew-title">
          Invocation {num}/{total}: {target}
        </span>
        <span className="run-trace-subcrew-count">
          {children.length} event{children.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="run-trace-subcrew-children">
        {childEntries.map((entry) =>
          entry.kind === 'leaf' ? (
            <div
              key={entry.event.id}
              className="run-trace-subcrew-leaf"
              style={{
                marginLeft:
                  Math.min(
                    (entry.event.metadata?.invocationDepth ?? depth) -
                      depth,
                    MAX_VISUAL_DEPTH - depth
                  ) * INDENT_PX,
              }}
            >
              {renderLeaf(entry.event)}
            </div>
          ) : (
            <SubCrewEventGroup
              key={entry.group.header.id}
              group={entry.group}
              renderLeaf={renderLeaf}
            />
          )
        )}
      </div>
    </details>
  );
}
