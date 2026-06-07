// PR 10: Non-dismissible conflict modal shown after a 412 from
// PATCH /api/workspaces/[id]. Mirrors the focus-trap + Escape-to-cancel
// pattern in ConfirmDialog so a11y stays consistent across the app.
//
// Why a separate component:
//   - This dialog has a fixed, non-dismissible shape (two specific
//     buttons, fixed copy framing the concurrent-edit case). Threading
//     all of that through ConfirmDialog would dilute the latter into
//     a generic modal.
//   - The "Cancel keeps the draft but doesn't dismiss the conflict"
//     contract is route-specific: Cancel hides the dialog but the next
//     save attempt will hit 412 again. ConfirmDialog's onCancel is a
//     terminal "user said no" signal, not "user wants to keep editing
//     in a doomed state".
import { useEffect, useRef } from 'react';

/**
 * Render a relative-time blurb like "30 seconds ago" so the user has
 * concrete context for *when* the conflict landed. Falls back to "just
 * now" if the timestamp can't be parsed (defensive — the server always
 * sends ISO strings).
 */
function formatRelative(isoTimestamp: string | null): string {
  if (!isoTimestamp) return 'just now';
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return 'just now';
  const deltaSec = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec} seconds ago`;
  if (deltaSec < 3600) {
    const m = Math.round(deltaSec / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  const h = Math.round(deltaSec / 3600);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

export function ConflictDialog({
  serverUpdatedAt,
  onReload,
  onCancel,
  reloading,
}: {
  /** ISO string the server reported as its current updatedAt in the
   * 412 body. Used only for the relative-time blurb in the body copy. */
  serverUpdatedAt: string | null;
  /** Primary action — refetch GET /api/workspaces/[id] and replace the
   * in-memory workspace state with the server's copy. The parent owns
   * the actual reload + dirty-flag reset. */
  onReload: () => void;
  /** Secondary action — close the modal but keep the draft state. The
   * next save attempt will hit 412 again; this is intentional. */
  onCancel: () => void;
  /** When true, disable both buttons + show "Reloading..." copy on the
   * primary button. Parent flips this around the GET round-trip. */
  reloading: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const reloadBtnRef = useRef<HTMLButtonElement>(null);
  // Stash the latest cancel handler in a ref so the focus-trap effect
  // can stay mounted across parent re-renders. Without this, parent's
  // inline arrow function would invalidate the effect every render,
  // thrashing focus restoration.
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previouslyFocused =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    const focusTimer = window.setTimeout(() => {
      reloadBtnRef.current?.focus();
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
        // ESC closes equivalent to Cancel — matches ConfirmDialog and
        // user expectations for any modal.
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
      const target = previouslyFocused;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        const appRoot = document.querySelector('[data-app-root]') as HTMLElement | null;
        (appRoot || document.body).focus?.();
      }
    };
  }, []);

  const relative = formatRelative(serverUpdatedAt);

  return (
    <div
      className="run-output-popout-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-dialog-title"
      aria-describedby="conflict-dialog-message"
    >
      <div
        ref={dialogRef}
        className="run-output-popout"
        style={{ width: 'min(460px, calc(100vw - 56px))', height: 'auto' }}
        tabIndex={-1}
      >
        <div className="run-output-popout-header">
          <div>
            <div id="conflict-dialog-title" className="run-output-popout-title">
              Workspace updated in another tab
            </div>
          </div>
        </div>
        <div style={{ padding: '16px 20px' }}>
          <div
            id="conflict-dialog-message"
            className="run-output-popout-meta"
            style={{ fontSize: 13 }}
          >
            Someone else (or another tab) saved changes to this workspace {relative}.
            Reload to see the latest version. Your unsaved edits will be lost.
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
              disabled={reloading}
            >
              Cancel
            </button>
            <button
              ref={reloadBtnRef}
              type="button"
              className="toolbar-btn-primary"
              onClick={onReload}
              disabled={reloading}
            >
              {reloading ? 'Reloading...' : 'Reload workspace'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
