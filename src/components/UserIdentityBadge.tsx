'use client';

/**
 * UserIdentityBadge — top-bar GitHub-status pill that complements the
 * existing Snowflake identity pill in CrewStudioApp.tsx.
 *
 * The existing identity pill (rendered inline in CrewStudioApp) already
 * displays the Snowflake user. To honor the "minimal CrewStudioApp
 * change" boundary (one import + one render insertion), this component
 * focuses on the new piece — GitHub connection state — and is mounted
 * adjacent to the existing pill. Click navigates to /settings.
 *
 * Spec wording:
 *   "The Snowflake user (fetched from /api/me)."
 *   "A green dot + 'GitHub' if the user has a GitHub credential ..."
 *   "Click on the badge → navigates to /settings."
 *
 * We still fetch /api/me ourselves so we can no-op for unauthenticated
 * callers (401 hides the badge entirely, matching the host pill's
 * behavior).
 */
import { useEffect, useState } from 'react';
import { findCredential, useUserCredentials } from './useUserCredentials';

interface MeResponse {
  user: string | null;
  mode: 'spcs' | 'local' | 'unavailable' | 'unauthenticated';
}

export function UserIdentityBadge() {
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [identityErrored, setIdentityErrored] = useState(false);
  const { credentials, isLoading } = useUserCredentials();
  const githubCredential = findCredential(credentials, 'github');

  // One-shot fetch on mount + refetch on window focus so the badge
  // reflects a credential being added/revoked in another tab. Plain
  // `focus` listener — we are explicitly forbidden from adding SWR /
  // react-query as new dependencies.
  useEffect(() => {
    let cancelled = false;
    function load() {
      void fetch('/api/me', { cache: 'no-store' })
        .then((res) => {
          if (res.status === 401) {
            if (!cancelled) setIdentityErrored(true);
            return null;
          }
          return res.ok ? res.json() : null;
        })
        .then((payload: MeResponse | null) => {
          if (cancelled || !payload) return;
          setIdentity({
            user: typeof payload.user === 'string' ? payload.user : null,
            mode: payload.mode || 'unauthenticated',
          });
        })
        .catch(() => {
          if (!cancelled) setIdentityErrored(true);
        });
    }
    load();
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
    };
  }, []);

  if (identityErrored || !identity?.user) {
    // 401 / no identity: render nothing so the layout doesn't break
    // for unauthenticated previews.
    return null;
  }

  const ghLabel = isLoading
    ? 'GitHub status loading'
    : githubCredential
      ? `GitHub connected as ${githubCredential.accountLogin || 'unknown'}`
      : 'GitHub not connected';

  return (
    <a
      href="/settings"
      className="toolbar-identity user-identity-badge"
      aria-label={`${ghLabel}. Open Settings.`}
      title={ghLabel}
      aria-busy={isLoading || undefined}
    >
      <span
        className={
          'user-identity-badge-dot ' +
          (githubCredential
            ? 'user-identity-badge-dot-on'
            : 'user-identity-badge-dot-off')
        }
        aria-hidden="true"
      />
      <span className="user-identity-badge-gh">GitHub</span>
    </a>
  );
}
