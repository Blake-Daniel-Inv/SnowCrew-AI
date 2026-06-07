'use client';

// PR 24 — Per-workspace open-tab state for the crew tab strip.
//
// Why this exists: the canvas now scopes itself to a single active
// crew (PR 23). PR 24 surfaces a tab strip that lets users keep
// multiple crews "open" and click between them. Tab list + the
// currently-active crew must persist across reloads so an interrupted
// session resumes where the user left off — but only per workspace,
// because every workspace has its own crew set.
//
// Persistence model: each workspace stores its own
// `{ openTabs, activeCrewId }` JSON under a namespaced localStorage
// key. The payload is tiny (a handful of UUIDs) so we write
// synchronously on every mutation; the alternative (debounced /
// effect-deferred writes) loses state on hard reload.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CrewStudioCrew } from '@/types';

const STORAGE_KEY_PREFIX = 'snowcrew.openCrewTabs.';

function storageKey(workspaceId: string): string {
  return `${STORAGE_KEY_PREFIX}${workspaceId}`;
}

export interface OpenTabsState {
  openTabs: string[];
  activeCrewId: string | null;
}

const EMPTY_STATE: OpenTabsState = { openTabs: [], activeCrewId: null };

/**
 * loadPersistedTabs — exported pure helper. Reads the workspace's
 * persisted tab state from localStorage and reconciles it against the
 * currently-available crews. Ghost ids (crews that were deleted in
 * another session) are filtered out so the strip never renders a
 * dangling reference. If filtering empties the list, seed with the
 * first available crew so the canvas isn't blank.
 *
 * Returns the EMPTY_STATE constant when workspaceId is null (no
 * workspace selected) or when SSR / no-window environments call us.
 */
export function loadPersistedTabs(
  workspaceId: string | null,
  availableCrews: CrewStudioCrew[]
): OpenTabsState {
  if (!workspaceId || typeof window === 'undefined') {
    return seedFromCrews(availableCrews);
  }
  let parsed: Partial<OpenTabsState> | null = null;
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId));
    if (raw) parsed = JSON.parse(raw) as Partial<OpenTabsState>;
  } catch {
    // Corrupt JSON, disabled storage, sandboxed iframe — we treat all
    // failures as "nothing persisted" and let the seed fallback run.
    parsed = null;
  }
  const availableIds = new Set(availableCrews.map((c) => c.id));
  // Filter ghosts. Preserve original ordering (the user's preferred
  // tab arrangement) rather than re-sorting alphabetically.
  const rawTabs = Array.isArray(parsed?.openTabs) ? parsed.openTabs : [];
  const filteredTabs = rawTabs.filter(
    (id): id is string => typeof id === 'string' && availableIds.has(id)
  );

  // Active crew must be in the filtered tab list (or null). If the
  // persisted active is a ghost or never matched, fall back to the
  // first remaining tab — that mirrors what the user would see if
  // they just clicked into the workspace fresh.
  let active: string | null =
    typeof parsed?.activeCrewId === 'string' ? parsed.activeCrewId : null;
  if (active === null || !filteredTabs.includes(active)) {
    active = filteredTabs[0] || null;
  }

  // If nothing survived filtering, seed with the first available
  // crew. A workspace with crews should never show an empty strip.
  if (filteredTabs.length === 0) {
    return seedFromCrews(availableCrews);
  }

  return { openTabs: filteredTabs, activeCrewId: active };
}

function seedFromCrews(availableCrews: CrewStudioCrew[]): OpenTabsState {
  const first = availableCrews[0]?.id ?? null;
  if (!first) return EMPTY_STATE;
  return { openTabs: [first], activeCrewId: first };
}

/**
 * applyOpenTab — exported pure helper. Adds crewId to the tab list
 * (idempotent — already-open tabs are no-ops on the list) and makes
 * it the active tab.
 */
export function applyOpenTab(state: OpenTabsState, crewId: string): OpenTabsState {
  if (state.openTabs.includes(crewId)) {
    if (state.activeCrewId === crewId) return state;
    return { ...state, activeCrewId: crewId };
  }
  return {
    openTabs: [...state.openTabs, crewId],
    activeCrewId: crewId,
  };
}

/**
 * applyCloseTab — exported pure helper. Removes crewId from the tab
 * list. When closing the active tab, activate the previous tab in
 * the list (or the next, if there was no previous). If the list goes
 * empty, activeCrewId becomes null.
 */
export function applyCloseTab(state: OpenTabsState, crewId: string): OpenTabsState {
  if (!state.openTabs.includes(crewId)) return state;
  const idx = state.openTabs.indexOf(crewId);
  const nextTabs = state.openTabs.filter((id) => id !== crewId);
  let nextActive: string | null = state.activeCrewId;
  if (state.activeCrewId === crewId) {
    // Prefer the previous tab; fall back to the new tab at the same
    // index (which is what was after the closed one); finally null.
    nextActive = nextTabs[idx - 1] ?? nextTabs[idx] ?? null;
  }
  return { openTabs: nextTabs, activeCrewId: nextActive };
}

/**
 * applySelectTab — exported pure helper. Sets activeCrewId. If
 * crewId isn't yet in openTabs, append it first — this lets a
 * cross-navigation request ("Open target crew →") implicitly open
 * the tab via a single call.
 */
export function applySelectTab(state: OpenTabsState, crewId: string): OpenTabsState {
  if (!state.openTabs.includes(crewId)) {
    return {
      openTabs: [...state.openTabs, crewId],
      activeCrewId: crewId,
    };
  }
  if (state.activeCrewId === crewId) return state;
  return { ...state, activeCrewId: crewId };
}

function persist(workspaceId: string | null, state: OpenTabsState): void {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(state));
  } catch {
    // localStorage quota / disabled / sandbox — swallow. The in-memory
    // state still works for the current session; the user just loses
    // persistence across reloads on this browser. A toast would be
    // noisy for a fundamentally-recoverable condition.
  }
}

export interface UseOpenCrewTabsResult {
  openTabs: string[];
  activeCrewId: string | null;
  openTab: (crewId: string) => void;
  closeTab: (crewId: string) => void;
  selectTab: (crewId: string) => void;
}

/**
 * useOpenCrewTabs — manages per-workspace tab state with localStorage
 * persistence. Composes the four pure helpers above; the hook adds
 * React-flavored state + side-effect plumbing only.
 *
 * Re-runs the load step whenever the workspaceId changes (typical:
 * user switches workspaces) so each workspace shows its own tabs.
 * Also re-loads when the crew list changes structurally (so a freshly
 * deleted crew immediately drops out of the strip).
 */
export function useOpenCrewTabs(
  workspaceId: string | null,
  availableCrews: CrewStudioCrew[]
): UseOpenCrewTabsResult {
  const [state, setState] = useState<OpenTabsState>(EMPTY_STATE);

  // Stable fingerprint of crew ids so we only re-seed when the SET
  // changes — not on every parent re-render that hands us a fresh
  // array reference. JSON.stringify is fine here; the array is tiny.
  const crewIdsKey = useMemo(
    () => availableCrews.map((c) => c.id).join('|'),
    [availableCrews]
  );

  useEffect(() => {
    setState(loadPersistedTabs(workspaceId, availableCrews));
    // We intentionally depend on the fingerprint, not the array
    // reference, to avoid the parent's render churn triggering us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, crewIdsKey]);

  // Single mutate helper — all three callbacks pipe through this so
  // persistence is exactly one localStorage write per mutation.
  const mutate = useCallback(
    (fn: (prev: OpenTabsState) => OpenTabsState) => {
      setState((prev) => {
        const next = fn(prev);
        if (next === prev) return prev;
        persist(workspaceId, next);
        return next;
      });
    },
    [workspaceId]
  );

  const openTab = useCallback(
    (crewId: string) => mutate((prev) => applyOpenTab(prev, crewId)),
    [mutate]
  );
  const closeTab = useCallback(
    (crewId: string) => mutate((prev) => applyCloseTab(prev, crewId)),
    [mutate]
  );
  const selectTab = useCallback(
    (crewId: string) => mutate((prev) => applySelectTab(prev, crewId)),
    [mutate]
  );

  return {
    openTabs: state.openTabs,
    activeCrewId: state.activeCrewId,
    openTab,
    closeTab,
    selectTab,
  };
}
