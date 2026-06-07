import { NextResponse } from 'next/server';
import { upsertCredential } from '@/lib/credentials-db';
import { fetchGitHubUserOrgs } from '@/lib/github/orgs';
import { getCredentialsMasterKey } from '@/lib/crypto/envelope';
import {
  ErrorCodes,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import {
  GH_OAUTH_STATE_COOKIE,
  GH_OAUTH_STATE_COOKIE_CLEAR_OPTIONS,
  verifyStatePayload,
} from '@/lib/oauth/state-cookie';
import { GitHubCallbackQuerySchema } from '@/lib/schemas/auth';
import { loggerWithContext } from '@/lib/logger';
import { writeAuditEvent } from '@/lib/audit';
import type { GitHubUser } from '@/types';

export const runtime = 'nodejs';

/**
 * Module-scope child logger so every call site gets `route` pinned for
 * grep. We don't need per-request context here — the OAuth callback is
 * stateless and short-lived, and `caller.user` is available where it
 * matters for structured logging.
 */
const log = loggerWithContext({ route: '/api/auth/github/callback' });

/** 10s ceiling on both upstream calls — GitHub is usually < 500 ms. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Settings-page redirect targets. The UI (PR 4) reads these query params. */
const SUCCESS_REDIRECT = '/settings?integration=github&status=connected';
function errorRedirect(reason: string): string {
  // `reason` is constrained to short alpha-_underscore tokens so we
  // never echo upstream error blobs into the URL.
  const safe = reason.replace(/[^a-z0-9_]/gi, '').slice(0, 32) || 'unknown';
  return `/settings?integration=github&status=error&reason=${safe}`;
}

/**
 * Build a redirect response that ALSO clears the state cookie. We
 * always clear on the way out — success means the state has been
 * consumed; failure means the state is suspect. Either way, leaving
 * the cookie around invites replay.
 */
function redirectAndClearCookie(target: string): NextResponse {
  const response = NextResponse.redirect(
    new URL(target, 'http://placeholder').toString(),
    302
  );
  // Reset the URL to a relative redirect — NextResponse.redirect
  // requires a fully-qualified URL but we want the Location header to
  // be relative so the browser uses its own origin (works behind
  // proxies / dev / prod alike). Achieved by stamping the header
  // directly after construction.
  response.headers.set('Location', target);
  response.cookies.set(
    GH_OAUTH_STATE_COOKIE,
    '',
    GH_OAUTH_STATE_COOKIE_CLEAR_OPTIONS
  );
  return response;
}

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/auth/github/callback?code=...&state=...
 *
 * Completes the OAuth dance:
 *   1. Validate the query shape (Zod).
 *   2. Verify the HMAC-signed state cookie matches the query state AND
 *      the caller userId — three-way binding (browser cookie, GitHub
 *      state echo, current session) so any single piece in attacker
 *      hands fails the check.
 *   3. Exchange `code` for an access token.
 *   4. Fetch `/user` to populate account_login + account_id.
 *   5. Upsert into the encrypted credentials store.
 *   6. Redirect the user back to /settings.
 *
 * On any failure after state validation we redirect to a generic
 * `?status=error&reason=<code>` page — token-exchange specifics stay
 * server-side. The user gets a stable URL to react to; an attacker
 * gets nothing useful.
 */
export async function GET(request: Request) {
  // Caller identity must be present — the start route required it and
  // the cookie's HMAC binds it. If middleware didn't run, that's a
  // 500 (requireCaller will surface that).
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  // ---- 1. Query shape -------------------------------------------------
  const { searchParams } = new URL(request.url);
  const queryParsed = GitHubCallbackQuerySchema.safeParse({
    code: searchParams.get('code') ?? undefined,
    error: searchParams.get('error') ?? undefined,
    error_description: searchParams.get('error_description') ?? undefined,
    state: searchParams.get('state') ?? undefined,
  });
  if (!queryParsed.success) {
    log.warn({ flatten: queryParsed.error.flatten() }, 'invalid query');
    return redirectAndClearCookie(errorRedirect('invalid_request'));
  }
  const query = queryParsed.data;

  // ---- 2. State cookie binding ---------------------------------------
  // Read the cookie via the standard `Cookie` header parsing — Next's
  // `NextRequest` would give us cookies()` directly, but this handler
  // receives a plain `Request`, so we parse manually for portability.
  const cookieHeader = request.headers.get('cookie') ?? '';
  const cookieValue = readCookie(cookieHeader, GH_OAUTH_STATE_COOKIE);
  if (!cookieValue) {
    return NextResponse.json(
      { error: 'invalid_state' },
      {
        status: 403,
        headers: {
          'Set-Cookie': buildClearCookieHeader(),
        },
      }
    );
  }

  let masterKey: Buffer;
  try {
    masterKey = getCredentialsMasterKey();
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'master key unavailable');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'CREDENTIALS_MASTER_KEY is not configured; see .env.example'
    );
  }

  const verified = verifyStatePayload(cookieValue, masterKey);
  if (
    !verified ||
    verified.state !== query.state ||
    verified.userId !== caller.user
  ) {
    return NextResponse.json(
      { error: 'invalid_state' },
      {
        status: 403,
        headers: {
          'Set-Cookie': buildClearCookieHeader(),
        },
      }
    );
  }

  // ---- 3. Honor an explicit GitHub error before bothering the API ---
  if (query.error) {
    log.warn(
      { ghError: query.error, ghErrorDescription: query.error_description ?? '' },
      'github returned error on callback'
    );
    return redirectAndClearCookie(errorRedirect(query.error));
  }
  // Past validation, `code` MUST be present (refine ensured code|error).
  const code = query.code as string;

  // ---- 4. Exchange code for token -----------------------------------
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    log.error('OAuth env vars missing (GITHUB_OAUTH_CLIENT_ID/SECRET)');
    return redirectAndClearCookie(errorRedirect('not_configured'));
  }

  const configuredCallback =
    process.env.GITHUB_OAUTH_CALLBACK_URL?.trim() || null;
  let callbackUrl: string;
  if (configuredCallback) {
    callbackUrl = configuredCallback;
  } else {
    try {
      callbackUrl = `${new URL(request.url).origin}/api/auth/github/callback`;
    } catch {
      log.error('could not derive callback URL');
      return redirectAndClearCookie(errorRedirect('bad_origin'));
    }
  }

  let tokenJson: GitHubTokenResponse;
  try {
    const tokenResp = await fetchWithTimeout(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'SnowCrewAI',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
        }),
      },
      UPSTREAM_TIMEOUT_MS
    );
    if (!tokenResp.ok) {
      log.error({ status: tokenResp.status }, 'token exchange failed');
      return redirectAndClearCookie(errorRedirect('token_exchange_failed'));
    }
    tokenJson = (await tokenResp.json()) as GitHubTokenResponse;
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    log.error(
      {
        aborted,
        err: error instanceof Error ? error.message : String(error),
        errName: error instanceof Error ? error.name : 'unknown',
      },
      'token exchange threw'
    );
    return redirectAndClearCookie(
      errorRedirect(aborted ? 'timeout' : 'token_exchange_failed')
    );
  }

  if (tokenJson.error || !tokenJson.access_token) {
    log.error({ tokenError: tokenJson.error }, 'token response carried error');
    return redirectAndClearCookie(errorRedirect('token_exchange_failed'));
  }

  const accessToken = tokenJson.access_token;
  // GitHub returns scopes as a comma-separated string. Default to ['repo']
  // (what we requested) if the field is empty.
  const scopes = (tokenJson.scope || 'repo')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // ---- 5. Identify the GitHub user ----------------------------------
  let ghUser: GitHubUser;
  try {
    const userResp = await fetchWithTimeout(
      'https://api.github.com/user',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'SnowCrewAI',
        },
      },
      UPSTREAM_TIMEOUT_MS
    );
    if (!userResp.ok) {
      log.error({ status: userResp.status }, '/user lookup failed');
      return redirectAndClearCookie(errorRedirect('user_lookup_failed'));
    }
    const raw = (await userResp.json()) as { login?: unknown; id?: unknown };
    if (typeof raw.login !== 'string' || typeof raw.id !== 'number') {
      log.error('/user returned malformed payload');
      return redirectAndClearCookie(errorRedirect('user_lookup_failed'));
    }
    ghUser = { login: raw.login, id: raw.id };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    log.error(
      {
        aborted,
        err: error instanceof Error ? error.message : String(error),
        errName: error instanceof Error ? error.name : 'unknown',
      },
      '/user lookup threw'
    );
    return redirectAndClearCookie(
      errorRedirect(aborted ? 'timeout' : 'user_lookup_failed')
    );
  }

  // ---- 6. Fetch org memberships (best-effort) -----------------------
  // GitHub `/user/orgs` returns only the orgs where the user has at
  // least read visibility for this OAuth grant. Private memberships
  // the user hasn't surfaced — or orgs that haven't approved this
  // OAuth app for third-party access — will not appear. That's the
  // user's / org's GitHub privacy setting and not something we can
  // override here.
  //
  // This call is best-effort: the helper never throws. A timeout or
  // 401 just yields an empty list and the connect flow proceeds with
  // empty `metadata.organizations`. We do not want a flaky upstream
  // call to break OAuth completion.
  const orgs = await fetchGitHubUserOrgs(accessToken);

  // ---- 7. Persist (encrypted) and redirect --------------------------
  try {
    await upsertCredential({
      ownerId: caller.user,
      provider: 'github',
      accountLogin: ghUser.login,
      accountId: String(ghUser.id),
      scopes,
      token: accessToken,
      metadata: {
        organizations: orgs.map((o) => ({
          login: o.login,
          id: o.id,
          description: o.description ?? null,
          avatarUrl: o.avatar_url ?? null,
        })),
      },
    });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'credential upsert failed');
    return redirectAndClearCookie(errorRedirect('storage_failed'));
  }

  // Audit AFTER the upsert succeeds — never log a "connected" event for
  // a row that didn't actually land. The token itself is never recorded
  // in metadata; only the public account login.
  writeAuditEvent({
    ownerId: caller.user,
    action: 'credential.connected',
    targetType: 'credential',
    targetId: `github:${ghUser.id}`,
    metadata: {
      provider: 'github',
      accountLogin: ghUser.login,
    },
  });

  return redirectAndClearCookie(SUCCESS_REDIRECT);
}

/**
 * Minimal Cookie-header parser. Returns the value for `name` or `''`
 * if absent. We avoid `next/headers` cookies() here because this is a
 * route-handler `Request`, not a middleware NextRequest, and a one-line
 * parser keeps the dependency surface tiny.
 */
function readCookie(header: string, name: string): string {
  if (!header) return '';
  const pairs = header.split(';');
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key !== name) continue;
    return pair.slice(eq + 1).trim();
  }
  return '';
}

/**
 * Build the Set-Cookie header value that clears the state cookie. Used
 * by the 403 invalid_state response which we want to return as JSON
 * (not a redirect) — `NextResponse.cookies.set` only works on
 * NextResponse, but here we keep the raw header explicit so the
 * structured 403 body and the cookie reset travel together.
 */
function buildClearCookieHeader(): string {
  // Keep flags in lockstep with GH_OAUTH_STATE_COOKIE_CLEAR_OPTIONS.
  return [
    `${GH_OAUTH_STATE_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}
