// Assistant proposal lifecycle: prompt + mode state, request/parse/apply,
// approve/revert, and persistence of the collapsed-state + mode picker.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { CrewStudioWorkspace, ValidationIssue } from '@/types';
import type { AssistantMode } from '../AssistantModePicker';
import type { SelectedEntity } from '../NodeConfigPanel';
import { stripServerOwnedFields } from './stripServerOwnedFields';
import { workspaceDiff } from './workspaceDiff';

const assistantOpenStorageKey = 'crewai-studio-assistant-open';
const assistantModeStorageKey = 'crewai-studio-assistant-mode';

export type AssistantProposalPayload = {
  model: string;
  summary: string;
  changes: string[];
  workspace: CrewStudioWorkspace;
};
export type AssistantProposal = AssistantProposalPayload & {
  before: CrewStudioWorkspace;
  diff: string[];
};

function cloneWorkspace(ws: CrewStudioWorkspace): CrewStudioWorkspace {
  return JSON.parse(JSON.stringify(ws));
}

export function useAssistantProposal(opts: {
  draft: CrewStudioWorkspace | null;
  setDraft: Dispatch<SetStateAction<CrewStudioWorkspace | null>>;
  selection: SelectedEntity;
  validationIssues: ValidationIssue[];
  saveWorkspace: () => Promise<boolean>;
  setNotice: (notice: string) => void;
  setError: (error: string) => void;
  saving: boolean;
}) {
  const { draft, setDraft, selection, validationIssues, saveWorkspace, setNotice, setError } = opts;

  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState('');
  const [assistantProposal, setAssistantProposal] = useState<AssistantProposal | null>(null);
  // Workflow Assistant lives at the bottom of the sidebar and is collapsed by
  // default — secondary to the palette + crew list above it. State persists to
  // localStorage so it stays however the user left it.
  const [assistantOpen, setAssistantOpen] = useState(false);
  // Model the assistant uses for itself (separate from the workspace's
  // defaultLlm, which controls the agents in proposals). 'auto' picks
  // sonnet vs opus on the server based on prompt + workspace size.
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('auto');
  // Last actual model the server picked (after a run). When mode is
  // 'auto' this lets us tell the user which model handled the request.
  const [assistantLastModel, setAssistantLastModel] = useState<string | null>(null);

  /* --- assistant collapsed state --- */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(assistantOpenStorageKey);
    if (raw === '1') setAssistantOpen(true);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(assistantOpenStorageKey, assistantOpen ? '1' : '0');
  }, [assistantOpen]);

  /* --- assistant model preference --- */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(assistantModeStorageKey);
    if (raw === 'auto' || raw === 'sonnet' || raw === 'opus') setAssistantMode(raw);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(assistantModeStorageKey, assistantMode);
  }, [assistantMode]);

  // If the assistant produces a proposal while collapsed, auto-expand so the
  // user can see + approve/revert without first remembering to open it.
  useEffect(() => {
    if (assistantProposal) setAssistantOpen(true);
  }, [assistantProposal]);

  async function requestAssistantChanges() {
    if (!draft) return;
    if (!assistantPrompt.trim()) {
      setAssistantError('Describe what you want the workflow assistant to build or change.');
      return;
    }
    if (assistantProposal) {
      setAssistantError('Approve or revert the current assistant proposal first.');
      return;
    }

    const before = cloneWorkspace(draft);
    try {
      setAssistantBusy(true);
      setAssistantError('');
      setError('');
      // PR 10: pass workspaceId so the server can apply the If-Match
      // precondition (the body schema strips the id, so we plumb it
      // via query). Sending the workspace's current updatedAt as
      // If-Match short-circuits a stale-snapshot proposal before it
      // burns Cortex tokens.
      const response = await fetch(
        `/api/workspaces/assistant?workspaceId=${encodeURIComponent(draft.id)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': `"${draft.updatedAt}"`,
          },
          body: JSON.stringify({
            workspace: stripServerOwnedFields(draft),
            prompt: assistantPrompt,
            // Send a compact selection ref — the route looks the entity up in
            // the workspace JSON anyway, so we don't need to ship it twice.
            selectedEntity: selection
              ? 'id' in selection
                ? { kind: selection.kind, id: selection.id }
                : { kind: selection.kind }
              : null,
            // The Issues panel already runs validateWorkspace; piping that
            // result through means the assistant can see and prioritize the
            // same problems the user sees.
            validationIssues,
            // Auto/Sonnet/Opus choice. Server applies the heuristic for 'auto'.
            assistantMode,
          }),
        }
      );
      // Branch on specific gateway/auth statuses so the user gets a useful
      // message instead of a generic "Assistant failed" — these come back
      // with empty / non-JSON bodies from the edge proxy.
      if (response.status === 504) throw new Error('Assistant request timed out. Try again.');
      if (response.status === 502) throw new Error('Upstream Snowflake error. Try again.');
      if (response.status === 401) throw new Error('Session expired. Reload.');
      // PR 10: another tab saved this workspace mid-request. Skip the
      // proposal and ask the user to reload — once they reload, the
      // assistant call will succeed against the fresh snapshot.
      if (response.status === 412) throw new Error('This workspace was modified in another tab. Reload to see the latest version, then try again.');
      if (response.status === 428) throw new Error('Assistant request was missing required headers. Please reload.');
      const payload = (await response.json().catch(() => null)) as
        | (AssistantProposalPayload & { error?: string; details?: string })
        | null;
      if (!response.ok || !payload || payload.error) {
        throw new Error(payload?.error || payload?.details || 'Assistant failed to propose changes.');
      }

      const nextProposal: AssistantProposal = {
        ...payload,
        before,
        diff: workspaceDiff(before, payload.workspace),
      };
      setDraft(cloneWorkspace(payload.workspace));
      setAssistantProposal(nextProposal);
      setAssistantLastModel(payload.model || null);
      setNotice('Assistant proposal previewed on the canvas.');
    } catch (e) {
      setAssistantError(e instanceof Error ? e.message : 'Assistant failed to propose changes.');
    } finally {
      setAssistantBusy(false);
    }
  }

  async function approveAssistantProposal() {
    if (!assistantProposal) return;
    const saved = await saveWorkspace();
    if (saved) {
      setAssistantProposal(null);
      setAssistantPrompt('');
      setAssistantError('');
      setNotice('Assistant changes approved and saved.');
    }
  }

  function revertAssistantProposal() {
    if (!assistantProposal) return;
    setDraft(cloneWorkspace(assistantProposal.before));
    setAssistantProposal(null);
    setAssistantError('');
    setNotice('Assistant proposal reverted.');
  }

  return {
    assistantPrompt,
    setAssistantPrompt,
    assistantBusy,
    assistantError,
    setAssistantError,
    assistantProposal,
    setAssistantProposal,
    assistantOpen,
    setAssistantOpen,
    assistantMode,
    setAssistantMode,
    assistantLastModel,
    requestAssistantChanges,
    approveAssistantProposal,
    revertAssistantProposal,
  };
}
