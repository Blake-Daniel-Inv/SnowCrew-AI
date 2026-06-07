'use client';

/**
 * useSchedules — single-fetch hook for the caller's schedules list
 * (GET /api/schedules[?workspaceId=...]).
 *
 * Mirrors the useUserCredentials pattern:
 *   - module-cached so all subscribers share one fetch;
 *   - tiny pub/sub re-renders every mount when `refetch()` runs;
 *   - keyed cache (per workspaceId or 'all') so switching workspaces
 *     doesn't show stale rows from the previous workspace.
 *
 * `mutate(updater)` lets the panel apply optimistic updates (toggle
 * the enabled flag, delete a row) and revert if the underlying PATCH
 * fails. The optimistic update is local-only — `refetch()` after the
 * server confirms keeps the cache canonical.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SchedulePublic } from '@/types';

type CacheState =
  | { status: 'idle' }
  | { status: 'loading'; promise: Promise<void> }
  | { status: 'ready'; schedules: SchedulePublic[] }
  | { status: 'error'; error: string };

// Per-key cache + listener set. The key is `workspaceId || '__all__'`
// so the "list all" and per-workspace views don't conflict.
const cacheByKey = new Map<string, CacheState>();
const listenersByKey = new Map<string, Set<() => void>>();

function cacheKey(workspaceId: string | undefined): string {
  return workspaceId || '__all__';
}

function getCache(key: string): CacheState {
  return cacheByKey.get(key) || { status: 'idle' };
}

function setCache(key: string, state: CacheState): void {
  cacheByKey.set(key, state);
  notify(key);
}

function notify(key: string): void {
  const listeners = listenersByKey.get(key);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // React state setter — shouldn't throw, but if a subscriber
      // somehow does, don't poison the rest of the bus.
    }
  }
}

async function performFetch(workspaceId: string | undefined): Promise<void> {
  const key = cacheKey(workspaceId);
  try {
    const url = workspaceId
      ? `/api/schedules?workspaceId=${encodeURIComponent(workspaceId)}`
      : '/api/schedules';
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.status === 401) {
      // Unauthenticated previews see an empty list (mirrors the
      // useUserCredentials behaviour). The panel renders the empty
      // state, not an error toast.
      setCache(key, { status: 'ready', schedules: [] });
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      setCache(key, {
        status: 'error',
        error: text || `Request failed: ${res.status}`,
      });
      return;
    }
    const payload = (await res.json()) as { schedules?: SchedulePublic[] };
    setCache(key, {
      status: 'ready',
      schedules: Array.isArray(payload.schedules) ? payload.schedules : [],
    });
  } catch (err) {
    setCache(key, {
      status: 'error',
      error: err instanceof Error ? err.message : 'Network error',
    });
  }
}

function ensureFetch(workspaceId: string | undefined): void {
  const key = cacheKey(workspaceId);
  const current = getCache(key);
  if (current.status === 'idle') {
    const promise = performFetch(workspaceId);
    setCache(key, { status: 'loading', promise });
  }
}

/** Test-only cache reset. Not exported via barrel — vitest imports
 *  directly when it needs to invalidate state between cases. */
export function __resetSchedulesCacheForTests(): void {
  cacheByKey.clear();
  listenersByKey.clear();
}

export interface UseSchedulesResult {
  schedules: SchedulePublic[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  /**
   * Apply a local-only transform to the cached list. Used for
   * optimistic updates (toggle enabled, delete pending). Caller is
   * responsible for calling `refetch()` after the server confirms
   * (or reverting via another `mutate` on failure).
   */
  mutate: (
    updater: (prev: SchedulePublic[]) => SchedulePublic[]
  ) => void;
}

export function useSchedules(workspaceId?: string): UseSchedulesResult {
  const [, setTick] = useState(0);
  const key = cacheKey(workspaceId);

  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    let bucket = listenersByKey.get(key);
    if (!bucket) {
      bucket = new Set();
      listenersByKey.set(key, bucket);
    }
    bucket.add(listener);
    ensureFetch(workspaceId);
    return () => {
      bucket?.delete(listener);
    };
  }, [key, workspaceId]);

  const refetch = useCallback(() => {
    setCache(key, { status: 'idle' });
    ensureFetch(workspaceId);
  }, [key, workspaceId]);

  const mutate = useCallback(
    (updater: (prev: SchedulePublic[]) => SchedulePublic[]) => {
      const current = getCache(key);
      if (current.status !== 'ready') return;
      setCache(key, { status: 'ready', schedules: updater(current.schedules) });
    },
    [key]
  );

  const state = getCache(key);
  if (state.status === 'ready') {
    return {
      schedules: state.schedules,
      isLoading: false,
      error: null,
      refetch,
      mutate,
    };
  }
  if (state.status === 'error') {
    return {
      schedules: [],
      isLoading: false,
      error: state.error,
      refetch,
      mutate,
    };
  }
  return { schedules: [], isLoading: true, error: null, refetch, mutate };
}

/* ============================================================
 * Pure helpers consumed by SchedulesPanel and its tests.
 * ============================================================ */

/**
 * Render a future ms-timestamp as a coarse "fires in X" hint. Symmetric
 * with formatRelativePast below — we keep the strings short so they
 * fit in the panel without wrapping.
 */
export function formatRelativeFuture(
  msTimestamp: string | null,
  nowMs: number = Date.now()
): string {
  if (!msTimestamp) return 'Paused';
  const t = Date.parse(msTimestamp);
  if (!Number.isFinite(t)) return 'Unknown';
  const delta = t - nowMs;
  if (delta < 0) return 'Due now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return 'in <1 min';
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `in ${hr} hr`;
  const day = Math.floor(hr / 24);
  return `in ${day} day${day === 1 ? '' : 's'}`;
}

export function formatRelativePast(
  msTimestamp: string | null,
  nowMs: number = Date.now()
): string {
  if (!msTimestamp) return 'Never';
  const t = Date.parse(msTimestamp);
  if (!Number.isFinite(t)) return 'Unknown';
  const delta = nowMs - t;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

/**
 * Client-side cron sanity regex. Validates *shape* (5 whitespace-
 * separated fields, each composed of digits, *, /, -, ,, or letters).
 * The server still runs the real cron-parser check — this is just
 * for fast inline feedback in the form.
 */
const CRON_SHAPE = /^(\S+\s+){4}\S+$/;
const CRON_FIELD_CHARS = /^[0-9*\/\-,a-zA-Z?LW#]+$/;

export function looksLikeValidCron(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  const trimmed = expr.trim();
  if (!CRON_SHAPE.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => CRON_FIELD_CHARS.test(p));
}

/**
 * Common IANA timezones surfaced in the dropdown. The form also
 * accepts arbitrary text input for less-common zones.
 */
export const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;
