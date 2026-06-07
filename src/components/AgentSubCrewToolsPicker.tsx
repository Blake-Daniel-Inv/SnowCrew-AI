'use client';

import { useMemo } from 'react';
import {
  formatSubCrewCyclePath,
  wouldCreateSubCrewCycle,
} from '@/lib/workspace/cycle-preview';
import type {
  CrewStudioAgent,
  CrewStudioWorkspace,
} from '@/types';

/**
 * Renders a checkbox list of every `SubCrewInvocation` on the workspace
 * and lets the user toggle the agent's `subCrewToolIds` membership.
 *
 * Mirrors `TaskContextPicker` from PR 17: changes are not blocked when
 * the addition would create a cycle — instead an inline error names the
 * cycle path so the user understands the silent drop that the save-time
 * normalizer will apply (`filterAcyclicSubCrewToolIds` in normalize.ts).
 *
 * The cycle helper imported here (`wouldCreateSubCrewCycle`) is the same
 * source-of-truth the SubCrewInvocationEditor uses for its target-crew
 * dropdown, so the picker and the editor never disagree about what
 * counts as a cycle.
 */
export function AgentSubCrewToolsPicker({
  agent,
  workspace,
  onChange,
}: {
  agent: CrewStudioAgent;
  workspace: CrewStudioWorkspace;
  onChange: (nextToolIds: string[]) => void;
}) {
  // Pre-compute the cycle-preview for every invocation so toggling one
  // checkbox doesn't rerun the DFS for every row on the next render.
  const cycleByInvocation = useMemo(() => {
    const map = new Map<
      string,
      ReturnType<typeof wouldCreateSubCrewCycle>
    >();
    for (const inv of workspace.subCrewInvocations) {
      map.set(inv.id, wouldCreateSubCrewCycle(workspace, agent.id, inv.id));
    }
    return map;
  }, [workspace, agent.id]);

  function toggle(invocationId: string, checked: boolean) {
    onChange(
      checked
        ? [...agent.subCrewToolIds, invocationId]
        : agent.subCrewToolIds.filter((id) => id !== invocationId)
    );
  }

  if (workspace.subCrewInvocations.length === 0) {
    return (
      <div className="config-subsection">
        <div className="config-field-label">Sub-crew tools</div>
        <div className="config-field-hint">
          No sub-crew invocations defined on this workspace yet. Drop a
          Sub-crew node from the palette to create one.
        </div>
      </div>
    );
  }

  return (
    <div className="config-subsection">
      <div className="config-field-label">Sub-crew tools</div>
      <div className="config-checkbox-list">
        {workspace.subCrewInvocations.map((inv) => {
          const preview = cycleByInvocation.get(inv.id);
          const checked = agent.subCrewToolIds.includes(inv.id);
          const cycles = preview?.wouldCycle === true;
          const hintId = `agent-${agent.id}-subcrew-${inv.id}-hint`;
          return (
            <label
              key={inv.id}
              className={`config-checkbox-item${cycles ? ' config-checkbox-item-error' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => toggle(inv.id, e.target.checked)}
                aria-describedby={cycles ? hintId : undefined}
                aria-invalid={cycles || undefined}
              />
              <div>
                <span className="config-checkbox-name">{inv.name}</span>
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
                      Selecting &ldquo;{inv.name}&rdquo; would create a cycle:{' '}
                      {formatSubCrewCyclePath(workspace, preview.cyclePath)}.
                      This reference will be silently dropped on save.
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
