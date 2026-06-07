/**
 * Authoritative list of keyboard shortcuts the app advertises in the
 * `?` help modal. Each entry is a description + a pure mapper from
 * `isMac` to the printable key parts.
 *
 * `future: true` marks shortcuts that are documented but not wired up
 * yet (the help modal renders them greyed). We chose to surface them
 * anyway so the help is forward-compatible and discoverable.
 */

export interface KeyboardShortcutEntry {
  id: string;
  /** Returns the printable key parts, e.g. ['⌘', 'K']. */
  keys: (isMac: boolean) => string[];
  label: string;
  /** True when the binding is documented but not yet implemented. */
  future?: boolean;
}

export const SHORTCUT_ENTRIES: KeyboardShortcutEntry[] = [
  {
    id: 'cmd-k',
    keys: (isMac) => (isMac ? ['⌘', 'K'] : ['Ctrl', 'K']),
    label: 'Open command palette',
  },
  {
    id: 'cmd-s',
    keys: (isMac) => (isMac ? ['⌘', 'S'] : ['Ctrl', 'S']),
    label: 'Save workspace',
    // Wire-up lives in useGlobalShortcuts callers — not bound globally yet.
    future: true,
  },
  {
    id: 'cmd-enter',
    keys: (isMac) => (isMac ? ['⌘', 'Enter'] : ['Ctrl', 'Enter']),
    label: 'Run crew',
    future: true,
  },
  {
    id: 'question',
    keys: () => ['?'],
    label: 'Show this help',
  },
  {
    id: 'escape',
    keys: () => ['Esc'],
    label: 'Close current dialog',
  },
  {
    id: 'arrows',
    keys: () => ['↑', '↓'],
    label: 'Navigate (in lists and the command palette)',
  },
  {
    id: 'enter',
    keys: () => ['Enter'],
    label: 'Invoke highlighted command',
  },
  {
    id: 'tab',
    keys: () => ['Tab'],
    label: 'Autocomplete highlighted label (in command palette)',
  },
];

/**
 * Pure mapper from a key event signature → the matching shortcut id,
 * or null. Exposed for testing so we can verify the help-modal contents
 * stay in sync with the global listener's behavior.
 */
export function keyEventToShortcutId(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  isMac: boolean
): string | null {
  const primaryMod = isMac ? event.metaKey : event.ctrlKey;
  if (primaryMod && (event.key === 'k' || event.key === 'K')) return 'cmd-k';
  if (primaryMod && (event.key === 's' || event.key === 'S')) return 'cmd-s';
  if (primaryMod && event.key === 'Enter') return 'cmd-enter';
  if (
    !event.metaKey &&
    !event.ctrlKey &&
    (event.key === '?' || (event.shiftKey && event.key === '/'))
  ) {
    return 'question';
  }
  if (event.key === 'Escape') return 'escape';
  return null;
}
