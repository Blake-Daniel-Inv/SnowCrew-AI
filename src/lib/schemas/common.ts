import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  AuthError,
  getCallerFromRequest,
  type CallerIdentity,
} from '@/lib/auth';
import { loggerWithContext } from '@/lib/logger';

/** Pinned-route child logger; structured fields per-call site. */
const log = loggerWithContext({ module: 'schemas/common' });

/**
 * Shared zod primitives and the canonical error envelope helper used by
 * every API route. The envelope shape is locked by the cross-stream
 * contract:
 *
 *   { error: { code: string; message: string; details?: unknown } }
 *
 * Routes never echo raw downstream error strings verbatim — they log
 * server-side and return a generic message. `details` is reserved for
 * structured validation output (e.g., `zodError.flatten()`).
 */

/** UUID path param validator. Workspace ids and run ids are crypto.randomUUID(). */
export const IdParam = z.string().uuid();

/** Canonical API error envelope returned by every 4xx/5xx response. */
export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/**
 * Build a NextResponse with the canonical error envelope and the given
 * HTTP status. Use the named code constants below for consistency.
 *
 * `init.headers` are merged onto the JSON response (e.g., precondition
 * routes attach `Vary: If-Match` so caches don't conflate matched vs
 * mismatched If-Match responses for the same URL).
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
  init?: { headers?: HeadersInit }
): NextResponse<ApiError> {
  const body: ApiError = { error: { code, message } };
  if (typeof details !== 'undefined') {
    body.error.details = details;
  }
  return NextResponse.json(body, { status, headers: init?.headers });
}

/** Standard error codes used across the 9 routes. */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_ID: 'INVALID_ID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  NOT_ACCEPTABLE: 'NOT_ACCEPTABLE',
  CONFLICT: 'CONFLICT',
  BAD_UPSTREAM: 'BAD_UPSTREAM',
  TIMEOUT: 'TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // PR 10: optimistic-concurrency on PATCH /api/workspaces/[id].
  // PRECONDITION_REQUIRED → 428 when the client omits If-Match.
  // PRECONDITION_FAILED   → 412 when the client's If-Match doesn't
  // match the server's current updatedAt (concurrent edit in another
  // tab or session).
  PRECONDITION_REQUIRED: 'PRECONDITION_REQUIRED',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
} as const;

/**
 * Standard headers for user-scoped GET responses. Owner-scoped data
 * must never be cached by intermediaries.
 */
export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/**
 * Validate a path param against a zod schema; on failure, return a
 * 400 INVALID_ID envelope.
 */
export function parseIdParam(value: string):
  | { ok: true; id: string }
  | { ok: false; response: NextResponse<ApiError> } {
  const parsed = IdParam.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      response: errorResponse(400, ErrorCodes.INVALID_ID, 'Invalid id'),
    };
  }
  return { ok: true, id: parsed.data };
}

/**
 * Defensive wrapper around `getCallerFromRequest`. Middleware should
 * have populated the identity header for every `/api/*` route — if
 * it didn't, that's a server misconfiguration (500), not an
 * unauthenticated client. We surface a generic 500 envelope and log
 * server-side so the bug is visible without leaking the header name
 * back to the client.
 */
export function requireCaller(request: Request):
  | { ok: true; caller: CallerIdentity }
  | { ok: false; response: NextResponse<ApiError> } {
  try {
    return { ok: true, caller: getCallerFromRequest(request) };
  } catch (error) {
    if (error instanceof AuthError) {
      log.error({ err: error.message }, 'missing caller identity');
      return {
        ok: false,
        response: errorResponse(
          500,
          ErrorCodes.INTERNAL_ERROR,
          'Authentication context unavailable.'
        ),
      };
    }
    throw error;
  }
}
