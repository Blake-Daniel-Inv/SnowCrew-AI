'use client';

/**
 * CommandPalette — global Cmd/Ctrl+K palette.
 *
 * Controlled component: the parent (via `useGlobalShortcuts`) owns the
 * `open` boolean. We just render and dismiss; we never trap focus on
 * mount when closed.
 *
 * Rendered via native `<dialog>` with showModal()/close() so we get the
 * browser's focus trap and ::backdrop for free — the same pattern as
 * IntegrationsPanel's DisconnectDialog and SchedulesPanel's
 * DeleteConfirmDialog.
 *
 * Pure helpers (`scoreMatch`, `filterCommands`) are exported so they
 * can be unit-tested in the node-environment vitest suite — the JSX is
 * intentionally separated from the matching logic.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export type CommandSection = 'Actions' | 'Workspaces' | 'Recent runs';
export type CommandIcon =
  | 'workspace'
  | 'run'
  | 'save'
  | 'settings'
  | 'theme'
  | 'search';

export interface Command {
  id: string;
  section: CommandSection;
  label: string;
  /** Optional secondary hint (keyboard shortcut, relative time, etc.). */
  hint?: string;
  icon?: CommandIcon;
  /** True hides the row entirely. We don't render disabled rows because
   * the user has no recovery path — the help modal documents why. */
  disabled?: boolean;
  invoke: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

/* ------------------------------------------------------------------ */
/*  Pure helpers — exported for testing                                */
/* ------------------------------------------------------------------ */

/**
 * Sub-string fuzzy score. Returns null when at least one query char
 * doesn't appear (in order) in the haystack. Higher score = better
 * match; the algorithm weights:
 *   - contiguous-character runs (heavily)
 *   - matches near the start
 *   - shorter haystacks (small tiebreaker)
 * Case-insensitive.
 */
export function scoreMatch(haystack: string, query: string): number | null {
  if (!query) return 0;
  const hay = haystack.toLowerCase();
  const q = query.toLowerCase();

  let hi = 0;
  let score = 0;
  let lastMatch = -2;
  let firstMatch = -1;
  // Track number of consecutive matches at the current run so we can
  // award bigger bumps for longer contiguous runs (foo→"foobar" beats
  // foo→"f.o.o.bar").
  let runLen = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q.charAt(qi);
    let found = -1;
    while (hi < hay.length) {
      if (hay.charAt(hi) === ch) {
        found = hi;
        hi++;
        break;
      }
      hi++;
    }
    if (found === -1) return null;

    if (firstMatch === -1) firstMatch = found;

    if (found === lastMatch + 1) {
      runLen++;
      score += 8 + runLen * 2; // contiguous run bonus grows quadratically
    } else {
      runLen = 0;
      score += 1;
      // Penalize gaps between matches; a missed contiguous slot costs more
      // than a forward jump over many chars (which is just "later in the
      // word").
      const gap = found - lastMatch - 1;
      if (lastMatch !== -2) score -= Math.min(gap, 6) * 0.5;
    }
    lastMatch = found;
  }

  // Start-of-string bonus and shorter-haystack tiebreaker.
  if (firstMatch === 0) score += 5;
  score += Math.max(0, 8 - haystack.length * 0.05);
  return score;
}

/**
 * Filter a command list down to matches for `query`, preserving the
 * canonical section ordering and stable input ordering for equal
 * scores. Empty query returns all enabled commands unchanged.
 */
export function filterCommands(
  commands: Command[],
  query: string
): Command[] {
  const enabled = commands.filter((c) => !c.disabled);
  if (!query.trim()) return enabled;

  type Scored = { cmd: Command; score: number; index: number };
  const scored: Scored[] = [];
  for (let i = 0; i < enabled.length; i++) {
    const cmd = enabled[i];
    // Match against the label primarily but fall back to the section
    // name so e.g. typing "rec" surfaces every "Recent runs" entry.
    const labelScore = scoreMatch(cmd.label, query);
    const sectionScore = scoreMatch(cmd.section, query);
    const best =
      labelScore === null
        ? sectionScore
        : sectionScore === null
          ? labelScore
          : Math.max(labelScore, sectionScore * 0.5);
    if (best !== null) scored.push({ cmd, score: best, index: i });
  }

  // Section order is canonical; within a section we sort by score then
  // input order so the result is deterministic.
  const SECTION_ORDER: CommandSection[] = [
    'Actions',
    'Workspaces',
    'Recent runs',
  ];
  scored.sort((a, b) => {
    const sa = SECTION_ORDER.indexOf(a.cmd.section);
    const sb = SECTION_ORDER.indexOf(b.cmd.section);
    if (sa !== sb) return sa - sb;
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored.map((s) => s.cmd);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // The element focused right before the palette opened. We restore
  // focus there on close so the user doesn't lose their context. The
  // native <dialog> handles focus-trap inside the dialog; restoration
  // is on us.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const visible = useMemo(
    () => filterCommands(commands, query),
    [commands, query]
  );

  // Reset query + highlight whenever the palette transitions to open,
  // and snapshot the previously-focused element so we can restore on
  // close. The setState-in-effect is intentional here — this is the
  // canonical "synchronize state from a prop transition" case; the
  // alternative (key-based remount) would tear down the native <dialog>
  // every open/close cycle and lose ::backdrop animation continuity.
  useEffect(() => {
    if (!open) return;
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      restoreFocusRef.current =
        active instanceof HTMLElement ? active : null;
    }
    /* eslint-disable react-hooks/set-state-in-effect */
    setQuery('');
    setHighlightedIndex(0);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open]);

  // Lifecycle: open/close the native dialog in sync with the prop.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          // already-open via SSR hydration — fine
        }
      }
      // Move focus to the search input on the next tick so the dialog's
      // own initial-focus heuristic doesn't fight us.
      const t = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Wire the native `cancel` event (ESC) to our close handler so the
  // parent always learns about dismissal. We `preventDefault` so the
  // native close happens via our state path, not the browser's
  // self-close (which would skip the focus-restoration step).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function onCancel(event: Event) {
      event.preventDefault();
      onClose();
    }
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);

  // Restore focus when the palette closes.
  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      // Defer so the dialog's `close()` has fully settled focus first.
      const t = window.setTimeout(() => {
        try {
          target.focus();
        } catch {
          /* element may have been removed */
        }
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // Clamp the highlighted index when the filtered list shrinks. Done
  // as a derived value instead of a setState-in-effect so we don't pay
  // for a second render every time the filter narrows the result set.
  const effectiveHighlight =
    visible.length === 0
      ? 0
      : Math.min(highlightedIndex, visible.length - 1);

  // Scroll the highlighted row into view on arrow-key navigation.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-cmd-index="${effectiveHighlight}"]`
    );
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [effectiveHighlight, open]);

  const invokeAt = useCallback(
    (idx: number) => {
      const cmd = visible[idx];
      if (!cmd) return;
      // Close before invoking so the invoked action (e.g. switching
      // bottomTab) takes effect against the palette-less app.
      onClose();
      // Defer to next microtask so the close-state has propagated.
      window.setTimeout(() => cmd.invoke(), 0);
    },
    [visible, onClose]
  );

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex(() =>
          visible.length === 0 ? 0 : Math.min(visible.length - 1, effectiveHighlight + 1)
        );
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex(() => Math.max(0, effectiveHighlight - 1));
      } else if (event.key === 'Home') {
        event.preventDefault();
        setHighlightedIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setHighlightedIndex(Math.max(0, visible.length - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        invokeAt(effectiveHighlight);
      } else if (event.key === 'Tab') {
        // Tab autocompletes the current highlight's label into the input.
        const cmd = visible[effectiveHighlight];
        if (cmd) {
          event.preventDefault();
          setQuery(cmd.label);
        }
      }
      // Esc is handled by the native <dialog> `cancel` event above.
    },
    [visible, effectiveHighlight, invokeAt]
  );

  // Click outside the inner content closes. The native <dialog> fills
  // the viewport; presses on the backdrop have `event.target === dialog`.
  const handleDialogClick = useCallback(
    (event: ReactMouseEvent<HTMLDialogElement>) => {
      if (event.target === dialogRef.current) onClose();
    },
    [onClose]
  );

  // Section grouping for render. We walk `visible` and slice it into
  // sections so we can emit headers between groups. Order is implicit:
  // filterCommands already sorted by section.
  const sections = useMemo(() => {
    const groups: Array<{ section: CommandSection; items: Command[]; startIndex: number }> = [];
    for (let i = 0; i < visible.length; i++) {
      const cmd = visible[i];
      const last = groups[groups.length - 1];
      if (!last || last.section !== cmd.section) {
        groups.push({ section: cmd.section, items: [cmd], startIndex: i });
      } else {
        last.items.push(cmd);
      }
    }
    return groups;
  }, [visible]);

  const listboxId = 'command-palette-listbox';
  const activeDescendantId =
    visible.length > 0 ? `command-palette-row-${effectiveHighlight}` : undefined;

  return (
    <dialog
      ref={dialogRef}
      className="command-palette-dialog"
      aria-label="Command palette"
      onClick={handleDialogClick}
    >
      <div className="command-palette-body">
        <div className="command-palette-input-row">
          <CommandIconSvg icon="search" />
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Type a command or search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            aria-label="Command palette search"
            aria-controls={listboxId}
            aria-activedescendant={activeDescendantId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div
          className="command-palette-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {visible.length === 0
            ? 'No results'
            : `${visible.length} result${visible.length === 1 ? '' : 's'}`}
        </div>
        <ul
          ref={listRef}
          id={listboxId}
          className="command-palette-list"
          role="listbox"
          aria-label="Commands"
        >
          {sections.map((group) => (
            <li
              key={group.section}
              className="command-palette-section"
              role="presentation"
            >
              <div className="command-palette-section-label" aria-hidden="true">
                {group.section}
              </div>
              <ul role="group" aria-label={group.section}>
                {group.items.map((cmd, j) => {
                  const idx = group.startIndex + j;
                  const isHighlighted = idx === effectiveHighlight;
                  return (
                    <li
                      key={cmd.id}
                      id={`command-palette-row-${idx}`}
                      className={`command-palette-row ${isHighlighted ? 'is-highlighted' : ''}`}
                      role="option"
                      aria-selected={isHighlighted}
                      data-cmd-index={idx}
                      onMouseEnter={() => setHighlightedIndex(idx)}
                      onClick={() => invokeAt(idx)}
                    >
                      <span className="command-palette-row-icon" aria-hidden="true">
                        <CommandIconSvg icon={cmd.icon} />
                      </span>
                      <span className="command-palette-row-label">{cmd.label}</span>
                      {cmd.hint && (
                        <span className="command-palette-row-hint">{cmd.hint}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="command-palette-empty" role="presentation">
              No matches. Try a different query.
            </li>
          )}
        </ul>
      </div>
    </dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Icons — inline SVG, ~14px square                                   */
/* ------------------------------------------------------------------ */

function CommandIconSvg({ icon }: { icon?: CommandIcon }) {
  const props = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (icon) {
    case 'workspace':
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      );
    case 'run':
      return (
        <svg {...props} fill="currentColor" stroke="none">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      );
    case 'save':
      return (
        <svg {...props}>
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9 1.65 1.65 0 0 0 21 10h.09a2 2 0 0 1 0 4H21a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case 'theme':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3v18" />
          <path d="M3 12h18" />
        </svg>
      );
    case 'search':
    default:
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
  }
}
