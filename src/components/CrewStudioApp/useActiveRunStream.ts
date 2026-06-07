// SSE wiring for the active run: opens EventSource with withCredentials,
// applies exponential-backoff reconnect, refetches snapshot on reconnect,
// and exposes a manual retry handle.
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { CrewRun, TraceEvent } from '@/types';

const MAX_CLIENT_EVENTS = 1_000;
// 8 attempts × 30s cap ≈ ~3 minutes of automatic reconnects before we give
// up and require the user to press "Retry now". Prevents the SSE loop from
// hammering a permanently-down endpoint forever.
const MAX_RECONNECT_ATTEMPTS = 8;

export function useActiveRunStream(
  activeRunId: string | null,
  setActiveRun: Dispatch<SetStateAction<CrewRun | null>>
) {
  // SSE health: true once the run stream has failed 3+ times in a row.
  // We surface this as a small banner with a manual "Retry now" button so
  // the user knows their run-trace updates may be stale and can recover
  // without reloading the page.
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  // Last-seen timestamp for stream events. Drives the "Last update Xs ago"
  // text inside the banner.
  const [streamLastEventAt, setStreamLastEventAt] = useState<number | null>(null);
  // Bumped by the "Retry now" button to force the SSE effect to reopen
  // a connection immediately, bypassing the pending backoff timer.
  const [streamRetryNonce, setStreamRetryNonce] = useState(0);

  /* --- active run stream shared by canvas + run panel ---
   *
   * Reconnect strategy: on error, close the EventSource, increment a
   * consecutive-fail counter, and reopen after exp backoff (1s → 30s
   * cap). After 3 failures we surface a banner with a "Retry now"
   * button. After each (post-first) reconnect we refetch the run
   * snapshot via GET /api/runs/<id> to recover any events emitted
   * while we were disconnected — server-side Last-Event-ID handling
   * is a future story. The 'end' event signals a clean close and
   * resets the counter / stops reconnecting.
   */
  useEffect(() => {
    if (!activeRunId) {
      // Legitimate reset-on-id-change: clearing local stream state when
      // the parent unselects the active run. React 19's stricter rule
      // flags this even though it's the documented synchronize-with-
      // external pattern from the docs.
      setActiveRun(null);
      /* eslint-disable react-hooks/set-state-in-effect */
      setStreamDisconnected(false);
      setStreamLastEventAt(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    const runId = activeRunId;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let failCount = 0;
    let stopped = false;

    const markEvent = () => {
      setStreamLastEventAt(Date.now());
    };

    function open() {
      if (stopped) return;
      // EventSource needs withCredentials:true so the cookie/header-based
      // auth set by the middleware travels with the request. Without it
      // the stream endpoint gets an unauthenticated call and returns 401.
      source = new EventSource(`/api/runs/${runId}/stream`, {
        withCredentials: true,
      });

      source.addEventListener('snapshot', (event) => {
        markEvent();
        const data = JSON.parse((event as MessageEvent).data) as CrewRun;
        if (!stopped) setActiveRun(data);
      });

      source.addEventListener('event', (event) => {
        markEvent();
        const data = JSON.parse((event as MessageEvent).data) as {
          type: 'event';
          runId: string;
          event: TraceEvent;
        };
        setActiveRun((current) => {
          if (!current || current.id !== data.runId) return current;
          if (current.events.some((ev) => ev.id === data.event.id)) return current;
          const nextEvents = [...current.events, data.event];
          if (nextEvents.length > MAX_CLIENT_EVENTS) {
            return {
              ...current,
              events: [
                ...nextEvents.slice(0, 1),
                ...nextEvents.slice(-Math.floor(MAX_CLIENT_EVENTS / 2)),
              ],
            };
          }
          return { ...current, events: nextEvents };
        });
      });

      source.addEventListener('output', (event) => {
        markEvent();
        const data = JSON.parse((event as MessageEvent).data) as {
          type: 'output';
          runId: string;
          chunk: string;
        };
        setActiveRun((current) => {
          if (!current || current.id !== data.runId) return current;
          return { ...current, output: current.output + data.chunk };
        });
      });

      source.addEventListener('status', (event) => {
        markEvent();
        const data = JSON.parse((event as MessageEvent).data) as {
          type: 'status';
          runId: string;
          run: CrewRun;
        };
        setActiveRun((current) => {
          if (!current || current.id !== data.runId) return current;
          return {
            ...current,
            status: data.run.status,
            exitCode: data.run.exitCode,
            completedAt: data.run.completedAt,
            error: data.run.error,
          };
        });
      });

      source.addEventListener('metrics', (event) => {
        markEvent();
        const data = JSON.parse((event as MessageEvent).data) as {
          type: 'metrics';
          runId: string;
          metrics: CrewRun['metrics'];
        };
        setActiveRun((current) => {
          if (!current || current.id !== data.runId) return current;
          return { ...current, metrics: data.metrics };
        });
      });

      // Terminal marker from the server: stop reconnecting and clear
      // any pending failure banner. The status event preceding this
      // already updated `activeRun.status`, but we also accept the
      // status from the end payload defensively in case it raced.
      source.addEventListener('end', (event) => {
        markEvent();
        try {
          const data = JSON.parse((event as MessageEvent).data) as {
            status?: CrewRun['status'];
          };
          if (data?.status) {
            setActiveRun((current) =>
              current && current.id === runId
                ? { ...current, status: data.status as CrewRun['status'] }
                : current
            );
          }
        } catch {
          /* malformed end payload — still treat as a clean close */
        }
        stopped = true;
        failCount = 0;
        setStreamDisconnected(false);
        if (source) {
          source.close();
          source = null;
        }
      });

      source.onopen = () => {
        // A successful (re)open clears the failure tally. We keep the
        // banner visible until the FIRST event arrives (markEvent above
        // re-clears) so it doesn't flicker if the connection was opened
        // but immediately dies again.
        failCount = 0;
      };

      source.onerror = () => {
        if (stopped) return;
        failCount += 1;
        if (failCount >= 3) {
          setStreamDisconnected(true);
        }
        if (source) {
          source.close();
          source = null;
        }
        // After MAX_RECONNECT_ATTEMPTS we stop scheduling new reconnects.
        // The banner stays visible — the user's only path back is the
        // "Retry now" button, which bumps streamRetryNonce and re-runs
        // the effect with a fresh failCount of 0.
        if (failCount >= MAX_RECONNECT_ATTEMPTS) {
          stopped = true;
          return;
        }
        const delay = Math.min(1000 * 2 ** (failCount - 1), 30_000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void reconnect();
        }, delay);
      };
    }

    async function reconnect() {
      if (stopped) return;
      // The server-side SSE start always emits a 'snapshot' event as its
      // first frame, so a separate REST snapshot fetch here is redundant
      // and causes a race where the REST response can clobber events
      // received over the freshly-reopened SSE.
      open();
    }

    open();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (source) source.close();
      setStreamDisconnected(false);
    };
  }, [activeRunId, streamRetryNonce, setActiveRun]);

  /**
   * Manual "Retry now" handler — exposed via the disconnect banner.
   * Resetting the nonce re-runs the effect immediately and skips any
   * pending backoff timer. */
  const retryStreamNow = useCallback(() => {
    setStreamDisconnected(false);
    setStreamRetryNonce((n) => n + 1);
  }, []);

  return {
    streamDisconnected,
    streamLastEventAt,
    retryStreamNow,
  };
}
