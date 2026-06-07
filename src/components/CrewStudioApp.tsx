'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  buildCrewStudioExportBundle,
  findNodeKind,
} from '@/lib/crew-studio';
import type { Edge } from '@xyflow/react';
import type {
  CanvasLayout,
  CrewStudioExportBundle,
  CrewStudioWorkspace,
  CrewRun,
} from '@/types';

import { WorkflowCanvas } from './WorkflowCanvas';
import { CrewTabsStrip } from './CrewTabsStrip';
import { useOpenCrewTabs } from './useOpenCrewTabs';
import { NodePalette } from './NodePalette';
import { NodeConfigPanel, type SelectedEntity } from './NodeConfigPanel';
import { LlmModelSelect } from './LlmModelSelect';
import { ValidationPanel } from './ValidationPanel';
import { RunPanel } from './RunPanel';
import { ThemePicker } from './ThemePicker';
import { AssistantModePicker } from './AssistantModePicker';
import { validateWorkspace } from '@/lib/validation';
import { WORKSPACE_TEMPLATES, type WorkspaceTemplateKey } from '@/lib/templates';
import {
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  getThemeById,
  readStoredThemeId,
} from '@/lib/themes';

import { useWorkspaceDraft } from './CrewStudioApp/useWorkspaceDraft';
import { useActiveRunStream } from './CrewStudioApp/useActiveRunStream';
import { useAssistantProposal } from './CrewStudioApp/useAssistantProposal';
import { usePaneSizes } from './CrewStudioApp/usePaneSizes';
import { ConfirmDialog } from './CrewStudioApp/ConfirmDialog';
import { ConflictDialog } from './CrewStudioApp/ConflictDialog';
import { StreamDisconnectedBanner } from './CrewStudioApp/StreamDisconnectedBanner';
import { useReadinessCheck } from './useReadinessCheck';
import { ReadinessBanner, READINESS_BANNER_ID } from './ReadinessBanner';
import { stripServerOwnedFields } from './CrewStudioApp/stripServerOwnedFields';
import { UserIdentityBadge } from './UserIdentityBadge';
import { SchedulesPanel } from './SchedulesPanel';
import { CommandPalette } from './CommandPalette';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { useGlobalShortcuts } from './useGlobalShortcuts';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type CrewStudioListPayload = { workspaces: CrewStudioWorkspace[] };
type CrewStudioDetailPayload = { workspace: CrewStudioWorkspace; exports: CrewStudioExportBundle };
type BottomTab = 'exports' | 'workspace' | 'runs' | 'validation' | 'schedules' | null;

const exportTabs: Array<{ key: keyof CrewStudioExportBundle; label: string }> = [
  { key: 'agentsYaml', label: 'agents.yaml' },
  { key: 'tasksYaml', label: 'tasks.yaml' },
  { key: 'crewPython', label: 'crew.py' },
  { key: 'envExample', label: '.env.example' },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function displayPath(value: string | null): string {
  if (!value) return 'No repo';
  return value.replace(/^\/Users\/[^/]+/, '~');
}

function getRepoName(value: string): string {
  return value.split('/').filter(Boolean).pop() || value;
}

function parseMultiValue(value: string): string[] {
  return value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function cloneWorkspace(ws: CrewStudioWorkspace): CrewStudioWorkspace {
  return JSON.parse(JSON.stringify(ws));
}

function sortWorkspaces(list: CrewStudioWorkspace[]): CrewStudioWorkspace[] {
  return [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export function CrewStudioApp() {
  /* --- state --- */
  const [themeId, setThemeId] = useState<string>(DEFAULT_THEME_ID);
  const [repoPath, setRepoPath] = useState('');
  const [workspaces, setWorkspaces] = useState<CrewStudioWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectedEntity>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>(null);
  const [exportTab, setExportTab] = useState<keyof CrewStudioExportBundle>('agentsYaml');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Identity surfaced from /api/me: in SPCS this is the visiting user's
  // Snowflake username (forwarded by the ingress proxy); locally it's
  // null with mode='local' so we just hide the pill.
  const [identity, setIdentity] = useState<{ user: string | null; mode: 'spcs' | 'local' } | null>(null);
  // PR 16: pre-flight readiness signal. Drives the top-of-canvas banner
  // and disables the Run button when required env vars or the credentials
  // master key are missing.
  const readiness = useReadinessCheck();
  const readinessBlocksRun =
    readiness.status === 'not_ready' &&
    (readiness.checks.envVars !== 'ok' || readiness.checks.credentialsKey === 'missing');
  const [workspaceSelectorOpen, setWorkspaceSelectorOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<CrewRun | null>(null);
  // Pending confirm-dialog payload. When non-null the in-app confirm modal
  // renders and gates the destructive action behind the user's choice.
  // We use this instead of window.confirm so we can manage focus, allow
  // Escape to cancel, and trap Tab inside the dialog.
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  // PR 10: Concurrent-edit conflict state. Set when PATCH returns 412.
  // `serverUpdatedAt` is the version the server reports as current —
  // shown in the modal as a relative time and used as the next
  // If-Match value if the user reloads via GET. `reloading` gates both
  // buttons while the GET is in flight.
  const [pendingConflict, setPendingConflict] = useState<{
    serverUpdatedAt: string | null;
  } | null>(null);
  const [conflictReloading, setConflictReloading] = useState(false);
  const appBodyRef = useRef<HTMLDivElement | null>(null);
  const canvasAreaRef = useRef<HTMLElement | null>(null);
  const workspaceSelectorRef = useRef<HTMLDivElement | null>(null);

  const {
    draft,
    setDraft,
    updateDraft,
    updateAgent,
    updateTask,
    updateAction,
    updateCrew,
    updateConnection,
    addAgent,
    addTask,
    addAction,
    addConnection,
    addSubCrewInvocation,
    updateSubCrewInvocation,
    removeSubCrewInvocation,
    removeAgent,
    removeTask,
    removeAction,
    removeCrew,
    removeConnection,
    setDefaultConnection,
    createBlankAgent,
    createBlankTask,
    createBlankCrew,
    createBlankConnection,
    createBlankAction,
    createBlankSubCrewInvocation,
  } = useWorkspaceDraft({ setSelection, setRightOpen });

  // PR 24 — per-workspace crew tab state. Hook composes pure
  // helpers that handle persistence, ghost filtering, and the
  // implicit-open behavior used by the SubCrew "Open target crew"
  // cross-navigation button.
  const {
    openTabs: crewOpenTabs,
    activeCrewId,
    openTab: openCrewTab,
    closeTab: closeCrewTab,
    selectTab: selectCrewTab,
  } = useOpenCrewTabs(selectedWorkspaceId, draft?.crews ?? []);

  const { streamDisconnected, streamLastEventAt, retryStreamNow } = useActiveRunStream(
    activeRunId,
    setActiveRun
  );

  const { paneSizes, startPaneResize, handlePaneResizeKey, paneAriaProps } = usePaneSizes({
    appBodyRef,
    canvasAreaRef,
    leftOpen,
    rightOpen,
  });

  const repoOptions = dedupe(workspaces.map((w) => w.repoPath || '').filter(Boolean));
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) || null;
  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !selectedWorkspace) return false;
    // Canvas layout changes (node drags) are visual-only and shouldn't
    // mark the workspace as dirty — otherwise dragging a node leaves
    // the toolbar stuck on "Unsaved changes" forever. Layout still
    // persists on the next explicit save.
    const stripLayout = (w: CrewStudioWorkspace) => {
      const { canvasLayout: _ignored, ...rest } = w;
      void _ignored;
      return rest;
    };
    return JSON.stringify(stripLayout(draft)) !== JSON.stringify(stripLayout(selectedWorkspace));
  }, [draft, selectedWorkspace]);
  const exportBundle = draft ? buildCrewStudioExportBundle(draft) : null;
  const validationIssues = useMemo(
    () => (draft ? validateWorkspace(draft) : []),
    [draft]
  );
  const errorCount = validationIssues.filter((i) => i.severity === 'error').length;
  const warningCount = validationIssues.filter((i) => i.severity === 'warning').length;
  const appBodyStyle = {
    '--left-sidebar-width': `${paneSizes.left}px`,
    '--right-sidebar-width': `${paneSizes.right}px`,
    '--bottom-panel-height': `${paneSizes.bottom}px`,
    '--assistant-height': `${paneSizes.assistant}px`,
  } as CSSProperties;

  /* --- theme --- */
  useEffect(() => { setThemeId(readStoredThemeId()); }, []);

  function applyThemeId(next: string) {
    const theme = getThemeById(next);
    setThemeId(theme.id);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.themeId = theme.id;
      document.documentElement.dataset.themeMode = theme.mode;
    }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    }
  }

  /* --- identity (who's signed in via SPCS ingress) --- */
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (cancelled || !payload) return;
        setIdentity({
          user: typeof payload.user === 'string' ? payload.user : null,
          mode: payload.mode === 'spcs' ? 'spcs' : 'local',
        });
      })
      .catch(() => { /* non-fatal — toolbar pill just stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  /* --- workspace selector dropdown: close on ESC + outside click ---
   *
   * Mirrors the AssistantModePicker pattern so keyboard users can
   * dismiss the popover and pointer users get the conventional
   * "click outside to close" behavior. The effect is gated on
   * `workspaceSelectorOpen` so we don't keep listeners attached when
   * the dropdown is closed.
   */
  useEffect(() => {
    if (!workspaceSelectorOpen) return;
    function onDocClick(event: MouseEvent) {
      if (!workspaceSelectorRef.current?.contains(event.target as Node)) {
        setWorkspaceSelectorOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setWorkspaceSelectorOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [workspaceSelectorOpen]);

  /* --- load workspaces --- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const q = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : '';
        const res = await fetch(`/api/workspaces${q}`);
        if (!res.ok) {
          const p = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(p?.error || 'Failed to load workspaces');
        }
        const payload = (await res.json()) as CrewStudioListPayload;
        if (cancelled) return;
        setWorkspaces(payload.workspaces);
        setSelectedWorkspaceId((cur) => {
          if (cur && payload.workspaces.some((w) => w.id === cur)) return cur;
          return payload.workspaces[0]?.id || null;
        });
        setError('');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load workspaces');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [repoPath]);

  /* --- sync draft from selected workspace ---
   *
   * Two distinct triggers land on this effect:
   *   1. The user switched to a different workspace (id changed).
   *      → Reset session state (selection, run stream, assistant proposal)
   *        because none of it applies to the new workspace.
   *   2. The same workspace's data changed (e.g. just-saved version came
   *      back from the server). → Re-sync the draft, but DON'T reset
   *      session state. Otherwise a save mid-run silently kills the live
   *      run stream and the user loses observability of their crew.
   */
  const prevWorkspaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevWorkspaceIdRef.current;
    const currentId = selectedWorkspace?.id || null;
    const switchedWorkspace = prevId !== currentId;
    prevWorkspaceIdRef.current = currentId;

    if (!selectedWorkspace) {
      setDraft(null);
      if (switchedWorkspace) {
        setSelection(null);
        setActiveRunId(null);
        setActiveRun(null);
        setAssistantProposal(null);
        setAssistantError('');
      }
      return;
    }

    setDraft(cloneWorkspace(selectedWorkspace));
    if (switchedWorkspace) {
      setSelection(null);
      setActiveRunId(null);
      setActiveRun(null);
      setAssistantProposal(null);
      setAssistantError('');
    }
    // setAssistantProposal/setAssistantError are returned from a hook
    // declared later in this function; adding them to deps trips TDZ.
    // The setters are stable React refs so omitting them is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspace, setDraft]);

  function replaceWorkspace(ws: CrewStudioWorkspace) {
    setWorkspaces((cur) => sortWorkspaces(cur.map((w) => (w.id === ws.id ? ws : w))));
    setSelectedWorkspaceId(ws.id);
    setDraft(cloneWorkspace(ws));
  }

  /* --- CRUD --- */
  async function createWorkspace(templateKey: WorkspaceTemplateKey = 'starter') {
    try {
      setCreating(true); setError(''); setNotice('');
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: repoPath || null, templateKey }),
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(p?.error || 'Create failed');
      }
      const ws = (await res.json()) as CrewStudioWorkspace;
      setWorkspaces((cur) => sortWorkspaces([ws, ...cur]));
      setSelectedWorkspaceId(ws.id);
      setNotice('Workspace created.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  }

  // PR 19: Duplicate the current workspace via the clone endpoint.
  // The new workspace becomes the active selection on success so the
  // user is immediately editing the copy.
  async function duplicateWorkspace() {
    if (!draft) return;
    const sourceId = draft.id;
    try {
      setCreating(true); setError(''); setNotice('');
      const res = await fetch(`/api/workspaces/${sourceId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
        const msg = typeof p?.error === 'string' ? p.error : p?.error?.message || 'Duplicate failed';
        throw new Error(msg);
      }
      const ws = (await res.json()) as CrewStudioWorkspace;
      setWorkspaces((cur) => sortWorkspaces([ws, ...cur]));
      setSelectedWorkspaceId(ws.id);
      setNotice('Workspace duplicated.');
    } catch (e) {
      setError(`Could not duplicate workspace: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setCreating(false);
    }
  }

  /**
   * PR 10: PATCH /api/workspaces/[id] requires an If-Match header
   * carrying the last-known updatedAt. The server returns:
   *   428 PRECONDITION_REQUIRED → we forgot to send the header (bug).
   *   412 PRECONDITION_FAILED   → another tab/session saved first.
   *   200                       → success; refresh local state.
   *
   * On 412 we open the conflict modal and DO NOT silently retry —
   * silent retry is exactly how the original bug erased work.
   */
  async function saveWorkspace(): Promise<boolean> {
    if (!draft) return false;
    try {
      setSaving(true); setError(''); setNotice('');
      const res = await fetch(`/api/workspaces/${draft.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          // Standard ETag form. Server accepts either raw ISO or
          // quoted; sending quoted matches what GET hands out as
          // ETag so a round-trip stays consistent.
          'If-Match': `"${draft.updatedAt}"`,
        },
        body: JSON.stringify(stripServerOwnedFields(draft)),
      });

      // 412 → another writer landed first. Surface the modal; the
      // user picks reload-or-cancel. Returning false (without setError)
      // keeps the toast quiet — the modal IS the error UI.
      if (res.status === 412) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: { details?: { currentUpdatedAt?: string } } }
          | null;
        const serverUpdatedAt = payload?.error?.details?.currentUpdatedAt ?? null;
        setPendingConflict({ serverUpdatedAt });
        return false;
      }

      // 428 → we forgot to send the header somewhere. Should be
      // unreachable thanks to the header above, but defend against
      // a future caller that forks this function and forgets it.
      if (res.status === 428) {
        console.error('[saveWorkspace] 428 PRECONDITION_REQUIRED — missing If-Match header');
        setError('Save failed — please reload and try again.');
        return false;
      }

      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
        const msg =
          typeof p?.error === 'string'
            ? p.error
            : p?.error?.message || 'Save failed';
        throw new Error(msg);
      }
      const payload = (await res.json()) as CrewStudioDetailPayload;
      replaceWorkspace(payload.workspace);
      setNotice('Saved.');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }

  /**
   * PR 10: Resolve a 412 conflict by re-fetching the server's copy
   * and replacing local draft state. The dirty flag (hasUnsavedChanges
   * memo) clears automatically once `draft` matches `selectedWorkspace`.
   */
  async function reloadConflictedWorkspace() {
    if (!draft) {
      setPendingConflict(null);
      return;
    }
    const id = draft.id;
    try {
      setConflictReloading(true);
      const res = await fetch(`/api/workspaces/${id}`);
      if (!res.ok) {
        // Reload itself failed (likely a 404 — workspace was deleted
        // in the other tab). Surface a toast and dismiss the modal so
        // the user isn't trapped; the list-load below will reconcile.
        const p = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(p?.error?.message || 'Failed to reload workspace');
        setPendingConflict(null);
        return;
      }
      const payload = (await res.json()) as CrewStudioDetailPayload;
      replaceWorkspace(payload.workspace);
      setPendingConflict(null);
      setNotice('Workspace reloaded from server.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reload workspace');
    } finally {
      setConflictReloading(false);
    }
  }

  function deleteWorkspace() {
    if (!draft) return;
    const target = draft;
    setPendingConfirm({
      title: 'Delete workspace?',
      message: `"${target.name}" will be permanently removed. This cannot be undone.`,
      confirmLabel: 'Delete workspace',
      onConfirm: async () => {
        try {
          setSaving(true); setError(''); setNotice('');
          const res = await fetch(`/api/workspaces/${target.id}`, { method: 'DELETE' });
          if (!res.ok) {
            const p = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(p?.error || 'Delete failed');
          }
          setWorkspaces((cur) => {
            const remaining = cur.filter((w) => w.id !== target.id);
            setSelectedWorkspaceId(remaining[0]?.id || null);
            return remaining;
          });
          setNotice('Deleted.');
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Delete failed');
        } finally {
          setSaving(false);
        }
      },
    });
  }

  const {
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
  } = useAssistantProposal({
    draft,
    setDraft,
    selection,
    validationIssues,
    saveWorkspace,
    setNotice,
    setError,
    saving,
  });

  /* --- global shortcuts (PR 18 — Cmd+K palette + ? help) --- */
  const globalShortcuts = useGlobalShortcuts({
    workspaces, activeWorkspaceId: selectedWorkspaceId, currentThemeId: themeId,
    runDisabled: !draft || readinessBlocksRun,
    saveDisabled: !hasUnsavedChanges || saving || !draft,
    onSelectWorkspace: setSelectedWorkspaceId,
    onRunCrew: () => setBottomTab((v) => (v === 'runs' ? null : 'runs')),
    onSaveWorkspace: () => void saveWorkspace(),
    onOpenBottomTab: setBottomTab,
    onSelectTheme: applyThemeId,
    onSelectRun: (runId) => { setActiveRunId(runId); setBottomTab('runs'); },
    onDuplicateWorkspace: draft ? () => void duplicateWorkspace() : undefined,
  });

  /* --- canvas callbacks --- */
  const handleSelect = useCallback((entity: SelectedEntity) => {
    setSelection(entity);
    if (entity) {
      setRightOpen(true);
    } else {
      setRightOpen(false);
    }
  }, []);

  const handleLayoutChange = useCallback((partial: Partial<CanvasLayout>) => {
    if (partial.nodes) {
      updateDraft((w) => ({
        ...w,
        canvasLayout: {
          ...w.canvasLayout,
          nodes: { ...w.canvasLayout.nodes, ...partial.nodes },
        },
      }));
    }
  }, [updateDraft]);

  /**
   * Drawing an edge on the canvas wires the corresponding workspace
   * field. Edges aren't stored separately — they re-derive from data
   * on every render — so this is the inverse of the lookup that
   * WorkflowCanvas does in buildNodesAndEdges.
   *
   * Wiring rules (source → target):
   *   agent → task         : task.agentId = agent.id (replaces existing)
   *   task → task          : adds to target.contextTaskIds
   *   task → action        : action.afterTaskId = task.id
   *   connection → agent   : adds to agent.connectionIds
   *   connection → action  : action.connectionId = connection.id
   * Other combinations fall through silently — the canvas pre-validates
   * via isWireableEdge / isValidConnection so they shouldn't get here.
   */
  const handleAddEdge = useCallback((source: string, target: string) => {
    if (!draft) return;
    const sk = findNodeKind(draft, source);
    const tk = findNodeKind(draft, target);
    if (!sk || !tk || source === target) return;

    if (sk === 'agent' && tk === 'task') {
      updateTask(target, (t) => ({ ...t, agentId: source }));
    } else if (sk === 'task' && tk === 'task') {
      updateTask(target, (t) =>
        t.contextTaskIds.includes(source)
          ? t
          : { ...t, contextTaskIds: [...t.contextTaskIds, source] }
      );
    } else if (sk === 'task' && tk === 'action') {
      updateAction(target, (a) => ({ ...a, afterTaskId: source }));
    } else if (sk === 'connection' && tk === 'agent') {
      updateAgent(target, (a) =>
        a.connectionIds.includes(source)
          ? a
          : { ...a, connectionIds: [...a.connectionIds, source] }
      );
    } else if (sk === 'connection' && tk === 'action') {
      updateAction(target, (a) => ({ ...a, connectionId: source }));
    }
  }, [draft, updateTask, updateAction, updateAgent]);

  /**
   * Deleting an edge unwinds the same field that handleAddEdge set.
   * Sequential crew-flow edges (workflow ordering) are tagged
   * deletable=false in the canvas so they never reach this handler.
   */
  const handleEdgesDelete = useCallback((edges: Edge[]) => {
    if (!draft) return;
    for (const edge of edges) {
      const sk = findNodeKind(draft, edge.source);
      const tk = findNodeKind(draft, edge.target);
      if (!sk || !tk) continue;

      if (sk === 'agent' && tk === 'task') {
        updateTask(edge.target, (t) =>
          t.agentId === edge.source ? { ...t, agentId: null } : t
        );
      } else if (sk === 'task' && tk === 'task') {
        updateTask(edge.target, (t) => ({
          ...t,
          contextTaskIds: t.contextTaskIds.filter((id) => id !== edge.source),
        }));
      } else if (sk === 'task' && tk === 'action') {
        updateAction(edge.target, (a) =>
          a.afterTaskId === edge.source ? { ...a, afterTaskId: null } : a
        );
      } else if (sk === 'connection' && tk === 'agent') {
        updateAgent(edge.target, (a) => ({
          ...a,
          connectionIds: a.connectionIds.filter((id) => id !== edge.source),
        }));
      } else if (sk === 'connection' && tk === 'action') {
        updateAction(edge.target, (a) =>
          a.connectionId === edge.source ? { ...a, connectionId: null } : a
        );
      }
    }
  }, [draft, updateTask, updateAction, updateAgent]);

  const handleDropNode = useCallback((type: string, x: number, y: number) => {
    if (type === 'agent') {
      const agent = createBlankAgent(draft?.defaultLlm || 'snowflake/claude-sonnet-4-6');
      updateDraft((w) => ({
        ...w,
        agents: [...w.agents, agent],
        canvasLayout: { ...w.canvasLayout, nodes: { ...w.canvasLayout.nodes, [agent.id]: { x, y } } },
      }));
      setSelection({ kind: 'agent', id: agent.id });
      setRightOpen(true);
    } else if (type === 'task') {
      const task = createBlankTask();
      updateDraft((w) => ({
        ...w,
        tasks: [...w.tasks, task],
        crews: w.crews.length > 0
          ? w.crews.map((c, i) => i === 0 ? { ...c, taskIds: [...c.taskIds, task.id] } : c)
          : w.crews,
        canvasLayout: { ...w.canvasLayout, nodes: { ...w.canvasLayout.nodes, [task.id]: { x, y } } },
      }));
      setSelection({ kind: 'task', id: task.id });
      setRightOpen(true);
    } else if (type === 'connection') {
      const conn = createBlankConnection();
      updateDraft((w) => ({
        ...w,
        connections: [...w.connections, conn],
        canvasLayout: { ...w.canvasLayout, nodes: { ...w.canvasLayout.nodes, [conn.id]: { x, y } } },
      }));
      setSelection({ kind: 'connection', id: conn.id });
      setRightOpen(true);
    } else if (type === 'action') {
      const action = createBlankAction(draft);
      updateDraft((w) => ({
        ...w,
        actions: [...w.actions, action],
        canvasLayout: { ...w.canvasLayout, nodes: { ...w.canvasLayout.nodes, [action.id]: { x, y } } },
      }));
      setSelection({ kind: 'action', id: action.id });
      setRightOpen(true);
    } else if (type === 'subcrew') {
      const inv = createBlankSubCrewInvocation(draft);
      updateDraft((w) => ({
        ...w,
        subCrewInvocations: [...w.subCrewInvocations, inv],
        canvasLayout: { ...w.canvasLayout, nodes: { ...w.canvasLayout.nodes, [`subcrew-${inv.id}`]: { x, y } } },
      }));
      setSelection({ kind: 'subcrew', id: inv.id });
      setRightOpen(true);
    }
  }, [draft, updateDraft, createBlankAgent, createBlankTask, createBlankConnection, createBlankAction, createBlankSubCrewInvocation]);

  /* --- exports --- */
  async function copyExport(key: keyof CrewStudioExportBundle) {
    if (!exportBundle) return;
    // Some bundle fields are now optional (e.g. tokenRefreshPython); guard
    // against undefined so the clipboard call doesn't blow up.
    const text = exportBundle[key];
    if (typeof text !== 'string') return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${key}`);
    } catch {
      setError('Clipboard access failed.');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Render                                                            */
  /* ------------------------------------------------------------------ */

  return (
    <ReactFlowProvider>
      <a href="#main-canvas" className="skip-link">Skip to canvas</a>
      <h1 className="sr-only">CrewAI Studio</h1>
      <div className="app-shell" data-app-root tabIndex={-1}>
        <ReadinessBanner
          status={readiness.status}
          checks={readiness.checks}
          mode={readiness.mode}
          isLoading={readiness.isLoading}
          error={readiness.error}
          refetch={readiness.refetch}
        />
        {/* ===== TOP TOOLBAR ===== */}
        <header className="toolbar">
          <div className="toolbar-left">
            <button
              type="button"
              className="toolbar-btn toolbar-brand"
              onClick={() => setLeftOpen((v) => !v)}
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
              aria-expanded={leftOpen}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              <span className="toolbar-brand-text">CrewAI Studio</span>
            </button>

            {/* Workspace selector */}
            <div ref={workspaceSelectorRef} className="toolbar-workspace-selector">
              <button
                type="button"
                className="toolbar-btn toolbar-workspace-btn"
                onClick={() => setWorkspaceSelectorOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={workspaceSelectorOpen}
                aria-controls="workspace-selector-dropdown"
              >
                <span className="toolbar-workspace-name">{draft?.name || 'No workspace'}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {workspaceSelectorOpen && (
                <div className="toolbar-dropdown" id="workspace-selector-dropdown" role="menu">
                  <div className="toolbar-dropdown-header">
                    <input
                      value={repoPath}
                      onChange={(e) => setRepoPath(e.target.value)}
                      className="toolbar-dropdown-search"
                      placeholder="Filter by repo path..."
                      list="repo-options"
                    />
                    <datalist id="repo-options">
                      {repoOptions.map((r) => <option key={r} value={r}>{getRepoName(r)}</option>)}
                    </datalist>
                  </div>
                  <div className="toolbar-dropdown-list">
                    {workspaces.map((w) => (
                      <div key={w.id} className="toolbar-dropdown-item-row">
                        <button
                          type="button"
                          className={`toolbar-dropdown-item ${w.id === selectedWorkspaceId ? 'active' : ''}`}
                          onClick={() => { setSelectedWorkspaceId(w.id); setWorkspaceSelectorOpen(false); }}
                        >
                          <div className="toolbar-dropdown-item-name">{w.name}</div>
                          <div className="toolbar-dropdown-item-meta">{displayPath(w.repoPath)}</div>
                        </button>
                        <button
                          type="button"
                          className="toolbar-dropdown-item-action"
                          aria-label={`Duplicate workspace ${w.name}`}
                          title="Duplicate workspace"
                          disabled={creating}
                          onClick={() => { setSelectedWorkspaceId(w.id); setWorkspaceSelectorOpen(false); void duplicateWorkspace(); }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    {workspaces.length === 0 && (
                      <div className="toolbar-dropdown-empty">No workspaces yet</div>
                    )}
                  </div>
                  <div className="toolbar-dropdown-templates">
                    <div className="toolbar-dropdown-templates-label">Create from template</div>
                    {WORKSPACE_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.key}
                        type="button"
                        className="toolbar-dropdown-template"
                        onClick={() => {
                          void createWorkspace(tpl.key);
                          setWorkspaceSelectorOpen(false);
                        }}
                        disabled={creating}
                      >
                        <div className="toolbar-dropdown-template-title">{tpl.title}</div>
                        <div className="toolbar-dropdown-template-desc">{tpl.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {hasUnsavedChanges && <span className="toolbar-unsaved" role="status" aria-live="polite">Unsaved changes</span>}
          </div>

          <div className="toolbar-center">
            {draft && (
              <>
                <span className="toolbar-stat">{draft.agents.length} agents</span>
                <span className="toolbar-stat-sep" />
                <span className="toolbar-stat">{draft.tasks.length} tasks</span>
                <span className="toolbar-stat-sep" />
                <span className="toolbar-stat">{draft.actions.length} actions</span>
                <span className="toolbar-stat-sep" />
                <span className="toolbar-stat">{draft.crews.length} crews</span>
                <span className="toolbar-stat-sep" />
                <span className="toolbar-stat">{draft.connections.length} connections</span>
              </>
            )}
          </div>

          <div className="toolbar-right">
            <UserIdentityBadge />
            {identity?.user && (
              <span
                className="toolbar-identity"
                title={
                  identity.mode === 'spcs'
                    ? `Signed in via Snowflake as ${identity.user}`
                    : `Local dev session — ${identity.user}`
                }
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span className="toolbar-identity-name">{identity.user}</span>
              </span>
            )}
            {/* Run crew — primary action */}
            <button
              type="button"
              className={`toolbar-btn toolbar-btn-run ${bottomTab === 'runs' ? 'toolbar-btn-active' : ''}`}
              onClick={() => setBottomTab((v) => v === 'runs' ? null : 'runs')}
              title={readinessBlocksRun ? "Resolve the readiness banner above before running" : "Run crew"}
              disabled={!draft || readinessBlocksRun}
              aria-describedby={readinessBlocksRun ? READINESS_BANNER_ID : undefined}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Run
            </button>
            <button
              type="button"
              className={`toolbar-btn ${bottomTab === 'validation' ? 'toolbar-btn-active' : ''}`}
              onClick={() => setBottomTab((v) => v === 'validation' ? null : 'validation')}
              title="Validation issues"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              Issues
              {errorCount > 0 && <span className="toolbar-badge toolbar-badge-error">{errorCount}</span>}
              {errorCount === 0 && warningCount > 0 && <span className="toolbar-badge toolbar-badge-warning">{warningCount}</span>}
            </button>

            {/* Bottom panel toggles */}
            <button
              type="button"
              className={`toolbar-btn ${bottomTab === 'exports' ? 'toolbar-btn-active' : ''}`}
              onClick={() => setBottomTab((v) => v === 'exports' ? null : 'exports')}
              title="Exports"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" />
              </svg>
              Exports
            </button>
            <button
              type="button"
              className={`toolbar-btn ${bottomTab === 'workspace' ? 'toolbar-btn-active' : ''}`}
              onClick={() => setBottomTab((v) => v === 'workspace' ? null : 'workspace')}
              title="Workspace settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </button>

            <div className="toolbar-divider" />

            <button
              type="button"
              className="toolbar-btn"
              onClick={() => void saveWorkspace()}
              disabled={!hasUnsavedChanges || saving || !draft}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => void deleteWorkspace()}
              disabled={!draft || saving}
            >
              Delete
            </button>

          </div>
        </header>

        {/* ===== MAIN LAYOUT ===== */}
        <div ref={appBodyRef} className="app-body" style={appBodyStyle}>
          {/* --- LEFT SIDEBAR (palette) --- */}
          {leftOpen && draft && (
            <aside className="sidebar-left">
              <NodePalette
                onAddAgent={addAgent}
                onAddTask={addTask}
                onAddConnection={addConnection}
                onAddAction={addAction}
                onAddSubCrew={addSubCrewInvocation}
              />
              {/* Crew selector */}
              <div className="palette-section">
                <div className="palette-label">Crews / Workflows</div>
                <div className="palette-crew-list">
                  {draft.crews.map((crew) => (
                    <button
                      key={crew.id}
                      type="button"
                      className={`palette-crew-item ${selection?.kind === 'crew' && selection.id === crew.id ? 'active' : ''}`}
                      onClick={() => { setSelection({ kind: 'crew', id: crew.id }); setRightOpen(true); }}
                    >
                      <div className="palette-crew-name">{crew.name}</div>
                      <div className="palette-crew-meta">{crew.process} - {crew.taskIds.length} tasks</div>
                    </button>
                  ))}
                  <button type="button" className="palette-quick-btn" onClick={() => {
                    const crew = createBlankCrew();
                    updateDraft((w) => ({ ...w, crews: [...w.crews, crew] }));
                    setSelection({ kind: 'crew', id: crew.id });
                    setRightOpen(true);
                  }}>
                    + New Crew
                  </button>
                </div>
              </div>

              {/* Workflow Assistant — secondary tool, collapsed by default. */}
              <div className={`assistant-panel ${assistantOpen ? 'assistant-panel-open' : 'assistant-panel-collapsed'}`}>
                {assistantOpen && (
                  <button
                    type="button"
                    className="pane-resize-handle pane-resize-handle-assistant"
                    onPointerDown={(event) => startPaneResize('assistant', event)}
                    onKeyDown={(event) => handlePaneResizeKey('assistant', event)}
                    aria-label="Resize Workflow Assistant"
                    title="Drag or use arrow keys to resize"
                    {...paneAriaProps('assistant')}
                  />
                )}
                <button
                  type="button"
                  className="assistant-toggle"
                  onClick={() => setAssistantOpen((v) => !v)}
                  aria-expanded={assistantOpen}
                >
                  <span className="assistant-toggle-label">
                    <span className="palette-label">Workflow Assistant</span>
                    {assistantProposal && (
                      <span className="assistant-preview-badge">Preview</span>
                    )}
                  </span>
                  <svg
                    className={`assistant-toggle-chevron ${assistantOpen ? 'is-open' : ''}`}
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {assistantOpen && (
                  <div className="assistant-body">
                    <textarea
                      className="assistant-input"
                      value={assistantPrompt}
                      onChange={(event) => setAssistantPrompt(event.target.value)}
                      rows={5}
                      placeholder="Ask for a new workflow or edits to this one..."
                      disabled={assistantBusy || Boolean(assistantProposal)}
                    />
                    {assistantError && <div className="assistant-error">{assistantError}</div>}
                    {/* Cortex-Code-style action row: model picker on the
                      * left, primary action on the right. When a proposal
                      * is staged the right side becomes Revert + Approve. */}
                    <div className="assistant-actions">
                      <AssistantModePicker
                        mode={assistantMode}
                        onChange={setAssistantMode}
                        disabled={assistantBusy || Boolean(assistantProposal)}
                      />
                      <div className="assistant-actions-spacer" />
                      {assistantProposal ? (
                        <>
                          <button
                            type="button"
                            className="assistant-btn"
                            onClick={revertAssistantProposal}
                            disabled={saving}
                          >
                            Revert
                          </button>
                          <button
                            type="button"
                            className="assistant-btn assistant-btn-primary"
                            onClick={() => void approveAssistantProposal()}
                            disabled={saving}
                          >
                            {saving ? 'Saving...' : 'Approve'}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="assistant-send-btn"
                          onClick={() => void requestAssistantChanges()}
                          disabled={assistantBusy || !assistantPrompt.trim()}
                          aria-label={assistantBusy ? 'Building preview' : 'Build preview'}
                          title={assistantBusy ? 'Building...' : 'Build preview'}
                        >
                          {assistantBusy ? (
                            <span className="assistant-send-spinner" aria-hidden="true" />
                          ) : (
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <line x1="12" y1="19" x2="12" y2="5" />
                              <polyline points="5 12 12 5 19 12" />
                            </svg>
                          )}
                        </button>
                      )}
                    </div>
                    {assistantMode === 'auto' && assistantLastModel && (
                      <div className="assistant-model">
                        Auto picked <span className="assistant-model-name">{assistantLastModel}</span>
                      </div>
                    )}
                    {assistantProposal && (
                      <div className="assistant-diff">
                        <div className="assistant-diff-title">{assistantProposal.summary}</div>
                        <ul className="assistant-diff-list">
                          {assistantProposal.diff.slice(0, 8).map((line, index) => (
                            <li key={`${line}-${index}`}>{line}</li>
                          ))}
                        </ul>
                        {assistantProposal.changes.length > 0 && (
                          <div className="assistant-change-notes">
                            {assistantProposal.changes.slice(0, 4).map((line, index) => (
                              <div key={`${line}-${index}`}>{line}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Sidebar footer holds chrome that sits below all sections.
                * Indented from the left so the Next.js dev-mode "N" badge
                * (fixed bottom-left of the viewport) doesn't overlap it. */}
              <div className="sidebar-footer">
                <ThemePicker currentThemeId={themeId} onSelect={applyThemeId} />
              </div>
            </aside>
          )}
          {leftOpen && draft && (
            <button
              type="button"
              className="pane-resize-handle pane-resize-handle-left"
              onPointerDown={(event) => startPaneResize('left', event)}
              onKeyDown={(event) => handlePaneResizeKey('left', event)}
              aria-label="Resize left sidebar"
              title="Drag or use arrow keys to resize left sidebar"
              {...paneAriaProps('left')}
            />
          )}

          {/* --- CANVAS --- */}
          <main ref={canvasAreaRef} id="main-canvas" className="canvas-area">
            {loading ? (
              <div className="canvas-loading">
                <div className="canvas-loading-spinner" />
                <span>Loading workspaces...</span>
              </div>
            ) : draft ? (
              <>
                <CrewTabsStrip
                  crews={draft.crews}
                  openTabs={crewOpenTabs}
                  activeCrewId={activeCrewId}
                  onSelectTab={selectCrewTab}
                  onCloseTab={closeCrewTab}
                  onOpenTab={openCrewTab}
                />
                <WorkflowCanvas
                  workspace={draft}
                  selectedEntity={selection}
                  activeRun={activeRun}
                  selectedCrewId={activeCrewId}
                  onSelect={handleSelect}
                  onLayoutChange={handleLayoutChange}
                  onAddEdge={handleAddEdge}
                  onEdgesDelete={handleEdgesDelete}
                  onDropNode={handleDropNode}
                />
              </>
            ) : (
              <div className="canvas-empty">
                <div className="canvas-empty-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
                  </svg>
                </div>
                <h2 className="canvas-empty-title">Welcome to CrewAI Studio</h2>
                <p className="canvas-empty-text">Create a workspace to start building agent workflows visually</p>
                <button
                  type="button"
                  className="toolbar-btn-primary canvas-empty-btn"
                  onClick={() => void createWorkspace()}
                  disabled={creating}
                >
                  {creating ? 'Creating...' : 'Create Workspace'}
                </button>
              </div>
            )}

            {/* --- BOTTOM PANEL --- */}
            {bottomTab && draft && (
              <div className="bottom-panel">
                <button
                  type="button"
                  className="pane-resize-handle pane-resize-handle-bottom"
                  onPointerDown={(event) => startPaneResize('bottom', event)}
                  onKeyDown={(event) => handlePaneResizeKey('bottom', event)}
                  aria-label="Resize bottom panel"
                  title="Drag or use arrow keys to resize bottom panel"
                  {...paneAriaProps('bottom')}
                />
                <div className="bottom-panel-header">
                  <div className="bottom-panel-tabs" role="tablist" aria-label="Bottom panel">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bottomTab === 'runs'}
                      className={`bottom-panel-tab ${bottomTab === 'runs' ? 'active' : ''}`}
                      onClick={() => setBottomTab('runs')}
                    >
                      Runs
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bottomTab === 'validation'}
                      className={`bottom-panel-tab ${bottomTab === 'validation' ? 'active' : ''}`}
                      onClick={() => setBottomTab('validation')}
                    >
                      Issues
                      {errorCount > 0 && <span className="bottom-panel-tab-badge error">{errorCount}</span>}
                      {errorCount === 0 && warningCount > 0 && <span className="bottom-panel-tab-badge warning">{warningCount}</span>}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bottomTab === 'exports'}
                      className={`bottom-panel-tab ${bottomTab === 'exports' ? 'active' : ''}`}
                      onClick={() => setBottomTab('exports')}
                    >
                      Exports
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bottomTab === 'schedules'}
                      className={`bottom-panel-tab ${bottomTab === 'schedules' ? 'active' : ''}`}
                      onClick={() => setBottomTab('schedules')}
                    >
                      Schedules
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={bottomTab === 'workspace'}
                      className={`bottom-panel-tab ${bottomTab === 'workspace' ? 'active' : ''}`}
                      onClick={() => setBottomTab('workspace')}
                    >
                      Workspace Settings
                    </button>
                  </div>
                  <button type="button" className="bottom-panel-close" onClick={() => setBottomTab(null)} aria-label="Close panel">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
                <div className="bottom-panel-content">
                  {bottomTab === 'runs' && streamDisconnected && activeRunId && (
                    <StreamDisconnectedBanner
                      lastEventAt={streamLastEventAt}
                      onRetry={retryStreamNow}
                    />
                  )}
                  {bottomTab === 'runs' && (
                    <RunPanel
                      workspace={draft}
                      activeRunId={activeRunId}
                      activeRun={activeRun}
                      onActiveRunIdChange={setActiveRunId}
                    />
                  )}
                  {bottomTab === 'validation' && (
                    <ValidationPanel
                      issues={validationIssues}
                      onFocus={(target) => {
                        setSelection(target);
                        setRightOpen(true);
                      }}
                    />
                  )}
                  {bottomTab === 'exports' && exportBundle && (
                    <div className="exports-panel">
                      <div className="exports-tabs">
                        {exportTabs.map((tab) => (
                          <button
                            key={tab.key}
                            type="button"
                            className={`exports-tab ${exportTab === tab.key ? 'active' : ''}`}
                            onClick={() => setExportTab(tab.key)}
                          >
                            {tab.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="exports-copy-btn"
                          onClick={() => void copyExport(exportTab)}
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="exports-code"><code>{exportBundle[exportTab]}</code></pre>
                    </div>
                  )}
                  {bottomTab === 'schedules' && (
                    <SchedulesPanel workspace={draft} />
                  )}
                  {bottomTab === 'workspace' && (
                    <div className="workspace-settings">
                      <div className="ws-settings-grid">
                        <label className="config-field">
                          <div className="config-field-label">Workspace name</div>
                          <input className="config-field-input" value={draft.name} onChange={(e) => updateDraft((w) => ({ ...w, name: e.target.value }))} />
                        </label>
                        <LlmModelSelect
                          label="Default LLM"
                          value={draft.defaultLlm}
                          workspace={draft}
                          onChange={(value) => updateDraft((w) => ({ ...w, defaultLlm: value }))}
                        />
                        <label className="config-field">
                          <div className="config-field-label">Repo path</div>
                          <input className="config-field-input" value={draft.repoPath || ''} onChange={(e) => updateDraft((w) => ({ ...w, repoPath: e.target.value || null }))} />
                        </label>
                        <label className="config-field">
                          <div className="config-field-label">Tags</div>
                          <input className="config-field-input" value={draft.tags.join(', ')} onChange={(e) => updateDraft((w) => ({ ...w, tags: parseMultiValue(e.target.value) }))} />
                        </label>
                        <label className="config-field ws-settings-wide">
                          <div className="config-field-label">Description</div>
                          <textarea className="config-field-input config-field-textarea" rows={3} value={draft.description} onChange={(e) => updateDraft((w) => ({ ...w, description: e.target.value }))} />
                        </label>
                        <label className="config-field ws-settings-wide">
                          <div className="config-field-label">Product brief</div>
                          <textarea className="config-field-input config-field-textarea" rows={3} value={draft.productBrief} onChange={(e) => updateDraft((w) => ({ ...w, productBrief: e.target.value }))} />
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </main>

          {/* --- RIGHT SIDEBAR (config panel) --- */}
          {rightOpen && draft && (
            <button
              type="button"
              className="pane-resize-handle pane-resize-handle-right"
              onPointerDown={(event) => startPaneResize('right', event)}
              onKeyDown={(event) => handlePaneResizeKey('right', event)}
              aria-label="Resize right sidebar"
              title="Drag or use arrow keys to resize right sidebar"
              {...paneAriaProps('right')}
            />
          )}
          {rightOpen && draft && (
            <aside className="sidebar-right">
              <NodeConfigPanel
                selection={selection}
                workspace={draft}
                activeRun={activeRun}
                onOpenTargetCrew={selectCrewTab}
                onUpdateAgent={updateAgent}
                onRemoveAgent={removeAgent}
                onUpdateTask={updateTask}
                onRemoveTask={removeTask}
                onUpdateConnection={updateConnection}
                onRemoveConnection={removeConnection}
                onSetDefaultConnection={setDefaultConnection}
                onUpdateAction={updateAction}
                onRemoveAction={removeAction}
                onUpdateCrew={updateCrew}
                onRemoveCrew={removeCrew}
                onUpdateSubCrew={updateSubCrewInvocation}
                onRemoveSubCrew={removeSubCrewInvocation}
                onClose={() => { setSelection(null); setRightOpen(false); }}
              />
            </aside>
          )}
        </div>

        {/* ===== CONFIRM DIALOG (replaces window.confirm) ===== */}
        {pendingConfirm && (
          <ConfirmDialog
            title={pendingConfirm.title}
            message={pendingConfirm.message}
            confirmLabel={pendingConfirm.confirmLabel}
            onConfirm={() => {
              const fn = pendingConfirm.onConfirm;
              setPendingConfirm(null);
              fn();
            }}
            onCancel={() => setPendingConfirm(null)}
          />
        )}

        {/* ===== CONFLICT DIALOG (PR 10 — 412 from PATCH) =====
          * Cancel keeps the draft state intact but does NOT clear the
          * conflict semantically — the next save attempt will hit 412
          * again. This is intentional: silent recovery is what caused
          * the original bug. */}
        {pendingConflict && (
          <ConflictDialog
            serverUpdatedAt={pendingConflict.serverUpdatedAt}
            reloading={conflictReloading}
            onReload={() => void reloadConflictedWorkspace()}
            onCancel={() => setPendingConflict(null)}
          />
        )}

        {/* ===== NOTIFICATIONS ===== */}
        {(error || notice) && (
          <div className="toast-container" role="status" aria-live="polite" aria-atomic="true">
            {error && (
              <div className="toast toast-error" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError('')} className="toast-close" aria-label="Dismiss error">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            )}
            {notice && (
              <div className="toast toast-success" role="status">
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice('')} className="toast-close" aria-label="Dismiss notification">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            )}
          </div>
        )}
        <CommandPalette open={globalShortcuts.isOpen} onClose={globalShortcuts.close} commands={globalShortcuts.commands} />
        <KeyboardShortcutsModal open={globalShortcuts.isHelpOpen} onClose={globalShortcuts.closeHelp} />
      </div>
    </ReactFlowProvider>
  );
}
