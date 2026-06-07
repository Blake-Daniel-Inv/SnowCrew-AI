'use client';

import type { NodeProps } from '@xyflow/react';
import type { CanvasRunPhase } from '@/types';
import { NodeHandles } from './NodeHandles';

export interface ActionNodeData {
  actionId: string;
  label: string;
  type: string;
  enabled: boolean;
  afterTaskName: string;
  recipientCount: number;
  runState?: CanvasRunPhase;
  [key: string]: unknown;
}

export function ActionNode({ data, selected }: NodeProps) {
  const d = data as ActionNodeData;

  return (
    <div
      className={`canvas-node canvas-node-action canvas-node-runtime-${d.runState || 'idle'} ${selected ? 'canvas-node-selected' : ''}`}
      aria-label={`Action: ${d.label || 'Email Result'}${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`}
    >
      <NodeHandles />
      <div className="canvas-node-icon canvas-node-icon-action">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 4h16v16H4z" />
          <path d="m4 6 8 7 8-7" />
        </svg>
      </div>
      <div className="canvas-node-body">
        <div className="canvas-node-type">Action</div>
        <div className="canvas-node-name">{d.label || 'Email Result'}</div>
        <div className="canvas-node-desc">{d.afterTaskName ? `After ${d.afterTaskName}` : 'Post-task action'}</div>
        <div className="canvas-node-meta-row">
          <span className="canvas-node-badge">{d.type}</span>
          <span className={`canvas-node-badge ${d.enabled ? 'canvas-node-badge-success' : 'canvas-node-badge-warn'}`}>
            {d.enabled ? 'Enabled' : 'Disabled'}
          </span>
          {d.recipientCount > 0 && <span className="canvas-node-badge canvas-node-badge-info">{d.recipientCount} recipient{d.recipientCount !== 1 ? 's' : ''}</span>}
        </div>
      </div>
    </div>
  );
}
