// Per-run GitHub credential env forwarding for the python subprocess.
//
// Extracted from manager.ts so the lookup can be unit-tested without
// spinning up the full runner. The runner imports `collectGitHubTokenForwards`
// and merges the returned env map into the subprocess env right next to
// `collectPasswordEnvForwards` (the Snowflake-side equivalent).
//
// Contract:
//   - If no agent in the workspace declares the `github` tool, we return
//     an empty env map and `missingTokenButNeeded: false`. The runner
//     then injects nothing GitHub-related; the python tool would also
//     never be imported in that case (crew-py.ts emits it conditionally).
//   - If at least one agent declares `github` and the user has a stored
//     GitHub credential, we return `{ GITHUB_TOKEN, GITHUB_TOKEN_AVAILABLE }`
//     and `missingTokenButNeeded: false`. The token is the decrypted
//     value pulled from credentials-db; never log it or include it in
//     error messages.
//   - If at least one agent declares `github` but no credential is
//     stored, we return an empty env map and `missingTokenButNeeded: true`.
//     The runner uses that flag to emit a non-terminal warning event so
//     the user sees the missing-credential explanation in the run trace.

import type { CrewStudioWorkspace } from '@/types';
import { getCredentialToken } from '@/lib/credentials-db';

export interface GitHubEnvForwardResult {
  /** Env additions to merge into the subprocess env. May be empty. */
  env: Record<string, string>;
  /**
   * True when at least one agent declared the `github` tool but the
   * user has no stored credential. The caller emits a warning event in
   * this case; the run still starts so the failure surfaces in-trace.
   */
  missingTokenButNeeded: boolean;
}

/**
 * Narrow shape of the agent record we actually care about — accepting
 * a wider `tools?: string[]` so callers don't have to thread the full
 * CrewStudioAgent type through.
 */
interface AgentLike {
  tools?: string[] | null;
}

/**
 * Optional injection seam for tests: replace the token lookup without
 * mocking the whole credentials-db module. Production callers omit this
 * and the helper falls back to the real `getCredentialToken`.
 */
export type TokenLookup = (
  ownerId: string,
  provider: 'github'
) => Promise<string | null>;

function workspaceNeedsGitHub(
  workspace: { agents?: AgentLike[] | null }
): boolean {
  const agents = Array.isArray(workspace.agents) ? workspace.agents : [];
  return agents.some((agent) => {
    const tools = Array.isArray(agent?.tools) ? agent.tools : [];
    return tools.includes('github');
  });
}

export async function collectGitHubTokenForwards(
  ownerId: string,
  workspace: Pick<CrewStudioWorkspace, 'agents'> | { agents?: AgentLike[] | null },
  lookup: TokenLookup = getCredentialToken
): Promise<GitHubEnvForwardResult> {
  if (!workspaceNeedsGitHub(workspace)) {
    return { env: {}, missingTokenButNeeded: false };
  }
  const token = ownerId ? await lookup(ownerId, 'github') : null;
  if (!token) {
    return { env: {}, missingTokenButNeeded: true };
  }
  return {
    env: {
      GITHUB_TOKEN: token,
      GITHUB_TOKEN_AVAILABLE: '1',
    },
    missingTokenButNeeded: false,
  };
}
