// Unit tests for the runner's GitHub-credential env forwarding. We avoid
// touching the SQLite-backed credentials-db here by passing an explicit
// `TokenLookup` callback — production callers use the default which is
// `getCredentialToken`, but the helper accepts an override exactly so we
// can test the decision tree without spinning up the DB.

import { describe, expect, it } from 'vitest';
import {
  collectGitHubTokenForwards,
  type TokenLookup,
} from './github-env';

type WorkspaceLike = Parameters<typeof collectGitHubTokenForwards>[1];

function makeWorkspace(toolsPerAgent: string[][]): WorkspaceLike {
  return {
    agents: toolsPerAgent.map((tools) => ({ tools })),
  };
}

function lookupReturning(token: string | null): TokenLookup {
  return async () => token;
}

describe('collectGitHubTokenForwards', () => {
  it('returns empty env when no agent declares the github tool', async () => {
    const lookup = lookupReturning('should-not-be-used');
    const result = await collectGitHubTokenForwards(
      'owner-1',
      makeWorkspace([[], ['some-other-tool']]),
      lookup
    );
    expect(result).toEqual({ env: {}, missingTokenButNeeded: false });
  });

  it('injects GITHUB_TOKEN when an agent declares the tool and a token is stored', async () => {
    const lookup = lookupReturning('ghp_abc123');
    const result = await collectGitHubTokenForwards(
      'owner-1',
      makeWorkspace([['github']]),
      lookup
    );
    expect(result.missingTokenButNeeded).toBe(false);
    expect(result.env).toEqual({
      GITHUB_TOKEN: 'ghp_abc123',
      GITHUB_TOKEN_AVAILABLE: '1',
    });
  });

  it('flags missing-token-but-needed when no credential is stored', async () => {
    const lookup = lookupReturning(null);
    const result = await collectGitHubTokenForwards(
      'owner-1',
      makeWorkspace([['github']]),
      lookup
    );
    expect(result).toEqual({ env: {}, missingTokenButNeeded: true });
  });

  it('returns missing-but-needed when ownerId is empty (no lookup attempt)', async () => {
    let calls = 0;
    const lookup: TokenLookup = async () => {
      calls += 1;
      return 'should-not-be-returned';
    };
    const result = await collectGitHubTokenForwards(
      '',
      makeWorkspace([['github']]),
      lookup
    );
    expect(result).toEqual({ env: {}, missingTokenButNeeded: true });
    expect(calls).toBe(0);
  });

  it('finds the tool declaration across multiple agents', async () => {
    const lookup = lookupReturning('tok');
    const result = await collectGitHubTokenForwards(
      'owner-1',
      makeWorkspace([['other'], ['snowflake'], ['github']]),
      lookup
    );
    expect(result.env.GITHUB_TOKEN).toBe('tok');
    expect(result.missingTokenButNeeded).toBe(false);
  });

  it('tolerates an agent with no tools array', async () => {
    const lookup = lookupReturning('tok');
    // Force the loose type — the field is optional at the type level
    // and the helper must not throw if it's missing entirely.
    const workspace: WorkspaceLike = {
      agents: [{}, { tools: ['github'] }],
    };
    const result = await collectGitHubTokenForwards('owner-1', workspace, lookup);
    expect(result.env.GITHUB_TOKEN).toBe('tok');
  });

  it('only calls the lookup once even when multiple agents declare the tool', async () => {
    let calls = 0;
    const lookup: TokenLookup = async () => {
      calls += 1;
      return 'tok';
    };
    await collectGitHubTokenForwards(
      'owner-1',
      makeWorkspace([['github'], ['github'], ['github']]),
      lookup
    );
    expect(calls).toBe(1);
  });

  it('passes the literal "github" provider name to the lookup', async () => {
    const received: Array<[string, string]> = [];
    const lookup: TokenLookup = async (ownerId, provider) => {
      received.push([ownerId, provider]);
      return 'tok';
    };
    await collectGitHubTokenForwards(
      'owner-42',
      makeWorkspace([['github']]),
      lookup
    );
    expect(received).toEqual([['owner-42', 'github']]);
  });
});
