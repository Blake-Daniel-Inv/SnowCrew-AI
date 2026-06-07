'use client';

import { Handle, Position } from '@xyflow/react';

/**
 * Renders bidirectional handles on all four sides of a node.
 * Each side gets both a source and target handle so edges can
 * connect in any direction without React Flow errors.
 * The duplicate handle at each position is invisible but still connectable.
 */
export function NodeHandles() {
  return (
    <>
      {/* Left */}
      <Handle type="target" position={Position.Left} id="left" className="canvas-handle" />
      <Handle type="source" position={Position.Left} id="left-source" className="canvas-handle canvas-handle-hidden" />
      {/* Right */}
      <Handle type="source" position={Position.Right} id="right" className="canvas-handle" />
      <Handle type="target" position={Position.Right} id="right-target" className="canvas-handle canvas-handle-hidden" />
      {/* Top */}
      <Handle type="source" position={Position.Top} id="top" className="canvas-handle canvas-handle-vertical" />
      <Handle type="target" position={Position.Top} id="top-target" className="canvas-handle canvas-handle-vertical canvas-handle-hidden" />
      {/* Bottom */}
      <Handle type="target" position={Position.Bottom} id="bottom" className="canvas-handle canvas-handle-vertical" />
      <Handle type="source" position={Position.Bottom} id="bottom-source" className="canvas-handle canvas-handle-vertical canvas-handle-hidden" />
    </>
  );
}
