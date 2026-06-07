'use client';

// PR 24 — Snowsight-worksheet-style horizontal tab strip rendered at
// the top of the canvas area. Each open crew is a tab; multiple crews
// can be open simultaneously; clicking switches the active crew, X
// closes the view (workspace data is untouched).
//
// The component is purely presentational: state lives in
// `useOpenCrewTabs` (Stream B) and the parent (CrewStudioApp, Stream C)
// wires the inputs and callbacks. The only owned local state is the
// "+" popover open/close flag and roving focus tracking.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { CrewStudioCrew } from '@/types';

// Visible-name truncation. ~28 chars is the upper bound the spec calls
// out — long enough to read "Coordinator: market research workflow"
// and short enough that 5 tabs fit comfortably on a 1280-wide canvas.
const TAB_LABEL_MAX = 28;

/**
 * formatTabLabel — exported pure helper. Truncates a crew name to
 * TAB_LABEL_MAX chars with an ellipsis. Names that are already short
 * pass through unchanged; whitespace is trimmed so " hello " doesn't
 * spend two of its character budget on edges.
 */
export function formatTabLabel(name: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed.length <= TAB_LABEL_MAX) return trimmed;
  // -1 for the ellipsis; we render an actual ellipsis char rather than
  // "..." so the visual width matches typical truncation conventions.
  return trimmed.slice(0, TAB_LABEL_MAX - 1) + '…';
}

/**
 * canCloseTab — exported pure helper. Returns false when this is the
 * last (or only) open tab so the X is disabled and a misclick can't
 * leave the canvas empty. Also false when the crewId isn't in the
 * open-tab list (defensive — callers should never reach that branch).
 */
export function canCloseTab(openTabs: string[], crewId: string): boolean {
  if (openTabs.length <= 1) return false;
  return openTabs.includes(crewId);
}

export interface CrewTabsStripProps {
  /** All crews in the workspace — feeds the "+" popover menu. */
  crews: CrewStudioCrew[];
  /** Crew ids currently rendered as tabs, in display order. */
  openTabs: string[];
  /** Which tab is the active selection; null when no tab is selected. */
  activeCrewId: string | null;
  onSelectTab: (crewId: string) => void;
  onCloseTab: (crewId: string) => void;
  /** Opens an additional tab via the "+" popover. */
  onOpenTab: (crewId: string) => void;
}

export function CrewTabsStrip({
  crews,
  openTabs,
  activeCrewId,
  onSelectTab,
  onCloseTab,
  onOpenTab,
}: CrewTabsStripProps) {
  const popoverId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Index lookup so per-tab handlers don't pay an O(n) findIndex.
  const tabIndexById = useMemo(() => {
    const map = new Map<string, number>();
    openTabs.forEach((id, i) => map.set(id, i));
    return map;
  }, [openTabs]);

  // Crews available to open: anything not already in openTabs.
  const openableCrews = useMemo(
    () => crews.filter((c) => !openTabs.includes(c.id)),
    [crews, openTabs]
  );

  // Close the "+" popover on ESC + outside click — mirrors the
  // workspace-selector dropdown pattern used elsewhere in this app.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        plusBtnRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Roving-focus arrow-key handler. role="tablist" expects this; we
  // also wire Home / End for full keyboard navigation. The clicked
  // tab handles Enter/Space implicitly because it's a <button>.
  const handleTabKey = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, crewId: string) => {
      const i = tabIndexById.get(crewId);
      if (i === undefined) return;
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight') nextIndex = (i + 1) % openTabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (i - 1 + openTabs.length) % openTabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = openTabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      const nextId = openTabs[nextIndex];
      if (!nextId) return;
      onSelectTab(nextId);
      // Move physical focus to the newly-active tab so screen readers
      // and keyboard users see the selection move with their cursor.
      const root = stripRef.current;
      if (!root) return;
      const btn = root.querySelector<HTMLButtonElement>(`[data-tab-id="${nextId}"]`);
      btn?.focus();
    },
    [tabIndexById, openTabs, onSelectTab]
  );

  // Empty state — no crews and no open tabs. We render an empty strip
  // (rather than null) so the canvas layout doesn't jump when the
  // first crew is created.
  if (crews.length === 0 && openTabs.length === 0) {
    return (
      <div className="crew-tabs-strip crew-tabs-strip-empty" role="tablist" aria-label="Open crews" />
    );
  }

  return (
    <div
      ref={stripRef}
      className="crew-tabs-strip"
      role="tablist"
      aria-label="Open crews"
    >
      {openTabs.map((crewId) => {
        const crew = crews.find((c) => c.id === crewId);
        // A crew id that's no longer in `crews` shouldn't appear here
        // (the hook filters ghosts on load), but guard anyway so a
        // mid-edit deletion doesn't crash render.
        const label = formatTabLabel(crew?.name || 'Untitled crew');
        const active = crewId === activeCrewId;
        const closeable = canCloseTab(openTabs, crewId);
        return (
          <div key={crewId} className={`crew-tab ${active ? 'crew-tab-active' : ''}`}>
            <button
              type="button"
              role="tab"
              data-tab-id={crewId}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className="crew-tab-btn"
              onClick={() => onSelectTab(crewId)}
              onKeyDown={(event) => handleTabKey(event, crewId)}
              title={crew?.name || 'Untitled crew'}
            >
              {label}
            </button>
            <button
              type="button"
              className="crew-tab-close"
              aria-label={`Close ${crew?.name || 'Untitled'} tab`}
              disabled={!closeable}
              title={closeable ? 'Close tab' : 'Cannot close the last open tab'}
              onClick={() => {
                if (closeable) onCloseTab(crewId);
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}

      {/* "+" button — opens a popover listing crews not yet in tabs. */}
      <div className="crew-tabs-add" ref={menuRef}>
        <button
          type="button"
          ref={plusBtnRef}
          className="crew-tab-add-btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={popoverId}
          aria-label="Open another crew as a tab"
          disabled={openableCrews.length === 0}
          title={
            openableCrews.length === 0
              ? 'All crews are already open'
              : 'Open another crew as a tab'
          }
          onClick={() => setMenuOpen((v) => !v)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        {menuOpen && openableCrews.length > 0 && (
          <div className="crew-tabs-popover" id={popoverId} role="menu">
            {openableCrews.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                className="crew-tabs-popover-item"
                onClick={() => {
                  onOpenTab(c.id);
                  setMenuOpen(false);
                  // Return focus to the "+" button so keyboard users
                  // don't lose their place after the popover closes.
                  plusBtnRef.current?.focus();
                }}
                title={c.name}
              >
                {formatTabLabel(c.name)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
