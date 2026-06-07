'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import type { CrewRun, CrewRunSummary, CrewStudioWorkspace, TraceEvent } from '@/types';
import { extractCleanRunOutput, markdownToSafeHtml } from '@/lib/run-output';
import {
  groupSubCrewEvents,
  SubCrewEventGroup,
} from './RunPanel/SubCrewEventGroup';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function statusClass(status: CrewRun['status']): string {
  return `run-status run-status-${status}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  if (n > 0) return `<$0.01`;
  return '$0.00';
}

function formatCredits(n: number): string {
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  if (n > 0) return n.toFixed(4);
  return '0';
}

function MetricsBar({ run }: { run: CrewRun }) {
  const metrics = run.metrics;
  if (!metrics || metrics.totals.callCount === 0) return null;

  const { totals, byModel } = metrics;
  const dominantModel = byModel[0]?.model;

  return (
    <div className="run-metrics-bar">
      <div className="run-metrics-stat">
        <span className="run-metrics-label">Tokens</span>
        <span className="run-metrics-value">{formatNumber(totals.totalTokens)}</span>
        <span className="run-metrics-sub">
          {formatNumber(totals.promptTokens)} in / {formatNumber(totals.completionTokens)} out
        </span>
      </div>
      <div className="run-metrics-stat">
        <span className="run-metrics-label">LLM calls</span>
        <span className="run-metrics-value">{formatNumber(totals.callCount)}</span>
        {totals.latencyMs > 0 && (
          <span className="run-metrics-sub">{(totals.latencyMs / 1000).toFixed(1)}s total</span>
        )}
      </div>
      {totals.estimated && (
        <div className="run-metrics-stat">
          <span className="run-metrics-label">Cost (est.)</span>
          <span className="run-metrics-value">{formatUsd(totals.usd)}</span>
          <span className="run-metrics-sub">{formatCredits(totals.credits)} credits</span>
        </div>
      )}
      {byModel.length > 1 ? (
        <div className="run-metrics-stat run-metrics-stat-models">
          <span className="run-metrics-label">By model</span>
          <span className="run-metrics-models">
            {byModel.map((m) => (
              <span key={m.model} className="run-metrics-model">
                {m.model.replace(/^snowflake\//, '')}: {formatNumber(m.totalTokens)}
              </span>
            ))}
          </span>
        </div>
      ) : (
        dominantModel && (
          <div className="run-metrics-stat">
            <span className="run-metrics-label">Model</span>
            <span className="run-metrics-value run-metrics-model-name">
              {dominantModel.replace(/^snowflake\//, '')}
            </span>
          </div>
        )
      )}
    </div>
  );
}

function EventIcon({ type }: { type: TraceEvent['type'] }) {
  const paths: Record<string, string> = {
    run_started: 'M5 3l14 9-14 9V3z',
    run_completed: 'M20 6L9 17l-5-5',
    run_errored: 'M18 6L6 18 M6 6l12 12',
    task_started: 'M9 11l3 3 8-8',
    task_completed: 'M20 6L9 17l-5-5',
    task_failed: 'M18 6L6 18 M6 6l12 12',
    agent_started: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z',
    agent_completed: 'M20 6L9 17l-5-5',
    agent_failed: 'M18 6L6 18 M6 6l12 12',
    tool_call: 'M14.7 6.3a1 1 0 010 1.4l-1 1-3.4-3.4 1-1a1 1 0 011.4 0l2 2zM19.71 15H8a1 1 0 00-.7.3l-6 6',
    agent_thought: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z',
    warning: 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
    log: 'M4 6h16M4 12h16M4 18h7',
    tool_result: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2',
    // PR γ — sub-crew bracket events. Loop-arrow glyph mirrors the
    // SubCrewNode budget badge on the canvas so the visual language
    // stays consistent across surfaces.
    subcrew_call: 'M23 4v6h-6 M20.49 15a9 9 0 1 1-2.12-9.36L23 10',
    subcrew_complete: 'M20 6L9 17l-5-5',
  };
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[type] || paths.log} />
    </svg>
  );
}

function renderTraceLeaf(ev: TraceEvent) {
  return (
    <div key={ev.id} className={`run-trace-item run-trace-${ev.type}`}>
      <div className="run-trace-icon"><EventIcon type={ev.type} /></div>
      <div className="run-trace-body">
        <div className="run-trace-title">{ev.title}</div>
        {(ev.agentName || ev.taskName || ev.toolName) && (
          <div className="run-trace-meta">
            {ev.agentName && <span>agent: {ev.agentName}</span>}
            {ev.taskName && <span>task: {ev.taskName}</span>}
            {ev.toolName && <span>tool: {ev.toolName}</span>}
          </div>
        )}
        {ev.detail && <div className="run-trace-detail">{ev.detail}</div>}
      </div>
      <div className="run-trace-time">{formatTime(ev.timestamp)}</div>
    </div>
  );
}

function renderTraceEvents(
  events: TraceEvent[],
  leafRenderer: (ev: TraceEvent) => ReturnType<typeof renderTraceLeaf>
) {
  const entries = groupSubCrewEvents(events);
  return entries.map((entry) =>
    entry.kind === 'leaf' ? (
      leafRenderer(entry.event)
    ) : (
      <SubCrewEventGroup
        key={entry.group.header.id}
        group={entry.group}
        renderLeaf={leafRenderer}
      />
    )
  );
}

export function RunPanel({
  workspace,
  activeRunId,
  activeRun,
  onActiveRunIdChange,
}: {
  workspace: CrewStudioWorkspace;
  activeRunId: string | null;
  activeRun: CrewRun | null;
  onActiveRunIdChange: (id: string | null) => void;
}) {
  const [runs, setRuns] = useState<CrewRunSummary[]>([]);
  const [selectedCrewId, setSelectedCrewId] = useState(workspace.crews[0]?.id || '');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [outputView, setOutputView] = useState<'clean' | 'raw'>('clean');
  const [outputPopoutOpen, setOutputPopoutOpen] = useState(false);
  const outputScrollRef = useRef<HTMLPreElement | HTMLDivElement>(null);
  // Track whether the output container is scrolled close to the bottom so
  // we only auto-scroll when the user hasn't manually paged up. Without
  // this the auto-scroll fights the user every time new content streams in.
  const isAtBottomRef = useRef(true);
  const popoutDialogRef = useRef<HTMLDivElement>(null);
  const popoutCloseBtnRef = useRef<HTMLButtonElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const cleanOutput = useMemo(() => extractCleanRunOutput(activeRun?.output || ''), [activeRun?.output]);
  // Only run the heavy markdown→sanitized-HTML pipeline when the clean view
  // is actually visible. The raw-log view doesn't need it, and rerunning on
  // every streamed output chunk was the dominant cost in the run panel.
  const cleanOutputHtml = useMemo(
    () => (outputView === 'clean' ? markdownToSafeHtml(cleanOutput) : ''),
    [outputView, cleanOutput]
  );

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs?workspaceId=${workspace.id}`);
      if (res.ok) {
        const data = (await res.json()) as { runs: CrewRunSummary[] };
        setRuns(data.runs);
      }
    } catch {
      /* noop */
    }
  }, [workspace.id]);

  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    void fetchRuns();
  }, [activeRun?.status, fetchRuns]);

  // Auto-scroll output when new content streams in, but only if the user
  // is already pinned near the bottom. If they've scrolled up to read
  // something, leave them be — fighting their scroll is hostile.
  useEffect(() => {
    const el = outputScrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [activeRun?.output, activeRun?.events.length, outputView]);

  // Reset the "at bottom" flag when switching views or runs so a fresh
  // view starts pinned to the bottom again.
  useEffect(() => {
    isAtBottomRef.current = true;
  }, [outputView, activeRun?.id]);

  const handleOutputScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const el = event.currentTarget;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 30;
  }, []);

  // Focus management for the output popout dialog. On open we stash the
  // currently-focused element, move focus into the dialog, trap Tab inside
  // it, and close on Escape. On close we restore focus to whatever had it
  // before. This is a minimal inline focus trap (no react-aria dep).
  useEffect(() => {
    if (!outputPopoutOpen) return;

    previousActiveElementRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    // Defer focus so the dialog has mounted.
    const focusTimer = window.setTimeout(() => {
      popoutCloseBtnRef.current?.focus();
    }, 0);

    function getFocusable(): HTMLElement[] {
      const root = popoutDialogRef.current;
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
        setOutputPopoutOpen(false);
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
      const inDialog = active ? popoutDialogRef.current?.contains(active) ?? false : false;
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
      // Restore focus to the trigger that opened the dialog.
      previousActiveElementRef.current?.focus?.();
    };
  }, [outputPopoutOpen]);

  async function startRun() {
    if (!selectedCrewId) return;
    setStarting(true);
    setError('');
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, crewId: selectedCrewId }),
      });
      const data = (await res.json()) as CrewRun | { error: string };
      if ('error' in data && typeof data.error === 'string') {
        setError(data.error || 'Failed to start run');
      } else if ('id' in data) {
        onActiveRunIdChange(data.id);
        await fetchRuns();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start run');
    } finally {
      setStarting(false);
    }
  }

  async function cancelRun() {
    if (!activeRunId) return;
    await fetch(`/api/runs/${activeRunId}`, { method: 'DELETE' });
  }

  const isActive = activeRun && (activeRun.status === 'running' || activeRun.status === 'queued');
  const events = activeRun?.events || [];

  return (
    <div className="run-panel">
      {/* Control bar */}
      <div className="run-controls">
        <select
          className="run-crew-select"
          value={selectedCrewId}
          onChange={(e) => setSelectedCrewId(e.target.value)}
          disabled={starting || isActive === true}
        >
          {workspace.crews.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          {workspace.crews.length === 0 && <option value="">No crews defined</option>}
        </select>
        {isActive ? (
          <button type="button" className="run-btn run-btn-danger" onClick={cancelRun}>
            Stop run
          </button>
        ) : (
          <button
            type="button"
            className="run-btn run-btn-primary"
            onClick={startRun}
            disabled={starting || !selectedCrewId || workspace.crews.length === 0}
          >
            {starting ? 'Starting...' : 'Run crew'}
          </button>
        )}
        {error && <span className="run-error">{error}</span>}
      </div>

      <div className="run-body">
        {/* Left: history */}
        <div className="run-history">
          <div className="run-history-header">History</div>
          {runs.length === 0 ? (
            <div className="run-history-empty">No runs yet</div>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`run-history-item ${activeRunId === r.id ? 'active' : ''}`}
                onClick={() => onActiveRunIdChange(r.id)}
              >
                <div className="run-history-item-top">
                  <span className={statusClass(r.status)}>{r.status}</span>
                  <span className="run-history-time">{formatTime(r.startedAt)}</span>
                </div>
                <div className="run-history-name">{r.crewName}</div>
                <div className="run-history-meta">{r.eventCount} events</div>
              </button>
            ))
          )}
        </div>

        {/* Right: trace + output */}
        <div className="run-detail">
          {!activeRun ? (
            <div className="run-empty">
              <div className="run-empty-title">No run selected</div>
              <div className="run-empty-sub">
                Click &ldquo;Run crew&rdquo; to start, or pick a past run from the history.
              </div>
            </div>
          ) : (
            <>
              <MetricsBar run={activeRun} />
              <div className="run-trace-section">
                <div className="run-section-header">
                  <span>Trace</span>
                  <span className={statusClass(activeRun.status)}>{activeRun.status}</span>
                </div>
                <div className="run-trace-list">
                  {events.length === 0 ? (
                    <div className="run-trace-placeholder">Waiting for events...</div>
                  ) : (
                    renderTraceEvents(events, renderTraceLeaf)
                  )}
                </div>
              </div>

              <div className="run-output-section">
                <div className="run-section-header">
                  <span>Output</span>
                  <div className="run-output-toolbar">
                    <div className="run-output-tabs" role="tablist" aria-label="Run output view">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={outputView === 'clean'}
                        aria-controls="run-output-panel"
                        className={`run-output-tab ${outputView === 'clean' ? 'active' : ''}`}
                        onClick={() => setOutputView('clean')}
                      >
                        Clean Result
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={outputView === 'raw'}
                        aria-controls="run-output-panel"
                        className={`run-output-tab ${outputView === 'raw' ? 'active' : ''}`}
                        onClick={() => setOutputView('raw')}
                      >
                        Raw Log
                      </button>
                    </div>
                    <button
                      type="button"
                      className="run-output-popout-btn"
                      onClick={() => setOutputPopoutOpen(true)}
                    >
                      Pop out
                    </button>
                    {activeRun.exitCode !== null && (
                      <span className="run-exit-code">exit {activeRun.exitCode}</span>
                    )}
                  </div>
                </div>
                {outputView === 'clean' ? (
                  <div
                    id="run-output-panel"
                    ref={(node) => { outputScrollRef.current = node; }}
                    onScroll={handleOutputScroll}
                    className="run-clean-output"
                  >
                    {cleanOutputHtml ? (
                      <div dangerouslySetInnerHTML={{ __html: cleanOutputHtml }} />
                    ) : (
                      <div className="run-clean-empty">Clean result will appear after the final output marker.</div>
                    )}
                  </div>
                ) : (
                  <pre
                    id="run-output-panel"
                    ref={(node) => { outputScrollRef.current = node; }}
                    onScroll={handleOutputScroll}
                    className="run-output"
                  >
                    <code>{activeRun.output || '(no output yet)'}</code>
                  </pre>
                )}
              </div>
              {outputPopoutOpen && (
                <div
                  className="run-output-popout-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Run output popout"
                >
                  <div className="run-output-popout" ref={popoutDialogRef} tabIndex={-1}>
                    <div className="run-output-popout-header">
                      <div>
                        <div className="run-output-popout-title">Run Output</div>
                        <div className="run-output-popout-meta">{activeRun.crewName} · {activeRun.status}</div>
                      </div>
                      <div className="run-output-toolbar">
                        <div className="run-output-tabs" role="tablist" aria-label="Popout output view">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={outputView === 'clean'}
                            aria-controls="run-output-panel-popout"
                            className={`run-output-tab ${outputView === 'clean' ? 'active' : ''}`}
                            onClick={() => setOutputView('clean')}
                          >
                            Clean Result
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={outputView === 'raw'}
                            aria-controls="run-output-panel-popout"
                            className={`run-output-tab ${outputView === 'raw' ? 'active' : ''}`}
                            onClick={() => setOutputView('raw')}
                          >
                            Raw Log
                          </button>
                        </div>
                        <button
                          ref={popoutCloseBtnRef}
                          type="button"
                          className="run-output-popout-close"
                          onClick={() => setOutputPopoutOpen(false)}
                          aria-label="Close run output popout"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                    {outputView === 'clean' ? (
                      <div id="run-output-panel-popout" className="run-clean-output run-clean-output-popout">
                        {cleanOutputHtml ? (
                          <div dangerouslySetInnerHTML={{ __html: cleanOutputHtml }} />
                        ) : (
                          <div className="run-clean-empty">Clean result will appear after the final output marker.</div>
                        )}
                      </div>
                    ) : (
                      <pre id="run-output-panel-popout" className="run-output run-output-popout-raw">
                        <code>{activeRun.output || '(no output yet)'}</code>
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
