'use client';

/**
 * IntegrationsPanel — client surface mounted by /settings.
 *
 * Responsibilities:
 *   - List supported third-party providers (just GitHub for now).
 *   - Surface the OAuth callback result toast ?integration=...&status=...
 *   - Let the user connect (anchor → /api/auth/github/start) or
 *     disconnect (DELETE /api/user/credentials, gated by a confirm).
 *   - Show informational "Signed in as <snowflake-user>" so the user
 *     knows whose session they're operating under.
 *
 * Loading + error states are explicit: skeleton with aria-busy while
 * fetching, retry-able banner on failure. We never silently render an
 * empty state for a network failure — that would mis-suggest "no
 * credentials" when really we just couldn't reach the server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  describeGitHubError,
  findCredential,
  formatRelativeTime,
  useUserCredentials,
} from './useUserCredentials';
import type { UserCredentialPublic } from '@/types';

interface MeResponse {
  user: string | null;
  mode: 'spcs' | 'local' | 'unavailable' | 'unauthenticated';
}

type Banner =
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }
  | null;

export function IntegrationsPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { credentials, isLoading, error, refetch } = useUserCredentials();
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<
    UserCredentialPublic | null
  >(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Snowflake user — informational only. Failures are non-fatal; the
  // identity line just stays hidden.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/me', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: MeResponse | null) => {
        if (cancelled || !payload) return;
        setIdentity({
          user: typeof payload.user === 'string' ? payload.user : null,
          mode: payload.mode || 'unauthenticated',
        });
      })
      .catch(() => {
        /* informational only — silent */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Parse the OAuth callback query params once on mount, surface the
  // banner, then strip them from the URL so a refresh doesn't re-fire.
  // Using router.replace with the bare pathname removes ALL query params,
  // which is what we want here — `?integration=` is the only one this
  // page recognizes and it should be one-shot.
  const handledParamsRef = useRef(false);
  useEffect(() => {
    if (handledParamsRef.current) return;
    const integration = searchParams.get('integration');
    const status = searchParams.get('status');
    const reason = searchParams.get('reason');
    if (integration !== 'github') return;
    handledParamsRef.current = true;

    if (status === 'connected') {
      // The login isn't in the URL — we look it up from the credentials
      // list once it arrives. Until then, show a generic message.
      setBanner({ kind: 'success', message: 'GitHub connected.' });
    } else if (status === 'error') {
      setBanner({ kind: 'error', message: describeGitHubError(reason) });
    }
    // Clear the query string. We're already on /settings so a bare
    // pathname push leaves the user on the same page sans query.
    router.replace('/settings');
  }, [searchParams, router]);

  // Once the credentials list resolves after a connect-success, swap the
  // generic banner for the personalized one.
  useEffect(() => {
    if (banner?.kind !== 'success') return;
    if (isLoading) return;
    const gh = findCredential(credentials, 'github');
    if (gh?.accountLogin) {
      setBanner({
        kind: 'success',
        message: `Connected as @${gh.accountLogin}`,
      });
    }
    // We only want to upgrade the banner once after a fresh connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials, isLoading]);

  const githubCredential = useMemo(
    () => findCredential(credentials, 'github'),
    [credentials]
  );

  const disconnectGithub = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/user/credentials', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'github' }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Request failed: ${res.status}`);
      }
      setBanner({ kind: 'success', message: 'GitHub disconnected.' });
      refetch();
    } catch (err) {
      setBanner({
        kind: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Could not disconnect GitHub',
      });
    } finally {
      setDisconnecting(false);
      setPendingDisconnect(null);
    }
  }, [refetch]);

  return (
    <>
      {/* Toast / banner region. aria-live so screen readers announce
        * the result without us needing to manage focus. */}
      <div aria-live="polite" aria-atomic="true">
        {banner && (
          <div
            className={
              banner.kind === 'success'
                ? 'integrations-banner integrations-banner-success'
                : 'integrations-banner integrations-banner-error'
            }
            role={banner.kind === 'error' ? 'alert' : 'status'}
          >
            <span>{banner.message}</span>
            <button
              type="button"
              className="integrations-banner-close"
              onClick={() => setBanner(null)}
              aria-label="Dismiss notification"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {identity?.user && (
        <div className="integrations-identity">
          Signed in as <strong>{identity.user}</strong>
        </div>
      )}

      {isLoading ? (
        <div
          className="integrations-skeleton"
          aria-busy="true"
          aria-label="Loading integrations"
        />
      ) : error ? (
        <div className="integrations-error" role="alert">
          <span>Could not load integrations: {error}</span>
          <button
            type="button"
            className="integrations-card-action"
            onClick={refetch}
          >
            Retry
          </button>
        </div>
      ) : (
        <GitHubIntegrationCard
          credential={githubCredential}
          onDisconnect={() => setPendingDisconnect(githubCredential)}
        />
      )}

      {pendingDisconnect && (
        <DisconnectDialog
          providerLabel="GitHub"
          busy={disconnecting}
          onCancel={() => setPendingDisconnect(null)}
          onConfirm={() => void disconnectGithub()}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  GitHub row                                                        */
/* ------------------------------------------------------------------ */

function GitHubIntegrationCard({
  credential,
  onDisconnect,
}: {
  credential: UserCredentialPublic | null;
  onDisconnect: () => void;
}) {
  const connected = Boolean(credential);
  return (
    <div className="integrations-card">
      <span className="integrations-card-icon" aria-hidden="true">
        <GitHubMark />
      </span>
      <div className="integrations-card-body">
        <h3 className="integrations-card-title">GitHub</h3>
        {connected && credential ? (
          <>
            <div className="integrations-card-meta">
              <a
                className="integrations-card-account"
                href={`https://github.com/${credential.accountLogin || ''}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                @{credential.accountLogin || 'unknown'}
              </a>
              <span>Connected {formatRelativeTime(credential.connectedAt)}</span>
              <span>
                {credential.lastUsedAt
                  ? `Last used ${formatRelativeTime(credential.lastUsedAt)}`
                  : 'Never used'}
              </span>
            </div>
            {credential.scopes.length > 0 && (
              <div className="integrations-card-scopes" aria-label="Granted scopes">
                {credential.scopes.map((scope) => (
                  <span key={scope} className="integrations-card-scope">
                    {scope}
                  </span>
                ))}
              </div>
            )}
            <OrganizationChips
              organizations={credential.metadata?.organizations ?? []}
            />
          </>
        ) : (
          <p className="integrations-card-desc integrations-empty-desc">
            Allow your crews to read your private repos, pull requests, and issues.
          </p>
        )}
      </div>
      {connected ? (
        <button
          type="button"
          className="integrations-card-action integrations-card-action-danger"
          onClick={onDisconnect}
          aria-label="Disconnect GitHub"
        >
          Disconnect
        </button>
      ) : (
        // Plain anchor — the OAuth start route needs the browser to
        // navigate (sets a state cookie + redirects to GitHub).
        // fetch() would silently break the dance.
        <a
          className="integrations-card-action integrations-card-action-primary"
          href="/api/auth/github/start"
          aria-label="Connect GitHub"
        >
          Connect GitHub
        </a>
      )}
    </div>
  );
}

function GitHubMark() {
  // Inline SVG — no asset file, matches the other inline icons in the app.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0.5C5.65 0.5 0.5 5.65 0.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-1.93c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.73.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.66.79.55C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35 0.5 12 0.5z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  GitHub organization chips                                         */
/* ------------------------------------------------------------------ */

/**
 * Render the user's visible GitHub orgs as a row of chips. Hidden
 * when the array is empty — we never show an empty row.
 *
 * Behavior:
 *   - First 6 chips always render.
 *   - If there are more than 6, a "+N more" button toggles the rest
 *     in-place. Pure client-side; no extra fetch. The toggle is a
 *     real `<button>` with `aria-expanded` so screen readers
 *     announce the state.
 *   - Each chip is an `<a>` to the org page on GitHub. The avatar
 *     is lazy-loaded and given an explicit non-empty `alt`. We do
 *     not link to org-private resources from here — just the public
 *     org page, which exists for every org.
 */
function OrganizationChips({
  organizations,
}: {
  organizations: NonNullable<
    NonNullable<UserCredentialPublic['metadata']>['organizations']
  >;
}) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_LIMIT = 6;

  if (!organizations || organizations.length === 0) return null;

  const visible = expanded
    ? organizations
    : organizations.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = organizations.length - visible.length;

  return (
    <div
      className="integrations-card-scopes integrations-card-orgs"
      aria-label="GitHub organizations"
    >
      <span
        className="integrations-card-scope"
        style={{ background: 'transparent', border: 'none', padding: '2px 0' }}
      >
        Organizations:
      </span>
      {visible.map((org) => (
        <a
          key={org.id}
          className="integrations-card-scope integrations-card-org-chip"
          href={`https://github.com/${org.login}`}
          target="_blank"
          rel="noopener noreferrer"
          title={org.description ?? org.login}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            textDecoration: 'none',
          }}
        >
          {org.avatarUrl ? (
            // Avatar image — small, lazy-loaded. Alt is explicit so
            // screen readers announce the org by login. We do NOT
            // proxy the image — GitHub avatars are public CDN URLs.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={org.avatarUrl}
              alt={`${org.login} avatar`}
              loading="lazy"
              width={14}
              height={14}
              style={{ borderRadius: 3, display: 'block' }}
            />
          ) : null}
          <span>{org.login}</span>
        </a>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="integrations-card-scope"
          style={{ cursor: 'pointer' }}
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          +{hiddenCount} more
        </button>
      )}
      {expanded && organizations.length > COLLAPSED_LIMIT && (
        <button
          type="button"
          className="integrations-card-scope"
          style={{ cursor: 'pointer' }}
          aria-expanded={expanded}
          onClick={() => setExpanded(false)}
        >
          Show fewer
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Native <dialog> for disconnect confirm                            */
/* ------------------------------------------------------------------ */

function DisconnectDialog({
  providerLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  providerLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // `showModal` puts the dialog on top-layer, applies the inert
    // background, and enables ::backdrop. The native `<dialog>` element
    // ships its own focus trap so we don't need to roll one ourselves.
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // Some browsers throw if the dialog is already open via SSR
        // hydration — that's fine.
      }
    }
    // Focus the confirm button by default for keyboard users.
    const t = window.setTimeout(() => confirmBtnRef.current?.focus(), 0);
    function onCancelEvent(event: Event) {
      // The native ESC-to-close fires a `cancel` event; intercept so we
      // route through the explicit cancel handler (which also clears the
      // parent's pendingDisconnect state).
      event.preventDefault();
      onCancel();
    }
    dialog.addEventListener('cancel', onCancelEvent);
    return () => {
      window.clearTimeout(t);
      dialog.removeEventListener('cancel', onCancelEvent);
      if (dialog.open) dialog.close();
    };
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      className="integrations-dialog"
      aria-labelledby="disconnect-dialog-title"
      aria-describedby="disconnect-dialog-message"
    >
      <div className="integrations-dialog-body">
        <h2 id="disconnect-dialog-title" className="integrations-dialog-title">
          Disconnect {providerLabel}?
        </h2>
        <p id="disconnect-dialog-message" className="integrations-dialog-message">
          This will disconnect {providerLabel} from SnowCrewAI. Your crews will
          no longer be able to read your repos. Continue?
        </p>
        <div className="integrations-dialog-actions">
          <button
            type="button"
            className="integrations-card-action"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className="integrations-card-action integrations-card-action-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Disconnecting…' : `Disconnect ${providerLabel}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
