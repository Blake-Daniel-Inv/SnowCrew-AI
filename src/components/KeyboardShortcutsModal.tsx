'use client';

/**
 * KeyboardShortcutsModal — `?` help modal.
 *
 * Triggered by useGlobalShortcuts when `?` is pressed inside the app
 * shell and NOT inside a text input. Renders a documentation-only list
 * of the shortcuts the app supports.
 *
 * Same controlled-dialog pattern as CommandPalette / IntegrationsPanel.
 */
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  SHORTCUT_ENTRIES,
  type KeyboardShortcutEntry,
} from './keyboardShortcuts';

export interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
  /** True on macOS so we render ⌘ instead of Ctrl+. Defaults to runtime check. */
  isMac?: boolean;
}

export function KeyboardShortcutsModal({
  open,
  onClose,
  isMac,
}: KeyboardShortcutsModalProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const effectiveIsMac =
    typeof isMac === 'boolean'
      ? isMac
      : typeof navigator !== 'undefined' &&
        /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (typeof document !== 'undefined') {
        const active = document.activeElement;
        restoreFocusRef.current =
          active instanceof HTMLElement ? active : null;
      }
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          /* already open via SSR — fine */
        }
      }
      const t = window.setTimeout(() => closeBtnRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

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

  // Restore focus to wherever it was when the modal opened.
  useEffect(() => {
    if (!open && restoreFocusRef.current) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      const t = window.setTimeout(() => {
        try {
          target.focus();
        } catch {
          /* may have been removed */
        }
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDialogElement>) => {
      if (event.target === dialogRef.current) onClose();
    },
    [onClose]
  );

  return (
    <dialog
      ref={dialogRef}
      className="keyboard-shortcuts-dialog"
      aria-labelledby="keyboard-shortcuts-title"
      onClick={handleClick}
    >
      <div className="keyboard-shortcuts-body">
        <header className="keyboard-shortcuts-header">
          <h2 id="keyboard-shortcuts-title" className="keyboard-shortcuts-title">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="keyboard-shortcuts-close"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <dl className="keyboard-shortcuts-list">
          {SHORTCUT_ENTRIES.map((entry) => (
            <ShortcutRow key={entry.id} entry={entry} isMac={effectiveIsMac} />
          ))}
        </dl>

        <footer className="keyboard-shortcuts-footer">
          Greyed entries are documented but not yet wired up.
        </footer>
      </div>
    </dialog>
  );
}

function ShortcutRow({
  entry,
  isMac,
}: {
  entry: KeyboardShortcutEntry;
  isMac: boolean;
}) {
  const status = entry.future ? 'is-future' : '';
  return (
    <div className={`keyboard-shortcuts-row ${status}`}>
      <dt className="keyboard-shortcuts-keys">
        {entry.keys(isMac).map((part, i) => (
          <span key={`${entry.id}-${i}`}>
            <kbd className="keyboard-shortcut-key">{part}</kbd>
            {i < entry.keys(isMac).length - 1 && (
              <span className="keyboard-shortcuts-keys-sep" aria-hidden="true">
                {' '}
                +{' '}
              </span>
            )}
          </span>
        ))}
      </dt>
      <dd className="keyboard-shortcuts-desc">
        {entry.label}
        {entry.future && (
          <span className="keyboard-shortcuts-future-tag"> · planned</span>
        )}
      </dd>
    </div>
  );
}
