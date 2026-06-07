/**
 * GitHub `/user/orgs` fetch helper.
 *
 *   GET https://api.github.com/user/orgs
 *   Authorization: Bearer <token>
 *   Accept: application/vnd.github+json
 *   User-Agent: SnowCrewAI
 *   X-GitHub-Api-Version: 2022-11-28
 *
 * Docs: https://docs.github.com/en/rest/orgs/orgs#list-organizations-for-the-authenticated-user
 *
 * Contract:
 *   - On 200 with a well-formed array: returns the parsed orgs.
 *   - On any other status (401, 403, 404, 5xx): returns `[]` and logs a
 *     warning server-side. We never want a slow / down GitHub to fail
 *     the OAuth callback — the user is still authenticated, the
 *     metadata is just a nice-to-have.
 *   - On timeout: returns `[]` and logs `timeout`.
 *   - On malformed JSON or unexpected payload shape: returns `[]`.
 *   - NEVER throws. Caller-friendly: callers can safely chain it
 *     without try/catch.
 *
 * Privacy note: GitHub `/user/orgs` only returns orgs where the user
 * has granted at least read-membership visibility for this OAuth app.
 * Private orgs the user is in but where their membership is private
 * AND the org admin hasn't granted this OAuth app third-party access
 * won't appear. That's the user's / org's GitHub privacy setting and
 * is not something we can override.
 *
 * Token argument is NEVER logged here, even on failure.
 */

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ module: 'github/orgs' });

/** 10s ceiling on the upstream call. GitHub is usually < 500ms. */
const ORGS_TIMEOUT_MS = 10_000;

/**
 * One organization the user is a visible member of. Mirrors the
 * `GitHubOrgMembership` interface in src/types/index.ts, but lives
 * here on the snake_case wire side so the OAuth callback can map
 * cleanly from upstream into our canonical shape.
 */
export interface GitHubOrg {
  login: string;
  id: number;
  description: string | null;
  avatar_url: string | null;
}

/**
 * Type guard for a single org entry. We only accept (login, id) as
 * required because GitHub historically returns those for every row;
 * description and avatar_url are coerced to null when absent / wrong
 * type to keep the downstream shape predictable.
 */
function coerceOrg(raw: unknown): GitHubOrg | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.login !== 'string' || typeof r.id !== 'number') return null;
  return {
    login: r.login,
    id: r.id,
    description: typeof r.description === 'string' ? r.description : null,
    avatar_url: typeof r.avatar_url === 'string' ? r.avatar_url : null,
  };
}

/**
 * Fetch the orgs visible to `token`. Returns `[]` on any non-200,
 * timeout, malformed payload, or network error. Does not throw.
 */
export async function fetchGitHubUserOrgs(token: string): Promise<GitHubOrg[]> {
  if (!token) {
    // Defensive — caller is the OAuth callback which always has a
    // freshly-exchanged token, but an empty string here would be a
    // silent 401 storm against GitHub, so we short-circuit.
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORGS_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.github.com/user/orgs', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SnowCrewAI',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Log only the status — never the token. 401 means scope was
      // revoked between token exchange and orgs fetch (rare but real);
      // 403/404 mean the user has no visible orgs or the rate limit
      // tripped; 5xx means GitHub is having a moment. All collapse to
      // "empty list, proceed".
      log.warn({ status: response.status }, '/user/orgs returned non-OK');
      return [];
    }

    const raw = (await response.json()) as unknown;
    if (!Array.isArray(raw)) {
      log.warn('/user/orgs returned non-array payload');
      return [];
    }

    const orgs: GitHubOrg[] = [];
    for (const entry of raw) {
      const coerced = coerceOrg(entry);
      if (coerced) orgs.push(coerced);
    }
    return orgs;
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    log.warn(
      {
        aborted,
        errName: error instanceof Error ? error.name : 'unknown',
      },
      '/user/orgs threw'
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}
