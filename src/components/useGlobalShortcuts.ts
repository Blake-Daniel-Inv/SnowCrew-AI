'use client';

/**
 * useGlobalShortcuts — owns:
 *   - Cmd/Ctrl+K   → open command palette
 *   - `?`          → open keyboard-shortcuts help modal
 *   - Esc          → close whichever overlay is open (via the dialogs themselves)
 *
 * Plus it builds the `Command[]` list passed to <CommandPalette/>:
 *   - "Actions" rows for Run / Save / Open settings / etc.
 *   - "Workspaces" rows for every workspace.
 *   - "Recent runs" rows from /api/runs (fetched inside this hook so
 *     CrewStudioApp doesn't grow new state).
 *
 * Keyboard scoping: events are only honored when the focused element
 * is inside `[data-app-root]` (or the body). Outside that root (e.g.
 * the browser's address bar), Cmd+K is left to the browser. We resolve
 * via `document.activeElement.closest('[data-app-root]')`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CrewRunSummary,
  CrewStudioWorkspace,
} from '@/types';
import { THEMES } from '@/lib/themes';
import type { Command } from './CommandPalette';

export type BottomTabId =
  | 'exports'
  | 'workspace'
  | 'runs'
  | 'validation'
  | 'schedules'
  | null;

export interface UseGlobalShortcutsInput {
  /** All workspaces — surfaced as "Workspace: <name>" rows. */
  workspaces: CrewStudioWorkspace[];
  /** ID of the active workspace; used to mark the current entry. */
  activeWorkspaceId: string | null;
  /** Current theme id, so we don't list the active theme as a switch target. */
  currentThemeId: string;
  /** True when Run crew is unavailable (no draft / readiness blocks). */
  runDisabled: boolean;
  /** True when Save is unavailable (no dirty changes / no draft / saving). */
  saveDisabled: boolean;

  onSelectWorkspace: (id: string) => void;
  onRunCrew: () => void;
  onSaveWorkspace: () => void;
  onOpenBottomTab: (tab: BottomTabId) => void;
  onSelectTheme: (id: string) => void;
  onSelectRun: (runId: string) => void;
  /** PR 19: invoked by 'Duplicate current workspace' command. Undefined
   * when there is no active workspace; the command is hidden then. */
  onDuplicateWorkspace?: () => void;
}

export interface UseGlobalShortcutsResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  isHelpOpen: boolean;
  openHelp: () => void;
  closeHelp: () => void;
  commands: Command[];
}

/* ------------------------------------------------------------------ */
/*  Pure helpers — exported for testability                            */
/* ------------------------------------------------------------------ */

/** Format an ISO timestamp as a compact relative label ("2m ago"). */
export function formatRelativeShort(
  iso: string | null | undefined,
  now: number = Date.now()
): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = Math.max(0, now - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Classify a keydown event. Returns null for events the hook should
 * ignore. Exported so the test suite can verify platform handling
 * without a DOM.
 */
export function classifyShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): 'open-palette' | 'open-help' | null {
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const primaryMod = isMac ? event.metaKey : event.ctrlKey;
  const otherMod = isMac ? event.ctrlKey : event.metaKey;
  if (
    primaryMod &&
    !otherMod &&
    !event.altKey &&
    (event.key === 'k' || event.key === 'K')
  ) {
    return 'open-palette';
  }
  if (
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    (event.key === '?' || (event.shiftKey && event.key === '/'))
  ) {
    return 'open-help';
  }
  return null;
}

/** Returns true if typing `?` in this element should NOT open help. */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useGlobalShortcuts(
  input: UseGlobalShortcutsInput
): UseGlobalShortcutsResult {
  const {
    workspaces,
    activeWorkspaceId,
    currentThemeId,
    runDisabled,
    saveDisabled,
    onSelectWorkspace,
    onRunCrew,
    onSaveWorkspace,
    onOpenBottomTab,
    onSelectTheme,
    onSelectRun,
    onDuplicateWorkspace,
  } = input;

  const [isOpen, setIsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [recentRuns, setRecentRuns] = useState<CrewRunSummary[]>([]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const openHelp = useCallback(() => setIsHelpOpen(true), []);
  const closeHelp = useCallback(() => setIsHelpOpen(false), []);

  // Fetch recent runs every time the palette opens (cheap, ≤5 rows),
  // so the user always sees the latest 5 without us holding a long-
  // lived subscription. Falls back silently on error — the palette
  // simply omits the "Recent runs" section.
  useEffect(() => {
    if (!isOpen || !activeWorkspaceId) return;
    let cancelled = false;
    void fetch(`/api/runs?workspaceId=${activeWorkspaceId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { runs?: CrewRunSummary[] } | null) => {
        if (cancelled || !payload?.runs) return;
        setRecentRuns(payload.runs.slice(0, 5));
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeWorkspaceId]);

  // Global keyboard listener attached at the window so we don't miss
  // keystrokes before any in-app control has been clicked. Scope check
  // is `closest('[data-app-root]')` so Cmd+K outside the canvas-app
  // shell stays as the browser's default.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const intent = classifyShortcut(event);
      if (!intent) return;
      const active = document.activeElement;
      const root = active?.closest?.('[data-app-root]');
      const isBody = active === document.body || active === null;
      if (!root && !isBody) return;
      if (intent === 'open-palette') {
        event.preventDefault();
        setIsOpen((prev) => !prev);
      } else if (intent === 'open-help') {
        // Don't hijack `?` typed inside a text input.
        if (isEditableTarget(active)) return;
        event.preventDefault();
        setIsHelpOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Build the command list. Memoized so the palette doesn't see a fresh
  // array on every parent render — that would re-clamp highlightedIndex.
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    const isMac =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const cmdSym = isMac ? '⌘' : 'Ctrl+';

    // ── Actions ─────────────────────────────────────────────
    out.push({
      id: 'action-run',
      section: 'Actions',
      label: 'Run crew',
      hint: `${cmdSym}Enter`,
      icon: 'run',
      disabled: runDisabled,
      invoke: onRunCrew,
    });
    out.push({
      id: 'action-save',
      section: 'Actions',
      label: 'Save workspace',
      hint: `${cmdSym}S`,
      icon: 'save',
      disabled: saveDisabled,
      invoke: onSaveWorkspace,
    });
    out.push({
      id: 'action-settings',
      section: 'Actions',
      label: 'Open settings',
      icon: 'settings',
      invoke: () => onOpenBottomTab('workspace'),
    });
    out.push({
      id: 'action-integrations',
      section: 'Actions',
      label: 'Open integrations',
      icon: 'settings',
      invoke: () => {
        // Integrations live on /settings, a separate route. Navigate.
        if (typeof window !== 'undefined') {
          window.location.assign('/settings');
        }
      },
    });
    out.push({
      id: 'action-schedules',
      section: 'Actions',
      label: 'Open schedules',
      icon: 'settings',
      invoke: () => onOpenBottomTab('schedules'),
    });
    out.push({
      id: 'action-validation',
      section: 'Actions',
      label: 'Open validation issues',
      icon: 'settings',
      invoke: () => onOpenBottomTab('validation'),
    });
    out.push({
      id: 'action-exports',
      section: 'Actions',
      label: 'Open exports',
      icon: 'settings',
      invoke: () => onOpenBottomTab('exports'),
    });
    out.push({
      id: 'action-runs',
      section: 'Actions',
      label: 'Open runs panel',
      icon: 'run',
      invoke: () => onOpenBottomTab('runs'),
    });
    if (onDuplicateWorkspace) {
      out.push({
        id: 'action-duplicate-workspace',
        section: 'Actions',
        label: 'Duplicate current workspace',
        icon: 'workspace',
        invoke: onDuplicateWorkspace,
      });
    }

    for (const theme of THEMES) {
      out.push({
        id: `theme-${theme.id}`,
        section: 'Actions',
        label: `Switch theme: ${theme.label}`,
        hint: theme.mode,
        icon: 'theme',
        disabled: theme.id === currentThemeId,
        invoke: () => onSelectTheme(theme.id),
      });
    }

    // ── Workspaces ──────────────────────────────────────────
    for (const ws of workspaces) {
      out.push({
        id: `ws-${ws.id}`,
        section: 'Workspaces',
        label: `Workspace: ${ws.name}`,
        hint: ws.id === activeWorkspaceId ? 'Active' : undefined,
        icon: 'workspace',
        disabled: ws.id === activeWorkspaceId,
        invoke: () => onSelectWorkspace(ws.id),
      });
    }

    // ── Recent runs ─────────────────────────────────────────
    for (const run of recentRuns) {
      const idPrefix = run.id.slice(0, 8);
      out.push({
        id: `run-${run.id}`,
        section: 'Recent runs',
        label: `Run: ${idPrefix} · ${run.crewName} · ${run.status}`,
        hint: formatRelativeShort(run.startedAt),
        icon: 'run',
        invoke: () => onSelectRun(run.id),
      });
    }

    return out;
  }, [
    workspaces,
    activeWorkspaceId,
    recentRuns,
    currentThemeId,
    runDisabled,
    saveDisabled,
    onSelectWorkspace,
    onRunCrew,
    onSaveWorkspace,
    onOpenBottomTab,
    onSelectTheme,
    onSelectRun,
    onDuplicateWorkspace,
  ]);

  return {
    isOpen,
    open,
    close,
    isHelpOpen,
    openHelp,
    closeHelp,
    commands,
  };
}
