// Inline banner shown above the RunPanel when the SSE stream has failed
// 3+ times. Surfaces a manual retry plus a live "Xs ago" staleness label.
import { useEffect, useState } from 'react';

/**
 * Small inline banner shown above the RunPanel when the run-stream
 * SSE connection has failed three or more times in a row. Tells the
 * user updates are stalled, offers a manual reconnect, and shows a
 * live-counting "seconds since last update" so they know how stale
 * the trace is. We deliberately keep this unobtrusive — runs still
 * complete on the server even while we're disconnected.
 */
export function StreamDisconnectedBanner({
  lastEventAt,
  onRetry,
}: {
  lastEventAt: number | null;
  onRetry: () => void;
}) {
  // Tick once a second to keep the "Xs ago" label fresh. Cheap because
  // it's a single setState and the banner only renders when visible.
  // Date.now() is captured inside the effect (not during render) to
  // satisfy React 19's purity rules.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsAgo = lastEventAt
    ? Math.max(0, Math.round((now - lastEventAt) / 1000))
    : null;

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 12px',
        margin: '8px 12px 0',
        borderRadius: 6,
        background: 'var(--color-warning-bg, rgba(255, 200, 80, 0.12))',
        border: '1px solid var(--color-warning-border, rgba(255, 200, 80, 0.4))',
        fontSize: 13,
      }}
    >
      <span>
        Run updates disconnected.
        {secondsAgo !== null ? ` Last update ${secondsAgo}s ago.` : ''}
      </span>
      <button
        type="button"
        className="toolbar-btn"
        onClick={onRetry}
      >
        Retry now
      </button>
    </div>
  );
}
