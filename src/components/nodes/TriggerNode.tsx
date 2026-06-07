'use client';

import type { NodeProps } from '@xyflow/react';
import type { CanvasRunPhase } from '@/types';
import { NodeHandles } from './NodeHandles';

export interface TriggerNodeData {
  label: string;
  crewName: string;
  process: string;
  runState?: CanvasRunPhase;
  [key: string]: unknown;
}

export function TriggerNode({ data, selected }: NodeProps) {
  const d = data as TriggerNodeData;

  return (
    <div
      className={`canvas-node canvas-node-trigger canvas-node-runtime-${d.runState || 'idle'} ${selected ? 'canvas-node-selected' : ''}`}
      aria-label={`Trigger: ${d.label || 'Crew Kickoff'}${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`}
    >
      <NodeHandles />
      <div className="canvas-node-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      </div>
      <div className="canvas-node-body">
        <div className="canvas-node-type">Trigger</div>
        <div className="canvas-node-name">Crew Kickoff</div>
        <div className="canvas-node-desc">Start workflow</div>
      </div>
    </div>
  );
}
