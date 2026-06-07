'use client';

import type { NodeProps } from '@xyflow/react';
import type { CanvasRunPhase } from '@/types';
import { NodeHandles } from './NodeHandles';

export interface ConnectionNodeData {
  connectionId: string;
  label: string;
  mode: string;
  ready: boolean;
  runState?: CanvasRunPhase;
  [key: string]: unknown;
}

export function ConnectionNode({ data, selected }: NodeProps) {
  const d = data as ConnectionNodeData;

  return (
    <div
      className={`canvas-node canvas-node-connection canvas-node-runtime-${d.runState || 'idle'} ${selected ? 'canvas-node-selected' : ''}`}
      aria-label={`Connection: ${d.label || 'Untitled Connection'}${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`}
    >
      <NodeHandles />
      <div className="canvas-node-icon canvas-node-icon-connection">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </div>
      <div className="canvas-node-body">
        <div className="canvas-node-type">Connection</div>
        <div className="canvas-node-name">{d.label || 'Untitled Connection'}</div>
        <div className="canvas-node-meta-row">
          <span className="canvas-node-badge">{d.mode}</span>
          <span className={`canvas-node-badge ${d.ready ? 'canvas-node-badge-success' : 'canvas-node-badge-warn'}`}>
            {d.ready ? 'Ready' : 'Setup needed'}
          </span>
        </div>
      </div>
    </div>
  );
}
