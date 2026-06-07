'use client';

import { useId, useMemo } from 'react';
import { FieldCounter } from './FieldHints';
import { FIELD_LIMITS, SUBCREW_LIMITS } from '@/lib/schemas/field-limits';
import {
  formatSubCrewCyclePath,
  wouldCreateSubCrewCycle,
} from '@/lib/workspace/cycle-preview';
import type {
  CrewStudioWorkspace,
  SubCrewInvocation,
} from '@/types';

/**
 * Editor for a single `SubCrewInvocation` (PR 21).
 *
 * Surfaced from {@link NodeConfigPanel} when the user selects a sub-crew
 * node on the canvas. Fields use the same Field/Toggle conventions the
 * other editors use; we re-implement Field locally here rather than
 * importing it because NodeConfigPanel.tsx is treated as a sealed
 * megafile (per the design doc's hard 20-line cap on additive edits to
 * it). All field changes flow through `onChange` so the parent can pipe
 * them into the workspace draft state.
 *
 * Cycle preview: the `targetCrewId` dropdown disables each crew that
 * would close a sub-crew call cycle when picked, mirroring the live-
 * cycle UX the task-context picker already provides. The cycle check is
 * source-of-truth from `cycle-preview.ts` so save-time behavior matches
 * what the picker shows.
 */
export function SubCrewInvocationEditor({
  invocation,
  workspace,
  onChange,
  onRemove,
  onOpenTargetCrew,
}: {
  invocation: SubCrewInvocation;
  workspace: CrewStudioWorkspace;
  onChange: (next: SubCrewInvocation) => void;
  onRemove: () => void;
  /**
   * PR 24 — cross-navigation. When supplied, the editor renders an
   * "Open target crew →" button that opens (or activates) the
   * invocation's target crew as a canvas tab. Optional: legacy
   * callers that don't pass it simply hide the button.
   */
  onOpenTargetCrew?: (targetCrewId: string) => void;
}) {
  // Cycle preview per candidate target crew. The user is editing an
  // invocation that ALREADY has a targetCrewId; the question we're
  // answering is "what if they re-point it at crew X?". To do that we
  // synthesize a candidate invocation with the alternate target and
  // hand it to wouldCreateSubCrewCycle.
  //
  // wouldCreateSubCrewCycle takes (workspace, agentId, candidateId)
  // and asks: would adding `candidateId` to that agent's
  // subCrewToolIds create a cycle? Here we need to ask the inverse:
  // "if THIS invocation's target became crew X, would that create a
  // cycle for any agent currently referencing this invocation?". We
  // build a temporary workspace with the candidate target and probe
  // each referencing agent.
  const cycleByCrewId = useMemo(() => {
    const out = new Map<string, { wouldCycle: boolean; path: string }>();
    const referencingAgents = workspace.agents.filter((a) =>
      a.subCrewToolIds.includes(invocation.id)
    );
    if (referencingAgents.length === 0) return out;
    for (const crew of workspace.crews) {
      if (crew.id === invocation.targetCrewId) continue;
      const probeWorkspace: CrewStudioWorkspace = {
        ...workspace,
        subCrewInvocations: workspace.subCrewInvocations.map((i) =>
          i.id === invocation.id ? { ...i, targetCrewId: crew.id } : i
        ),
      };
      let cycles = false;
      let path = '';
      for (const agent of referencingAgents) {
        const probe = wouldCreateSubCrewCycle(
          probeWorkspace,
          agent.id,
          invocation.id
        );
        if (probe.wouldCycle) {
          cycles = true;
          path = formatSubCrewCyclePath(probeWorkspace, probe.cyclePath);
          break;
        }
      }
      out.set(crew.id, { wouldCycle: cycles, path });
    }
    return out;
  }, [workspace, invocation.id, invocation.targetCrewId]);

  // For new invocations the user hasn't wired into any agent yet, we
  // still want to disable crews that would self-loop in obvious ways.
  // The Map only has entries for crews when referencingAgents > 0, so
  // the disabled flag falls back to false for unreferenced invocations.

  function update<K extends keyof SubCrewInvocation>(
    key: K,
    value: SubCrewInvocation[K]
  ) {
    onChange({ ...invocation, [key]: value });
  }

  return (
    <div className="config-scroll">
      <div className="config-section-title">Sub-crew Invocation</div>

      <TextField
        label="Name"
        value={invocation.name}
        maxChars={FIELD_LIMITS.SHORT}
        onChange={(v) => update('name', v)}
      />

      <TextField
        label="Description"
        as="textarea"
        rows={3}
        value={invocation.description}
        maxChars={FIELD_LIMITS.MEDIUM}
        hint="LLM-visible tool description. Helps the lead agent pick the right sub-crew."
        onChange={(v) => update('description', v)}
      />

      <TargetCrewSelect
        invocation={invocation}
        workspace={workspace}
        cycleByCrewId={cycleByCrewId}
        onChange={(id) => update('targetCrewId', id)}
      />

      <OpenTargetCrewButton
        invocation={invocation}
        workspace={workspace}
        onOpenTargetCrew={onOpenTargetCrew}
      />

      <MaxInvocationsField
        value={invocation.maxInvocations}
        onChange={(n) => update('maxInvocations', n)}
      />

      <TextField
        label="Input mapping"
        as="textarea"
        rows={4}
        value={invocation.inputMapping}
        maxChars={FIELD_LIMITS.LONG}
        hint="What to pass to the sub-crew. Free-form instructions for the lead agent, or JSON template if structured."
        onChange={(v) => update('inputMapping', v)}
      />

      <TextField
        label="Success criteria"
        as="textarea"
        rows={3}
        value={invocation.successCriteria || ''}
        maxChars={FIELD_LIMITS.MEDIUM}
        hint="Optional. How does the lead agent know the result is good enough? e.g. 'covers market size, top 3 competitors, pricing'."
        onChange={(v) => update('successCriteria', v.trim() ? v : null)}
      />

      <ContextModeField />

      <TextField
        label="Tags"
        value={invocation.tags.join(', ')}
        onChange={(v) =>
          update(
            'tags',
            v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          )
        }
        hint="Comma-separated. For organization / filtering only."
      />

      <button type="button" className="config-btn-danger" onClick={onRemove}>
        Remove sub-crew invocation
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- *
 *  Internal field helpers. Mirror the Field/Toggle helpers in
 *  NodeConfigPanel.tsx but live here so we don't bloat that file.
 * ----------------------------------------------------------------- */

function TextField({
  label,
  value,
  onChange,
  as = 'input',
  rows = 3,
  hint,
  maxChars,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  as?: 'input' | 'textarea';
  rows?: number;
  hint?: string;
  maxChars?: number;
}) {
  const hintId = useId();
  return (
    <label className="config-field">
      <div className="config-field-label-row">
        <div className="config-field-label">{label}</div>
        {typeof maxChars === 'number' && (
          <FieldCounter current={value.length} max={maxChars} />
        )}
      </div>
      {as === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className="config-field-input config-field-textarea"
          aria-describedby={hint ? `${hintId}-hint` : undefined}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="config-field-input"
          aria-describedby={hint ? `${hintId}-hint` : undefined}
        />
      )}
      {hint && (
        <div id={`${hintId}-hint`} className="config-field-hint">
          {hint}
        </div>
      )}
    </label>
  );
}

function TargetCrewSelect({
  invocation,
  workspace,
  cycleByCrewId,
  onChange,
}: {
  invocation: SubCrewInvocation;
  workspace: CrewStudioWorkspace;
  cycleByCrewId: Map<string, { wouldCycle: boolean; path: string }>;
  onChange: (id: string) => void;
}) {
  const hintId = useId();
  // Hide the crew(s) the agents owning this invocation belong to — the
  // most obvious "self-call" path. Cycles via deeper paths fall through
  // to the disabled-with-tooltip treatment below.
  const ownerCrewIds = new Set<string>();
  for (const agent of workspace.agents) {
    if (!agent.subCrewToolIds.includes(invocation.id)) continue;
    for (const crew of workspace.crews) {
      if (crew.agentIds.includes(agent.id)) ownerCrewIds.add(crew.id);
    }
  }

  return (
    <label className="config-field">
      <div className="config-field-label">Target crew</div>
      <select
        value={invocation.targetCrewId}
        onChange={(e) => onChange(e.target.value)}
        className="config-field-input"
        aria-describedby={`${hintId}-hint`}
      >
        <option value="">No target crew (invocation disabled)</option>
        {workspace.crews
          .filter((c) => !ownerCrewIds.has(c.id))
          .map((c) => {
            const cycle = cycleByCrewId.get(c.id);
            const disabled = cycle?.wouldCycle === true;
            return (
              <option
                key={c.id}
                value={c.id}
                disabled={disabled}
                title={disabled ? `Would create cycle: ${cycle?.path}` : undefined}
              >
                {c.name}
                {disabled ? ' (would create cycle)' : ''}
              </option>
            );
          })}
      </select>
      <div id={`${hintId}-hint`} className="config-field-hint">
        Which crew this tool kicks off. Crews that would close a cycle
        when picked are disabled.
      </div>
    </label>
  );
}

function MaxInvocationsField({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const min = 1;
  const max = SUBCREW_LIMITS.MAX_INVOCATIONS_PER_BOX;
  const clamped = Math.min(Math.max(value, min), max);

  function set(next: number) {
    if (!Number.isFinite(next)) return;
    onChange(Math.min(Math.max(Math.floor(next), min), max));
  }

  return (
    <label className="config-field">
      <div className="config-field-label-row">
        <div className="config-field-label">Max invocations per call</div>
        <span className="config-field-counter" aria-live="polite">
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
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          {clamped} / {max}
        </span>
      </div>
      <div className="config-grid-2">
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={clamped}
          onChange={(e) => set(parseInt(e.target.value, 10))}
          className="config-field-input"
          aria-label="Max invocations (number input)"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={clamped}
          onChange={(e) => set(parseInt(e.target.value, 10))}
          aria-label="Max invocations (slider)"
        />
      </div>
      <div className="config-field-hint">
        Budget the Python tool enforces at run time. Even if the LLM
        tries to call more, the tool returns &ldquo;budget exhausted&rdquo;.
      </div>
    </label>
  );
}


/**
 * PR 24 — "Open target crew →" button. Disabled (with explanatory
 * tooltip) when the invocation has no target or its target points at
 * a crew that no longer exists. The active-tab cross-navigation
 * itself is driven by the parent (CrewStudioApp) via
 * `onOpenTargetCrew`; this component only knows how to dispatch.
 */
function OpenTargetCrewButton({
  invocation,
  workspace,
  onOpenTargetCrew,
}: {
  invocation: SubCrewInvocation;
  workspace: CrewStudioWorkspace;
  onOpenTargetCrew?: (targetCrewId: string) => void;
}) {
  // Hide the button entirely when no parent supplies the callback —
  // keeps the editor usable in places (tests, fixture renderers) that
  // don't have a tab strip wired up.
  if (!onOpenTargetCrew) return null;
  const target = invocation.targetCrewId;
  const targetExists =
    target.length > 0 &&
    workspace.crews.some((c) => c.id === target);
  const disabled = !targetExists;
  const title = disabled
    ? 'Pick a target crew first'
    : 'Open this crew as a tab and switch to it';
  return (
    <button
      type="button"
      className="subcrew-open-target-btn"
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!disabled) onOpenTargetCrew(target);
      }}
    >
      <span>Open target crew</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    </button>
  );
}

function ContextModeField() {
  return (
    <label className="config-field">
      <div className="config-field-label">Context mode</div>
      <select
        value="isolated"
        className="config-field-input"
        disabled
        title="Shared context is a future option."
      >
        <option value="isolated">Isolated (default)</option>
      </select>
      <div className="config-field-hint">
        Each kickoff is a fresh CrewAI run with no shared memory.
        Shared context is reserved for a future version.
      </div>
    </label>
  );
}
