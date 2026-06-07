import { NextResponse } from 'next/server';
import {
  deleteCredential,
  getCredentialToken,
  listCredentials,
} from '@/lib/credentials-db';
import {
  ErrorCodes,
  NO_STORE_HEADERS,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import { DeleteCredentialBodySchema } from '@/lib/schemas/auth';
import { revokeGitHubToken } from '@/lib/github/revoke';
import { loggerWithContext } from '@/lib/logger';
import { writeAuditEvent } from '@/lib/audit';

export const runtime = 'nodejs';

/** Pinned-route child logger; structured fields per-call site. */
const log = loggerWithContext({ route: '/api/user/credentials' });

/**
 * GET /api/user/credentials
 *
 * Returns the caller's stored credentials in the public-safe form
 * (provider, accountLogin, scopes, timestamps). Plaintext tokens and
 * any envelope material stay inside `credentials-db.ts`.
 *
 * The middleware (src/middleware.ts) sets `x-snowcrew-user` for every
 * /api/* path, and `requireCaller` reads that header — so this route
 * inherits owner scoping from the caller identity, never trusts a
 * query param.
 */
export async function GET(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  try {
    const credentials = await listCredentials(caller.user);
    return NextResponse.json(
      { credentials },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'list failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Could not list credentials'
    );
  }
}

/**
 * DELETE /api/user/credentials  { provider: 'github' }
 *
 * Removes the caller's stored token for the given provider. Middleware
 * has already enforced the CSRF/Origin check for unsafe methods, so we
 * just need to validate the body, scope by caller, and delete.
 *
 * Two-phase revoke (PR 5):
 *   1. Attempt to revoke the token on GitHub via the OAuth applications
 *      API so a "disconnect" in our UI matches "revoked" on GitHub's
 *      authorizations page. Requires both
 *      `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
 *   2. Always delete the local row, even if remote revocation failed —
 *      the user's expectation is "this app no longer has my token", and
 *      the server-side row is the thing under our control. Remote
 *      failure becomes a server-side warning + a flag in the response.
 *
 * The token plaintext flows only through `getCredentialToken` and the
 * `revokeGitHubToken` call; it is never logged, even on failure paths.
 */
export async function DELETE(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  const raw = await request.json().catch(() => null);
  const parsed = DeleteCredentialBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }

  const provider = parsed.data.provider;
  let remoteRevoked = false;

  try {
    if (provider === 'github') {
      // Step 1: try to revoke on GitHub. We read the token before
      // deleting the local row so we still have it; if revocation
      // succeeds we proceed to local delete, and if it fails we log
      // server-side and proceed anyway.
      let token: string | null = null;
      try {
        token = await getCredentialToken(caller.user, 'github');
      } catch (error) {
        // A decrypt failure here means we cannot revoke remotely; the
        // user's expectation is still "remove this connection", so we
        // skip the remote call and proceed to the local delete.
        log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'could not read token for remote revoke'
        );
      }

      if (token) {
        const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
        const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
        if (!clientId || !clientSecret) {
          // Don't fail the delete just because the OAuth app creds are
          // unconfigured in this environment — local cleanup still wins.
          log.warn(
            'GITHUB_OAUTH_CLIENT_ID/SECRET unset; skipping remote revocation (local token removed)'
          );
        } else {
          try {
            const result = await revokeGitHubToken({
              token,
              clientId,
              clientSecret,
            });
            if (result.ok) {
              remoteRevoked = true;
            } else if (result.status === 404) {
              // 404 = grant already absent on GitHub. Functionally
              // identical to "revoked"; surface it as such so the UI
              // doesn't tell the user to go re-revoke something that
              // isn't there.
              remoteRevoked = true;
            } else {
              log.warn(
                { revocationStatus: result.status },
                'github revocation returned non-success; local token still removed'
              );
            }
          } catch (error) {
            // Network failure / timeout. We never log the token —
            // only the failure type.
            log.warn(
              { errName: error instanceof Error ? error.name : 'unknown' },
              'github revocation transport failed; local token still removed'
            );
          }
        }
      }
    }

    const deleted = await deleteCredential(caller.user, provider);
    if (deleted) {
      writeAuditEvent({
        ownerId: caller.user,
        action: 'credential.disconnected',
        targetType: 'credential',
        targetId: provider,
        metadata: { provider, remoteRevoked },
      });
    }
    return NextResponse.json(
      { deleted, remoteRevoked },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'delete failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Could not delete credential'
    );
  }
}
