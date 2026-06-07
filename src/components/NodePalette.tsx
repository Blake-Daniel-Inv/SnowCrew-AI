'use client';

import type { DragEvent, KeyboardEvent } from 'react';

type PaletteItem = {
  type: string;
  label: string;
  description: string;
  icon: React.ReactNode;
};

const paletteItems: PaletteItem[] = [
  {
    type: 'agent',
    label: 'Agent',
    description: 'AI specialist with tools',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    type: 'task',
    label: 'Task',
    description: 'Work step with output',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    ),
  },
  {
    type: 'connection',
    label: 'Connection',
    description: 'Snowflake API',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
  },
  {
    type: 'action',
    label: 'Action',
    description: 'Post-run email or handoff',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4h16v16H4z" />
        <path d="m4 6 8 7 8-7" />
      </svg>
    ),
  },
  {
    // PR 21: sub-crew invocations (Coordinator pattern). Dropping this
    // onto the canvas mints a new SubCrewInvocation pre-targeted at the
    // first crew in the workspace; the user then re-points the target
    // in the editor.
    type: 'subcrew',
    label: 'Sub-crew',
    description: 'Call another crew as a tool',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <circle cx="18" cy="6" r="3" />
        <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
        <line x1="12" y1="12" x2="12" y2="15" />
      </svg>
    ),
  },
];

function onDragStart(event: DragEvent, nodeType: string) {
  event.dataTransfer.setData('application/crewai-node-type', nodeType);
  event.dataTransfer.effectAllowed = 'move';
}

export function NodePalette({
  onAddAgent,
  onAddTask,
  onAddConnection,
  onAddAction,
  onAddSubCrew,
}: {
  onAddAgent: () => void;
  onAddTask: () => void;
  onAddConnection: () => void;
  onAddAction: () => void;
  onAddSubCrew: () => void;
}) {
  return (
    <div className="palette-container">
      <div className="palette-header">
        <span className="palette-label">Components</span>
      </div>
      <div className="palette-hint">Drag onto canvas or click to add</div>
      <div className="palette-items">
        {paletteItems.map((item) => {
          const activate = () => {
            if (item.type === 'agent') onAddAgent();
            else if (item.type === 'task') onAddTask();
            else if (item.type === 'connection') onAddConnection();
            else if (item.type === 'action') onAddAction();
            else if (item.type === 'subcrew') onAddSubCrew();
          };
          const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              activate();
            }
          };
          return (
            <div
              key={item.type}
              className="palette-item"
              draggable
              role="button"
              tabIndex={0}
              aria-label={`Add ${item.label} node`}
              onDragStart={(e) => onDragStart(e, item.type)}
              onClick={activate}
              onKeyDown={onKeyDown}
            >
              <div className="palette-item-icon">{item.icon}</div>
              <div className="palette-item-info">
                <div className="palette-item-label">{item.label}</div>
                <div className="palette-item-desc">{item.description}</div>
              </div>
              <div className="palette-item-grip">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.4" aria-hidden="true">
                  <circle cx="8" cy="4" r="2" /><circle cx="16" cy="4" r="2" />
                  <circle cx="8" cy="12" r="2" /><circle cx="16" cy="12" r="2" />
                  <circle cx="8" cy="20" r="2" /><circle cx="16" cy="20" r="2" />
                </svg>
              </div>
            </div>
          );
        })}
      </div>
      <div className="palette-section">
        <div className="palette-label">Quick Add</div>
        <div className="palette-quick-actions">
          <button type="button" className="palette-quick-btn" onClick={onAddAgent}>
            + Agent
          </button>
          <button type="button" className="palette-quick-btn" onClick={onAddTask}>
            + Task
          </button>
          <button type="button" className="palette-quick-btn" onClick={onAddAction}>
            + Action
          </button>
          <button type="button" className="palette-quick-btn" onClick={onAddSubCrew}>
            + Sub-crew
          </button>
          <button
            type="button"
            className="palette-quick-btn"
            onClick={onAddConnection}
          >
            + Connection
          </button>
        </div>
      </div>
    </div>
  );
}
