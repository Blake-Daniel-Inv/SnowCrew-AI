'use client';

/**
 * useUserCredentials — single-fetch hook for the caller's connected
 * credentials list (GET /api/user/credentials).
 *
 * Multiple panels need this data (Settings page, top-bar badge, agent
 * config panel), and the credentials list is short-lived but rarely
 * changes mid-session, so we cache it at module scope and dedupe the
 * in-flight request. The first call triggers the fetch; concurrent
 * mounts subscribe to the same Promise and share the result.
 *
 * No third-party state libraries — plain React state plus a tiny
 * pub-sub so all subscribers re-render together when `refetch()` runs.
 */
import { useCallback, useEffect, useState } from 'react';
import type { UserCredentialPublic } from '@/types';

type CredentialsCacheState =
  | { status: 'idle' }
  | { status: 'loading'; promise: Promise<void> }
  | { status: 'ready'; credentials: UserCredentialPublic[] }
  | { status: 'error'; error: string };

let cache: CredentialsCacheState = { status: 'idle' };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Listeners are React state setters wrapped in our hook — they
      // should never throw, but a buggy subscriber must not poison the
      // rest of the bus.
    }
  }
}

async function performFetch(): Promise<void> {
  try {
    const res = await fetch('/api/user/credentials', {
      headers: { Accept: 'application/json' },
      // Cache header echoes the route's NO_STORE_HEADERS — we never
      // want a stale list after a disconnect.
      cache: 'no-store',
    });
    if (res.status === 401) {
      // Unauthenticated callers (preview / logged-out) get an empty
      // list, never an error toast. Lets the UI gracefully degrade.
      cache = { status: 'ready', credentials: [] };
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      cache = {
        status: 'error',
        error: text || `Request failed: ${res.status}`,
      };
      return;
    }
    const payload = (await res.json()) as {
      credentials?: UserCredentialPublic[];
    };
    cache = {
      status: 'ready',
      credentials: Array.isArray(payload.credentials) ? payload.credentials : [],
    };
  } catch (err) {
    cache = {
      status: 'error',
      error: err instanceof Error ? err.message : 'Network error',
    };
  } finally {
    notify();
  }
}

function ensureFetch(): void {
  if (cache.status === 'idle') {
    const promise = performFetch();
    cache = { status: 'loading', promise };
    notify();
  }
}

/**
 * Test-only reset. Not exported from a `*.test.ts` because the hook
 * lives in a `.ts` file and the cache is module-scoped — a Vitest run
 * that imports the hook must be able to wipe it between cases.
 */
export function __resetUserCredentialsCacheForTests(): void {
  cache = { status: 'idle' };
}

export interface UseUserCredentialsResult {
  credentials: UserCredentialPublic[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Returns the caller's credentials list. Fires the fetch on first
 * mount; subsequent mounts read the cache. `refetch()` invalidates the
 * cache and re-fetches for all subscribers.
 */
export function useUserCredentials(): UseUserCredentialsResult {
  // Force a re-render by bumping a tick counter; the real data lives
  // in the module cache so all subscribers stay in sync.
  const [, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    listeners.add(listener);
    ensureFetch();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const refetch = useCallback(() => {
    cache = { status: 'idle' };
    ensureFetch();
  }, []);

  if (cache.status === 'ready') {
    return {
      credentials: cache.credentials,
      isLoading: false,
      error: null,
      refetch,
    };
  }
  if (cache.status === 'error') {
    return {
      credentials: [],
      isLoading: false,
      error: cache.error,
      refetch,
    };
  }
  // 'idle' (pre-mount) and 'loading' both render as loading. The
  // useEffect kicks the fetch in 'idle' state.
  return { credentials: [], isLoading: true, error: null, refetch };
}

// ============================================================
// Pure helpers consumed by Settings / Badge / NodeConfigPanel.
// Exported alongside the hook so consumers don't need to duplicate
// the GitHub-lookup or status-mapping logic.
// ============================================================

/**
 * Returns the credential row for a given provider, or null. Centralized
 * because half the UI says "is GitHub connected" and we don't want
 * three different `.find()` predicates drifting.
 */
export function findCredential(
  credentials: UserCredentialPublic[],
  provider: UserCredentialPublic['provider']
): UserCredentialPublic | null {
  return credentials.find((c) => c.provider === provider) || null;
}

/**
 * Format a unix-epoch-ms timestamp as a coarse relative-time string.
 * Pure so it can be unit-tested without React or Intl.RelativeTimeFormat
 * (which is unstable across runtimes). Returns "just now" for under a
 * minute, "X min ago" / "X hr ago" up to a day, then absolute ISO date.
 */
export function formatRelativeTime(
  timestampMs: number | null,
  nowMs: number = Date.now()
): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return 'Never used';
  const deltaMs = nowMs - timestampMs;
  if (deltaMs < 0) {
    // Future timestamps are not real-world reachable here but we still
    // need to return something deterministic for the renderer.
    return 'just now';
  }
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  // Beyond a month, ISO date is the most stable format across browsers.
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Friendly-error mapping for the GitHub OAuth callback reason codes.
 * The callback route lists these in its switch-redirect logic, so this
 * keeps the user-facing surface aligned with the server's failure
 * taxonomy. Defaults to a generic message for unknown codes so we
 * never leak raw reason tokens to the screen.
 */
export function describeGitHubError(reason: string | null | undefined): string {
  switch (reason) {
    case 'timeout':
      return 'GitHub took too long to respond';
    case 'invalid_state':
      return 'Security check failed — please try again';
    case 'access_denied':
      return 'You declined the GitHub authorization';
    case 'not_configured':
      return 'GitHub OAuth is not configured on this server';
    case 'token_exchange_failed':
      return 'Could not exchange the GitHub authorization code';
    case 'user_lookup_failed':
      return 'GitHub did not return your account details';
    case 'storage_failed':
      return 'Could not save the GitHub credential';
    default:
      return 'Could not connect to GitHub';
  }
}
