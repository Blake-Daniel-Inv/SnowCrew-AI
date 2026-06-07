'use client';

import type { NodeProps } from '@xyflow/react';
import type { CanvasRunPhase } from '@/types';
import { NodeHandles } from './NodeHandles';

export interface OutputNodeData {
  label: string;
  runState?: CanvasRunPhase;
  [key: string]: unknown;
}

export function OutputNode({ data, selected }: NodeProps) {
  const d = data as OutputNodeData;

  return (
    <div
      className={`canvas-node canvas-node-output canvas-node-runtime-${d.runState || 'idle'} ${selected ? 'canvas-node-selected' : ''}`}
      aria-label={`Output: ${d.label || 'Crew Result'}${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`}
    >
      <NodeHandles />
      <div className="canvas-node-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <div className="canvas-node-body">
        <div className="canvas-node-type">Output</div>
        <div className="canvas-node-name">Crew Result</div>
        <div className="canvas-node-desc">Final output</div>
      </div>
    </div>
  );
}
