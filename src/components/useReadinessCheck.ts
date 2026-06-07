'use client';

/**
 * useReadinessCheck — single-fetch hook for the deployment readiness
 * signal (GET /api/health/ready).
 *
 * Why this hook exists: new users currently land on the canvas with no
 * signal whether the server has its credentials wired. The first real
 * failure surfaces ~20s into a run as an opaque 401 deep in the trace.
 * This hook makes that diagnosis available at first paint so the
 * <ReadinessBanner /> can tell the user "you're missing SNOWFLAKE_PAT"
 * BEFORE they hit Run.
 *
 * Cache shape is intentionally identical to useUserCredentials so the
 * memo / pub-sub patterns stay legible to future readers. Multiple
 * consumers (banner + Run button gating) share one fetch.
 *
 * The 5-second client-side AbortController timeout matters: the
 * /api/health/ready route already has its own DB timeout (~1s), but the
 * client also needs a guard for the case where the entire server is
 * wedged or the route is unreachable. Without the timeout, isLoading
 * would be stuck forever and the banner would never render.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReadinessStatus } from '@/types';

const FETCH_TIMEOUT_MS = 5_000;
const READY_ENDPOINT = '/api/health/ready';

type ReadinessCacheState =
  | { status: 'idle' }
  | { status: 'loading'; promise: Promise<void> }
  | { status: 'ready'; data: ReadinessStatus }
  | { status: 'error'; error: string; data: ReadinessStatus };

let cache: ReadinessCacheState = { status: 'idle' };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Subscribers are React state setters — they should never throw,
      // but a buggy listener mustn't poison the rest of the bus.
    }
  }
}

/**
 * Pure helper. Parses the raw JSON body of GET /api/health/ready into
 * the strongly-typed ReadinessStatus our UI consumes. Exported so the
 * unit tests can hit it without spinning up the fetch surface.
 *
 * Server contract (see src/app/api/health/ready/route.ts):
 *   - 200: { status: 'ok', checks: { db, envVars, credentialsKey }, mode }
 *   - 503: { status: 'not_ready', checks: { ... }, mode }
 *   - envVars is either the literal string 'ok' OR
 *     'missing:VAR1,VAR2|VAR3' — `|` separates "either-of" groups
 *     (e.g. SNOWFLAKE_PAT|SNOWFLAKE_JWT means "one of these is fine").
 *
 * On malformed input we deliberately return `'unknown'` for each check
 * rather than throwing — the banner treats `'unknown'` as "show the
 * warning but don't block the user", which is the right failure mode.
 */
export function parseReadiness(payload: unknown): ReadinessStatus {
  const fallback: ReadinessStatus = {
    status: 'unknown',
    checks: { db: 'unknown', envVars: 'ok', credentialsKey: 'unknown' },
    mode: 'unknown',
  };
  if (!payload || typeof payload !== 'object') return fallback;
  const obj = payload as Record<string, unknown>;
  const rawStatus = typeof obj.status === 'string' ? obj.status : null;
  const status: ReadinessStatus['status'] =
    rawStatus === 'ok'
      ? 'ready'
      : rawStatus === 'not_ready'
        ? 'not_ready'
        : 'unknown';

  const rawChecks =
    obj.checks && typeof obj.checks === 'object'
      ? (obj.checks as Record<string, unknown>)
      : {};

  const db: 'ok' | 'failed' | 'unknown' =
    rawChecks.db === 'ok' ? 'ok' : rawChecks.db === 'failed' ? 'failed' : 'unknown';

  const credentialsKey: 'ok' | 'missing' | 'unknown' =
    rawChecks.credentialsKey === 'ok'
      ? 'ok'
      : rawChecks.credentialsKey === 'missing'
        ? 'missing'
        : 'unknown';

  let envVars: ReadinessStatus['checks']['envVars'] = 'ok';
  const rawEnv = rawChecks.envVars;
  if (rawEnv === 'ok') {
    envVars = 'ok';
  } else if (typeof rawEnv === 'string' && rawEnv.startsWith('missing:')) {
    // Split on commas; expand `|` groups into their alternates so the
    // banner can render each missing var individually. The server emits
    // `missing:SNOWFLAKE_ACCOUNT_ID,SNOWFLAKE_PAT|SNOWFLAKE_JWT` — we
    // flatten that into ['SNOWFLAKE_ACCOUNT_ID','SNOWFLAKE_PAT','SNOWFLAKE_JWT']
    // so the UI lists every plausibly-missing variable.
    const tail = rawEnv.slice('missing:'.length);
    const tokens = tail
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const missing: string[] = [];
    for (const token of tokens) {
      const parts = token
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean);
      for (const p of parts) {
        if (!missing.includes(p)) missing.push(p);
      }
    }
    envVars = { missing };
  } else {
    // Malformed or absent → treat as ok so we don't false-positive a
    // banner. The parent `status` field is the real authority on whether
    // anything is wrong.
    envVars = 'ok';
  }

  const rawMode = typeof obj.mode === 'string' ? obj.mode : null;
  const mode: ReadinessStatus['mode'] =
    rawMode === 'local' ? 'local' : rawMode === 'spcs' ? 'spcs' : 'unknown';

  return { status, checks: { db, envVars, credentialsKey }, mode };
}

async function performFetch(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(READY_ENDPOINT, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    // Both 200 (ok) and 503 (not_ready) are *valid* responses we want
    // to parse — the server uses status codes for load balancers and
    // the body for human-readable detail. Only a hard network failure
    // or a non-JSON body lands in the catch.
    const payload = (await res.json().catch(() => null)) as unknown;
    cache = { status: 'ready', data: parseReadiness(payload) };
  } catch (err) {
    const aborted =
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err instanceof Error && err.name === 'AbortError');
    const message = aborted
      ? 'Health check timed out'
      : err instanceof Error
        ? err.message
        : 'Network error';
    // Network/timeout failures collapse to status='unknown' so the UI
    // surfaces "cannot verify" rather than spinning forever.
    cache = {
      status: 'error',
      error: message,
      data: {
        status: 'unknown',
        checks: { db: 'unknown', envVars: 'ok', credentialsKey: 'unknown' },
        mode: 'unknown',
      },
    };
  } finally {
    clearTimeout(timer);
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

/** Test-only reset for the module-level cache. Same shape as useUserCredentials. */
export function __resetReadinessCacheForTests(): void {
  cache = { status: 'idle' };
}

export interface UseReadinessCheckResult {
  status: ReadinessStatus['status'];
  checks: ReadinessStatus['checks'];
  mode: ReadinessStatus['mode'];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useReadinessCheck(): UseReadinessCheckResult {
  // Bump tick on cache change. The real data lives in the module
  // cache so all subscribers stay in lockstep across refetches.
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
      status: cache.data.status,
      checks: cache.data.checks,
      mode: cache.data.mode,
      isLoading: false,
      error: null,
      refetch,
    };
  }
  if (cache.status === 'error') {
    return {
      status: cache.data.status,
      checks: cache.data.checks,
      mode: cache.data.mode,
      isLoading: false,
      error: cache.error,
      refetch,
    };
  }
  // 'idle' and 'loading' both surface as loading. status defaults to
  // 'unknown' so callers don't accidentally treat pre-fetch as ready.
  return {
    status: 'unknown',
    checks: { db: 'unknown', envVars: 'ok', credentialsKey: 'unknown' },
    mode: 'unknown',
    isLoading: true,
    error: null,
    refetch,
  };
}
