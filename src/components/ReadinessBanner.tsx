'use client';

/**
 * ReadinessBanner — top-of-canvas signal for deployment readiness.
 *
 * Renders one of three states sourced from useReadinessCheck():
 *   - 'ready'      → renders nothing (silent success).
 *   - 'not_ready'  → red banner when env vars or credentials key are
 *                    missing (hard block); yellow when only db is down
 *                    (soft warning, auto-retries every 30s).
 *   - 'unknown'    → yellow "cannot verify" banner with a Retry button.
 *
 * Dismissal model: per-session (sessionStorage, not localStorage). The
 * dismissal key includes a hash of the current state so a user who
 * dismisses a "PAT missing" banner still sees the banner if a NEW var
 * goes missing later. A new tab re-evaluates from scratch — which is
 * the right default; readiness is a deployment-wide signal and a stale
 * tab should not be allowed to silence it permanently.
 *
 * "Copy fix" generates an `export VAR=...` shell template. Every value
 * is a placeholder — we NEVER copy a real token to the clipboard even
 * if one was previously set in the environment. The server already
 * sanitizes the payload (it returns only NAMES, never values), so the
 * placeholder-only constraint is enforced here for defense in depth.
 *
 * The Run button gating is wired by the parent (CrewStudioApp) — this
 * component exposes its DOM id as `readiness-banner` so the toolbar
 * Run button can set aria-describedby pointing at it, letting screen
 * readers connect "Run is disabled" to "because the server is not
 * ready".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReadinessStatus } from '@/types';

export const READINESS_BANNER_ID = 'readiness-banner';
const DISMISSAL_VERSION = 'v1';
const DISMISSAL_KEY = 'snowcrew.readinessBannerDismissed';
const DB_RETRY_INTERVAL_MS = 30_000;
const PAT_SETUP_URL =
  'https://github.com/Blake-Daniel-Inv/SnowCrew-AI/blob/main/snowflake/PAT-SETUP.md';

/**
 * Maps an env-var name to the safe `export ...` template line that
 * goes on the clipboard. Always a placeholder — never a real value.
 * Falls back to a generic `<paste value here>` line for unknown vars
 * so new server-side checks don't silently break this UI.
 */
const FIX_TEMPLATES: Record<string, string> = {
  SNOWFLAKE_PAT: 'export SNOWFLAKE_PAT=<paste your PAT here>',
  SNOWFLAKE_JWT: 'export SNOWFLAKE_JWT=<paste your JWT here>',
  SNOWFLAKE_ACCOUNT_ID: 'export SNOWFLAKE_ACCOUNT_ID=<your account id, e.g. ABCD-XY12345>',
  SNOWFLAKE_HOST: 'export SNOWFLAKE_HOST=<your snowflake host, e.g. abc-xy12345.snowflakecomputing.com>',
  CREDENTIALS_MASTER_KEY:
    'export CREDENTIALS_MASTER_KEY=$(openssl rand -base64 32)  # save this!',
};

function fixLineFor(varName: string): string {
  return FIX_TEMPLATES[varName] ?? `export ${varName}=<paste value here>`;
}

/**
 * Stable signature of "what's wrong right now" so the dismissal key
 * changes when a new variable goes missing. We just sort+join the
 * salient signals — no crypto needed; this is a UX gate, not security.
 */
function statusHash(
  status: ReadinessStatus['status'],
  checks: ReadinessStatus['checks']
): string {
  const env =
    checks.envVars === 'ok'
      ? 'env:ok'
      : `env:${[...checks.envVars.missing].sort().join(',')}`;
  return `${status}|db:${checks.db}|${env}|creds:${checks.credentialsKey}`;
}

function readDismissal(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(DISMISSAL_KEY);
  } catch {
    return null;
  }
}

function writeDismissal(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(DISMISSAL_KEY, value);
  } catch {
    // sessionStorage can throw in private-mode contexts. Failing to
    // persist dismissal just means the banner shows again on the
    // next state change — acceptable degradation.
  }
}

/**
 * Decide which banner variant to render, given the parsed readiness
 * state. Pulled out so the render path is a thin switch — easier to
 * reason about and trivial to extend.
 */
type BannerKind = 'none' | 'red-missing' | 'yellow-db' | 'yellow-unknown';

function classifyBanner(
  status: ReadinessStatus['status'],
  checks: ReadinessStatus['checks']
): BannerKind {
  if (status === 'unknown') return 'yellow-unknown';
  if (status === 'ready') return 'none';
  // status === 'not_ready' below
  const envMissing = checks.envVars !== 'ok' && checks.envVars.missing.length > 0;
  const credMissing = checks.credentialsKey === 'missing';
  if (envMissing || credMissing) return 'red-missing';
  // Only db is failing — soft warning.
  if (checks.db === 'failed') return 'yellow-db';
  // Fallback: server said not_ready but didn't tell us why. Treat as
  // yellow-unknown so we don't claim a specific cause we don't know.
  return 'yellow-unknown';
}

export interface ReadinessBannerProps {
  status: ReadinessStatus['status'];
  checks: ReadinessStatus['checks'];
  mode: ReadinessStatus['mode'];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function ReadinessBanner({
  status,
  checks,
  isLoading,
  refetch,
}: ReadinessBannerProps) {
  const kind = classifyBanner(status, checks);
  const hash = useMemo(() => statusHash(status, checks), [status, checks]);
  const expectedDismissal = `${DISMISSAL_VERSION}+${hash}`;

  const [dismissed, setDismissed] = useState<string | null>(() => readDismissal());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-retry every 30s when only the DB is down. The endpoint is
  // cheap and a flaky DB usually recovers within a minute or two.
  useEffect(() => {
    if (kind !== 'yellow-db') return;
    const id = setInterval(refetch, DB_RETRY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [kind, refetch]);

  // Clear "Copied!" badge after a short hold.
  useEffect(() => {
    if (copyState === 'idle') return;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState('idle'), 2_500);
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [copyState]);

  // Bail-outs:
  //   1. Don't render anything while the first fetch is in flight — the
  //      banner must not block initial paint (a hard requirement). When
  //      isLoading flips false we'll render whatever the server said.
  //   2. Don't render when ready.
  //   3. Don't render if the user already dismissed THIS exact state.
  if (isLoading) return null;
  if (kind === 'none') return null;
  if (dismissed === expectedDismissal) return null;

  const missingVars =
    checks.envVars !== 'ok' ? checks.envVars.missing : [];
  const credMissing = checks.credentialsKey === 'missing';
  // The clipboard template covers env vars AND the credentials key.
  const allMissing = [
    ...missingVars,
    ...(credMissing ? ['CREDENTIALS_MASTER_KEY'] : []),
  ];

  const isRed = kind === 'red-missing';
  const tone = isRed ? 'rose' : 'amber';

  const onDismiss = () => {
    writeDismissal(expectedDismissal);
    setDismissed(expectedDismissal);
  };

  const onCopyFix = async () => {
    const template = allMissing.map(fixLineFor).join(' && ');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(template);
        setCopyState('copied');
      } else {
        setCopyState('failed');
      }
    } catch {
      setCopyState('failed');
    }
  };

  // Title/body copy per state — kept in one place to make audits easy.
  let title: string;
  let body: string;
  if (kind === 'red-missing') {
    title = 'Studio is not ready';
    const list = allMissing.join(', ');
    body = `Missing: ${list}.`;
  } else if (kind === 'yellow-db') {
    title = 'Database unavailable';
    body = 'Run history and credentials may not load.';
  } else {
    title = 'Cannot verify studio is ready';
    body = 'Health check timed out. Retry below or proceed at your own risk.';
  }

  const showsPatLink = isRed && allMissing.some((v) => v === 'SNOWFLAKE_PAT');

  return (
    <div
      id={READINESS_BANNER_ID}
      // Red banners are blocking errors — assertive. Yellow banners are
      // advisories — polite so they don't interrupt mid-task speech.
      role="alert"
      aria-live={isRed ? 'assertive' : 'polite'}
      data-readiness-kind={kind}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 14px',
        margin: '8px 12px 0',
        borderRadius: 6,
        background:
          tone === 'rose'
            ? 'var(--surface-soft)'
            : 'var(--color-warning-bg, var(--surface-soft))',
        border: `1px solid var(--${tone})`,
        borderLeft: `4px solid var(--${tone})`,
        fontSize: 13,
        color: 'var(--text)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            color: `var(--${tone})`,
            marginBottom: 2,
          }}
        >
          {title}
        </div>
        <div style={{ color: 'var(--text-soft, var(--text))' }}>
          {body}
          {showsPatLink && (
            <>
              {' '}
              <a
                href={PAT_SETUP_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: `var(--${tone})`, textDecoration: 'underline' }}
              >
                How to generate a PAT
              </a>
            </>
          )}
        </div>

        {kind === 'red-missing' && (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
              aria-controls={`${READINESS_BANNER_ID}-details`}
              style={{ fontSize: 12 }}
            >
              {detailsOpen ? 'Hide details' : 'Show details'}
            </button>
            {detailsOpen && (
              <pre
                id={`${READINESS_BANNER_ID}-details`}
                style={{
                  marginTop: 8,
                  padding: 8,
                  borderRadius: 4,
                  background: 'var(--surface-field)',
                  border: '1px solid var(--surface-strong)',
                  fontSize: 11,
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 180,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify({ status, checks }, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        {kind === 'red-missing' && allMissing.length > 0 && (
          <button
            type="button"
            className="toolbar-btn"
            onClick={onCopyFix}
            title="Copy a shell template with the missing variables"
          >
            {copyState === 'copied'
              ? 'Copied!'
              : copyState === 'failed'
                ? 'Copy failed'
                : 'Copy fix'}
          </button>
        )}
        {kind === 'yellow-unknown' && (
          <button
            type="button"
            className="toolbar-btn"
            onClick={refetch}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="toolbar-btn"
          onClick={onDismiss}
          aria-label="Dismiss readiness banner"
          title="Dismiss for this session"
          style={{ padding: '4px 8px' }}
        >
          {/* Plain X — no SVG animation, honors prefers-reduced-motion
              by default since we don't animate. */}
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
