'use client';

import { useMemo } from 'react';
import {
  formatCyclePath,
  wouldCreateCycle,
} from '@/lib/workspace/cycle-preview';
import type {
  CrewStudioTask,
  CrewStudioWorkspace,
} from '@/types';

/**
 * Renders the contextTaskIds checkbox list for the task editor with
 * live cycle detection. Save-time `filterAcyclicContextTaskIds` will
 * silently drop any cycle-closing entry; the picker surfaces that
 * preemptively so the user understands why their selection won't stick.
 *
 * The checkbox is NOT blocked when a cycle would form — we just show
 * an inline red warning naming the cycle path. Blocking would diverge
 * from save-time behavior; warning preserves it while making the
 * "silent drop" visible.
 */
export function TaskContextPicker({
  task,
  workspace,
  onChange,
}: {
  task: CrewStudioTask;
  workspace: CrewStudioWorkspace;
  onChange: (nextContextIds: string[]) => void;
}) {
  // Precompute cycle-preview per candidate so toggling one checkbox
  // doesn't rerun the DFS for every row on the next render.
  const cycleByCandidate = useMemo(() => {
    const map = new Map<string, ReturnType<typeof wouldCreateCycle>>();
    for (const candidate of workspace.tasks) {
      if (candidate.id === task.id) continue;
      map.set(candidate.id, wouldCreateCycle(workspace, task.id, candidate.id));
    }
    return map;
  }, [workspace, task.id]);

  function toggle(candidateId: string, checked: boolean) {
    onChange(
      checked
        ? [...task.contextTaskIds, candidateId]
        : task.contextTaskIds.filter((id) => id !== candidateId)
    );
  }

  return (
    <div className="config-subsection">
      <div className="config-field-label">Context dependencies</div>
      <div className="config-checkbox-list">
        {workspace.tasks
          .filter((t) => t.id !== task.id)
          .map((t) => {
            const preview = cycleByCandidate.get(t.id);
            const checked = task.contextTaskIds.includes(t.id);
            const cycles = preview?.wouldCycle === true;
            const hintId = `task-ctx-${task.id}-${t.id}-hint`;
            return (
              <label
                key={t.id}
                className={`config-checkbox-item${cycles ? ' config-checkbox-item-error' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => toggle(t.id, e.target.checked)}
                  aria-describedby={cycles ? hintId : undefined}
                  aria-invalid={cycles || undefined}
                />
                <div>
                  <span>{t.name}</span>
                  {cycles && preview.wouldCycle && (
                    <div
                      id={hintId}
                      className="config-checkbox-cycle-hint"
                      role="alert"
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span>
                        Selecting &ldquo;{t.name}&rdquo; would create a cycle:{' '}
                        {formatCyclePath(workspace, preview.cyclePath)}. This
                        will be silently dropped on save.
                      </span>
                    </div>
                  )}
                </div>
              </label>
            );
          })}
      </div>
    </div>
  );
}
