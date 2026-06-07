'use client';

import type { NodeProps } from '@xyflow/react';
import type { CanvasRunPhase } from '@/types';
import { NodeHandles } from './NodeHandles';

export interface AgentNodeData {
  agentId: string;
  label: string;
  role: string;
  llm: string;
  toolCount: number;
  connectionCount: number;
  allowDelegation: boolean;
  runState?: CanvasRunPhase;
  [key: string]: unknown;
}

export function AgentNode({ data, selected }: NodeProps) {
  const d = data as AgentNodeData;

  return (
    <div
      className={`canvas-node canvas-node-agent canvas-node-runtime-${d.runState || 'idle'} ${selected ? 'canvas-node-selected' : ''}`}
      aria-label={`Agent: ${d.label || 'Untitled Agent'}${d.runState && d.runState !== 'idle' ? `, ${d.runState}` : ''}`}
    >
      <NodeHandles />
      <div className="canvas-node-icon canvas-node-icon-agent">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </div>
      <div className="canvas-node-body">
        <div className="canvas-node-type">Agent</div>
        <div className="canvas-node-name">{d.label || 'Untitled Agent'}</div>
        <div className="canvas-node-desc">{d.role}</div>
        <div className="canvas-node-meta-row">
          <span className="canvas-node-badge">{d.llm}</span>
          {d.toolCount > 0 && (
            <span className="canvas-node-badge">{d.toolCount} tool{d.toolCount !== 1 ? 's' : ''}</span>
          )}
          {d.connectionCount > 0 && (
            <span className="canvas-node-badge canvas-node-badge-info">{d.connectionCount} conn</span>
          )}
          {d.allowDelegation && (
            <span className="canvas-node-badge canvas-node-badge-info">Delegate</span>
          )}
        </div>
      </div>
    </div>
  );
}
