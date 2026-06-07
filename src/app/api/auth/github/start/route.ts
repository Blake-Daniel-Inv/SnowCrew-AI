import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getCredentialsMasterKey } from '@/lib/crypto/envelope';
import {
  ErrorCodes,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import {
  GH_OAUTH_STATE_COOKIE,
  GH_OAUTH_STATE_COOKIE_OPTIONS,
  signStatePayload,
} from '@/lib/oauth/state-cookie';
import { createRateLimiter } from '@/lib/rate-limit';
import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/auth/github/start' });

export const runtime = 'nodejs';

/**
 * Per-process rate limiter for OAuth-start. 10 attempts per minute per
 * caller is well above the legitimate "click connect, change my mind,
 * click again" pace and well below anything we'd consider abuse.
 *
 * Defined at module scope so the bucket map survives across requests
 * within the same Node process — defining it inside the handler would
 * reset state on every request, defeating the limiter.
 */
const oauthStartLimiter = createRateLimiter({
  tokensPerInterval: 10,
  intervalMs: 60_000,
});

/**
 * GET /api/auth/github/start
 *
 * Kicks off the GitHub OAuth web flow:
 *   1. Verify the caller is authenticated (middleware has already set the
 *      `x-snowcrew-user` header for /api/* routes).
 *   2. Enforce a per-user rate limit so a noisy client cannot mint
 *      unbounded state cookies / GitHub redirects.
 *   3. Generate a 32-byte CSRF state value.
 *   4. Bind the state to the caller's userId via an HMAC-signed cookie
 *      so the callback can prove the same browser AND the same user
 *      finished the flow.
 *   5. Redirect to GitHub's authorize endpoint.
 *
 * Why we sign the cookie: a stock state cookie defends against external
 * CSRF, but not against a hostile co-user who steals the unsigned state
 * mid-flow. Binding userId into the HMAC means the callback's
 * `requireCaller()` userId must match what we wrote here — otherwise
 * `verifyStatePayload` returns null and the callback 403s.
 *
 * The route deliberately reads env vars inside the handler (not at
 * module load) so a missing client id surfaces as a clean 500 envelope
 * on first hit rather than crashing the worker at boot.
 */
export async function GET(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  const limit = oauthStartLimiter.check(caller.user);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSec: limit.retryAfterSec },
      {
        status: 429,
        headers: {
          'Retry-After': String(limit.retryAfterSec),
        },
      }
    );
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'GITHUB_OAUTH_CLIENT_ID is not configured; see .env.example'
    );
  }

  // Allow operators to pin the callback URL for production (where the
  // public origin is fixed and may not match `request.url`'s host
  // header), but auto-derive in dev so engineers don't have to set it.
  const configuredCallback =
    process.env.GITHUB_OAUTH_CALLBACK_URL?.trim() || null;
  let callbackUrl: string;
  if (configuredCallback) {
    callbackUrl = configuredCallback;
  } else {
    try {
      const origin = new URL(request.url).origin;
      callbackUrl = `${origin}/api/auth/github/callback`;
    } catch {
      return errorResponse(
        500,
        ErrorCodes.INTERNAL_ERROR,
        'Could not derive OAuth callback URL from request; set GITHUB_OAUTH_CALLBACK_URL'
      );
    }
  }

  let masterKey: Buffer;
  try {
    masterKey = getCredentialsMasterKey();
  } catch (error) {
    // Don't echo the exception message — `getCredentialsMasterKey()`
    // names the env var in its error, but it's still better to log
    // server-side and return a generic envelope.
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'master key unavailable');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'CREDENTIALS_MASTER_KEY is not configured; see .env.example'
    );
  }

  const state = randomBytes(32).toString('base64url');
  const cookieValue = signStatePayload(state, caller.user, masterKey);

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
  // `repo` grants read on private repositories — required for PR 3+
  // (issue / PR / repo listing tools). We do NOT request `workflow` or
  // `admin:*` scopes; those should be incremental opt-ins.
  authorizeUrl.searchParams.set('scope', 'repo');
  authorizeUrl.searchParams.set('state', state);
  // Block GitHub's "create a new account" funnel — this app is for
  // existing GitHub users only and the inline signup carries footguns
  // (callback can fire with a session that has no `id`).
  authorizeUrl.searchParams.set('allow_signup', 'false');

  const response = NextResponse.redirect(authorizeUrl.toString(), 302);
  response.cookies.set(
    GH_OAUTH_STATE_COOKIE,
    cookieValue,
    GH_OAUTH_STATE_COOKIE_OPTIONS
  );
  return response;
}
