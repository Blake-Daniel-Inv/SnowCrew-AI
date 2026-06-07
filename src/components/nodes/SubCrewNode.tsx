'use client';

import type { NodeProps } from '@xyflow/react';
import type { CanvasRunPhase } from '@/types';
import { NodeHandles } from './NodeHandles';

/**
 * Canvas node for a `SubCrewInvocation` (PR 21).
 *
 * Mirrors {@link AgentNode} in layout. The card surfaces:
 *   - SubCrew icon (git-fork inline SVG)
 *   - Display name (CSS-truncated when long)
 *   - Target crew label ("→ <Target Crew>")
 *   - Budget badge in the top-right corner ("↻ N / MAX")
 *   - Caption "Up to N invocations" below the name
 *
 * `runState` is respected and forwarded to the canvas-node-runtime-*
 * styling hook so the live-run pulse / completed check / failed cross
 * match other nodes.
 *
 * PR γ — when a run is active and `liveCurrent` is defined, the budget
 * badge switches to a live "↻ current/max" counter. A `running` accent
 * lights up when current > 0 but the budget isn't exhausted; a
 * `budget-exhausted` accent fires when current === max. The spinner
 * animation honors `prefers-reduced-motion`.
 */
export interface SubCrewNodeData {
  invocationId: string;
  label: string;
  targetCrewName: string;
  maxInvocations: number;
  runState?: CanvasRunPhase;
  /** PR γ — number of times this invocation has fired in the active run. */
  liveCurrent?: number;
  /** PR γ — call budget for the active run (defaults to maxInvocations). */
  liveMax?: number;
  [key: string]: unknown;
}

export function SubCrewNode({ data, selected }: NodeProps) {
  const d = data as SubCrewNodeData;
  const targetLabel = d.targetCrewName?.trim() || 'No target crew';
  // PR γ — derive the live badge state once so both the aria label
  // and the visual badge stay in lockstep.
  const hasLive = typeof d.liveCurrent === 'number';
  const liveCurrent = d.liveCurrent ?? 0;
  const liveMax = d.liveMax ?? d.maxInvocations;
  const isRunning = hasLive && liveCurrent > 0 && liveCurrent < liveMax;
  const isExhausted = hasLive && liveCurrent >= liveMax && liveCurrent > 0;
  const badgeAccent = isExhausted
    ? 'canvas-node-subcrew-budget-exhausted'
    : isRunning
      ? 'canvas-node-subcrew-budget-running'
      : '';
  const ariaLabel = hasLive
    ? `Sub-crew invocation calling ${targetLabel}, ${liveCurrent} of ${liveMax} calls used${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`
    : `Sub-crew invocation calling ${targetLabel}, budget: ${d.maxInvocations}${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`;
  return (
    <div
      className={`canvas-node canvas-node-subcrew canvas-node-runtime-${d.runState || 'idle'} ${selected ? 'canvas-node-selected' : ''}`}
      aria-label={ariaLabel}
    >
      <NodeHandles />
      <div className="canvas-node-icon canvas-node-icon-subcrew">
        {/* git-fork-style glyph: source crew branches to a sub-crew. */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="18" r="3" />
          <circle cx="6" cy="6" r="3" />
          <circle cx="18" cy="6" r="3" />
          <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
          <line x1="12" y1="12" x2="12" y2="15" />
        </svg>
      </div>
      <div className="canvas-node-body">
        <div className="canvas-node-type">Sub-crew</div>
        <div className="canvas-node-name">{d.label || 'Untitled sub-crew'}</div>
        <div className="canvas-node-desc">
          <span aria-hidden="true">→ </span>
          {targetLabel}
        </div>
        <div className="canvas-node-meta-row">
          <span className="canvas-node-badge canvas-node-badge-info">
            Up to {d.maxInvocations} invocations
          </span>
        </div>
      </div>
      {/* Budget badge — top-right corner, sibling to the runtime status
       *  pip so the two never overlap (runtime pip sits at top: -8 / right:
       *  -8; this one is anchored inside the card top-right).
       *
       *  PR γ — when a run is active, the badge swaps from a static
       *  "↻ N" budget hint to a live "↻ current/max" counter. The
       *  badge gets a `running` accent while sub-calls are still
       *  available, and a `budget-exhausted` accent once the budget
       *  is fully consumed. The spinner animation in CSS respects
       *  prefers-reduced-motion (handled in the stylesheet via
       *  @media (prefers-reduced-motion: reduce)). */}
      <span
        className={`canvas-node-subcrew-budget ${badgeAccent}`}
        aria-label={
          hasLive
            ? `Live: ${liveCurrent} of ${liveMax} invocations used`
            : `Budget: up to ${d.maxInvocations} invocations`
        }
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={isRunning ? 'canvas-node-subcrew-spin' : ''}
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        {hasLive ? `${liveCurrent}/${liveMax}` : d.maxInvocations}
      </span>
    </div>
  );
}
