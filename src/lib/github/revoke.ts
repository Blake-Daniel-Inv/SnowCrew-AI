/**
 * Remote GitHub token revocation.
 *
 * Calls the OAuth applications "delete an app authorization" endpoint:
 *
 *   DELETE https://api.github.com/applications/{client_id}/grant
 *   Authorization: Basic base64(client_id:client_secret)
 *   { "access_token": "<token>" }
 *
 * Docs: https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization
 *
 * Semantics:
 *   - 204 No Content  → grant revoked (success)
 *   - 404 Not Found   → grant already absent on GitHub (we treat as
 *                       a success-equivalent at the caller layer because
 *                       there is nothing to revoke). This module still
 *                       reports `{ ok: false, status: 404 }` so the
 *                       caller can distinguish "we revoked" from
 *                       "nothing to revoke" if it cares.
 *   - any other       → `{ ok: false, status }`
 *   - network error / timeout → throws; the caller is expected to catch
 *     and decide whether the local-only delete should still succeed.
 *
 * The token argument is NEVER logged here, even on failure. Callers must
 * mirror that: log only the status code, not the token.
 */

/** Timeout for the GitHub revocation call. */
const REVOKE_TIMEOUT_MS = 10_000;

export interface RevokeGitHubTokenInput {
  /** Plaintext OAuth access token to revoke. Never logged. */
  token: string;
  /** GitHub OAuth App client id. */
  clientId: string;
  /** GitHub OAuth App client secret. */
  clientSecret: string;
}

export interface RevokeGitHubTokenResult {
  ok: boolean;
  status: number;
}

/**
 * Send a DELETE to `applications/{clientId}/grant` to revoke the user's
 * authorization grant on GitHub. Returns the HTTP outcome — does not
 * throw on HTTP errors (only on network/timeout failure, which the
 * caller is expected to catch).
 */
export async function revokeGitHubToken(
  input: RevokeGitHubTokenInput
): Promise<RevokeGitHubTokenResult> {
  const { token, clientId, clientSecret } = input;

  // Defensive — the caller layer should already gate on these, but
  // throwing here on a misconfiguration is friendlier than sending a
  // request with `Basic Og==` (empty credentials).
  if (!token) throw new Error('revokeGitHubToken: token is required');
  if (!clientId) throw new Error('revokeGitHubToken: clientId is required');
  if (!clientSecret) {
    throw new Error('revokeGitHubToken: clientSecret is required');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const url = `https://api.github.com/applications/${encodeURIComponent(
    clientId
  )}/grant`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'SnowCrewAI',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ access_token: token }),
      signal: controller.signal,
    });

    // GitHub returns 204 on success. We treat anything in 2xx as ok
    // for defense in depth, but in practice only 204 is documented.
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}
