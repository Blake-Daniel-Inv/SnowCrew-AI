'use client';

import type { NodeProps } from '@xyflow/react';
import type { CanvasRunPhase } from '@/types';
import { NodeHandles } from './NodeHandles';

export interface TaskNodeData {
  taskId: string;
  label: string;
  agentName: string;
  outputFile: string;
  dependencyCount: number;
  humanInput: boolean;
  asyncExecution: boolean;
  runState?: CanvasRunPhase;
  [key: string]: unknown;
}

export function TaskNode({ data, selected }: NodeProps) {
  const d = data as TaskNodeData;

  return (
    <div
      className={`canvas-node canvas-node-task canvas-node-runtime-${d.runState || 'idle'} ${selected ? 'canvas-node-selected' : ''}`}
      aria-label={`Task: ${d.label || 'Untitled Task'}${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`}
    >
      <NodeHandles />
      <div className="canvas-node-icon canvas-node-icon-task">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </div>
      <div className="canvas-node-body">
        <div className="canvas-node-type">Task</div>
        <div className="canvas-node-name">{d.label || 'Untitled Task'}</div>
        <div className="canvas-node-meta-row">
          {d.agentName ? (
            <span className="canvas-node-badge">{d.agentName}</span>
          ) : (
            <span className="canvas-node-badge canvas-node-badge-warn">Unassigned</span>
          )}
          {d.humanInput && <span className="canvas-node-badge canvas-node-badge-info">Human</span>}
          {d.asyncExecution && <span className="canvas-node-badge canvas-node-badge-info">Async</span>}
        </div>
        {d.outputFile && (
          <div className="canvas-node-desc canvas-node-desc-mono">{d.outputFile}</div>
        )}
      </div>
    </div>
  );
}
