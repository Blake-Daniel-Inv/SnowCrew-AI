// Pure-function tests for the helpers exported from useUserCredentials.ts.
// vitest.config.ts pins us to the `node` environment (no jsdom), so we
// intentionally skip the React-hook surface and cover the deterministic
// helpers instead. These are the bits the UI gates user-visible messages
// on, so regressions here flip "Connected just now" → "Never used" or
// turn a friendly error into the generic fallback.

import { describe, expect, it } from 'vitest';
import {
  describeGitHubError,
  findCredential,
  formatRelativeTime,
} from './useUserCredentials';
import type { UserCredentialPublic } from '@/types';

const NOW = 1_700_000_000_000;

function ghCred(overrides: Partial<UserCredentialPublic> = {}): UserCredentialPublic {
  return {
    provider: 'github',
    accountLogin: 'octocat',
    accountId: '1',
    scopes: ['repo'],
    connectedAt: NOW - 60_000,
    lastUsedAt: NOW - 5_000,
    expiresAt: null,
    ...overrides,
  };
}

describe('findCredential', () => {
  it('returns the matching provider row', () => {
    const cred = ghCred();
    expect(findCredential([cred], 'github')).toBe(cred);
  });

  it('returns null when no row matches', () => {
    expect(findCredential([], 'github')).toBeNull();
  });
});

describe('formatRelativeTime', () => {
  it('returns "Never used" for null timestamps', () => {
    expect(formatRelativeTime(null, NOW)).toBe('Never used');
  });

  it('returns "just now" for under a minute', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('just now');
  });

  it('returns minutes for under an hour', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
  });

  it('returns hours for under a day', () => {
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe('3 hr ago');
  });

  it('singularizes "1 day ago"', () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('1 day ago');
  });

  it('pluralizes multiple days', () => {
    expect(formatRelativeTime(NOW - 5 * 24 * 60 * 60_000, NOW)).toBe(
      '5 days ago'
    );
  });

  it('falls back to ISO date past a month', () => {
    // 45 days before NOW=1_700_000_000_000 lands in mid-2023.
    const stamp = NOW - 45 * 24 * 60 * 60_000;
    const out = formatRelativeTime(stamp, NOW);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not crash on a future timestamp', () => {
    expect(formatRelativeTime(NOW + 1_000, NOW)).toBe('just now');
  });

  it('handles non-finite input defensively', () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('Never used');
  });
});

describe('describeGitHubError', () => {
  it.each([
    ['timeout', 'GitHub took too long to respond'],
    ['invalid_state', 'Security check failed — please try again'],
    ['access_denied', 'You declined the GitHub authorization'],
    ['not_configured', 'GitHub OAuth is not configured on this server'],
    ['token_exchange_failed', 'Could not exchange the GitHub authorization code'],
    ['user_lookup_failed', 'GitHub did not return your account details'],
    ['storage_failed', 'Could not save the GitHub credential'],
  ])('maps %s correctly', (reason, message) => {
    expect(describeGitHubError(reason)).toBe(message);
  });

  it('falls back to a generic message for unknown reasons', () => {
    expect(describeGitHubError('something-weird')).toBe(
      'Could not connect to GitHub'
    );
  });

  it('falls back for null / undefined / empty', () => {
    expect(describeGitHubError(null)).toBe('Could not connect to GitHub');
    expect(describeGitHubError(undefined)).toBe('Could not connect to GitHub');
    expect(describeGitHubError('')).toBe('Could not connect to GitHub');
  });
});
