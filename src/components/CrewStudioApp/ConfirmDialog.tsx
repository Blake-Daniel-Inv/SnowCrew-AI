// Accessible in-app replacement for window.confirm with focus trap and
// Escape-to-cancel.
import { useEffect, useRef } from 'react';

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Stash the latest cancel handler in a ref so the focus-trap effect can
  // stay mounted across parent re-renders. Without this the parent's
  // inline `() => setPendingConfirm(null)` would invalidate the effect
  // every render, thrashing focus restoration.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previouslyFocused =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    const focusTimer = window.setTimeout(() => {
      confirmBtnRef.current?.focus();
    }, 0);

    function getFocusable(): HTMLElement[] {
      const root = dialogRef.current;
      if (!root) return [];
      const selectors =
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(root.querySelectorAll<HTMLElement>(selectors)).filter(
        (el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inDialog = active ? dialogRef.current?.contains(active) ?? false : false;
      if (event.shiftKey) {
        if (active === first || !inDialog) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      // If the previously-focused element is still in the DOM, restore
      // focus to it. Otherwise (e.g. the originating node was deleted by
      // the confirm action) fall back to the app root so focus doesn't
      // land on document.body and lose all keyboard context.
      const target = previouslyFocused;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        const appRoot = document.querySelector('[data-app-root]') as HTMLElement | null;
        (appRoot || document.body).focus?.();
      }
    };
  }, []);

  return (
    <div
      className="run-output-popout-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
    >
      <div
        ref={dialogRef}
        className="run-output-popout"
        style={{ width: 'min(420px, calc(100vw - 56px))', height: 'auto' }}
        tabIndex={-1}
      >
        <div className="run-output-popout-header">
          <div>
            <div id="confirm-dialog-title" className="run-output-popout-title">{title}</div>
          </div>
        </div>
        <div style={{ padding: '16px 20px' }}>
          <div id="confirm-dialog-message" className="run-output-popout-meta" style={{ fontSize: 13 }}>
            {message}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              marginTop: 20,
            }}
          >
            <button
              type="button"
              className="toolbar-btn"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              ref={confirmBtnRef}
              type="button"
              className="toolbar-btn-primary"
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
