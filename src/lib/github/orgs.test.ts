import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubUserOrgs } from './orgs';

// Same fetch-mock harness shape as revoke.test.ts — tiny, explicit, no MSW.

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(
  impl: (call: CapturedCall) => Promise<Response> | Response
): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  const mockFetch = vi
    .fn()
    .mockImplementation(
      async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        const call: CapturedCall = { url, init };
        calls.push(call);
        return impl(call);
      }
    );
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    mockFetch as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
    },
  };
}

describe('fetchGitHubUserOrgs', () => {
  let installed: ReturnType<typeof installFetchMock> | null = null;

  beforeEach(() => {
    installed = null;
  });

  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  it('returns parsed orgs on a 200 success', async () => {
    installed = installFetchMock(
      () =>
        new Response(
          JSON.stringify([
            {
              login: 'acme',
              id: 1,
              description: 'Acme Inc',
              avatar_url: 'https://example.test/a.png',
            },
            {
              login: 'beta',
              id: 2,
              description: null,
              avatar_url: 'https://example.test/b.png',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
    );
    const orgs = await fetchGitHubUserOrgs('gho_abc');
    expect(orgs).toEqual([
      {
        login: 'acme',
        id: 1,
        description: 'Acme Inc',
        avatar_url: 'https://example.test/a.png',
      },
      {
        login: 'beta',
        id: 2,
        description: null,
        avatar_url: 'https://example.test/b.png',
      },
    ]);
  });

  it('sends the documented headers + URL', async () => {
    installed = installFetchMock(
      () =>
        new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    await fetchGitHubUserOrgs('gho_xyz');
    expect(installed.calls).toHaveLength(1);
    const [call] = installed.calls;
    expect(call.url).toBe('https://api.github.com/user/orgs');
    expect(call.init.method).toBe('GET');
    const headers = new Headers(call.init.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer gho_xyz');
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.get('User-Agent')).toBe('SnowCrewAI');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
  });

  it('returns [] on a 401 (revoked between exchange and orgs fetch)', async () => {
    installed = installFetchMock(() => new Response(null, { status: 401 }));
    const orgs = await fetchGitHubUserOrgs('gho_abc');
    expect(orgs).toEqual([]);
  });

  it('returns [] on a 5xx upstream error', async () => {
    installed = installFetchMock(
      () => new Response('boom', { status: 500 })
    );
    const orgs = await fetchGitHubUserOrgs('gho_abc');
    expect(orgs).toEqual([]);
  });

  it('returns [] on a timeout (AbortError) without throwing', async () => {
    installed = installFetchMock(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal | undefined;
          if (!signal) {
            reject(new Error('no signal wired'));
            return;
          }
          const onAbort = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })
    );
    vi.useFakeTimers();
    try {
      const promise = fetchGitHubUserOrgs('gho_abc');
      await vi.advanceTimersByTimeAsync(11_000);
      const orgs = await promise;
      expect(orgs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns [] on malformed JSON', async () => {
    installed = installFetchMock(
      () =>
        new Response('this is not json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const orgs = await fetchGitHubUserOrgs('gho_abc');
    expect(orgs).toEqual([]);
  });

  it('returns [] when GitHub returns a non-array payload', async () => {
    installed = installFetchMock(
      () =>
        new Response(JSON.stringify({ message: 'Not an array' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const orgs = await fetchGitHubUserOrgs('gho_abc');
    expect(orgs).toEqual([]);
  });

  it('drops entries missing login or id (defensive shape check)', async () => {
    installed = installFetchMock(
      () =>
        new Response(
          JSON.stringify([
            { login: 'good', id: 1, description: null, avatar_url: null },
            { login: 'bad-no-id' },
            { id: 99 }, // missing login
            null,
            { login: 42, id: 'oops' }, // wrong types
            {
              login: 'also-good',
              id: 2,
              description: 'desc',
              avatar_url: 'u',
            },
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
    );
    const orgs = await fetchGitHubUserOrgs('gho_abc');
    expect(orgs.map((o) => o.login)).toEqual(['good', 'also-good']);
  });

  it('short-circuits on empty token without hitting fetch', async () => {
    installed = installFetchMock(
      () => new Response('[]', { status: 200 })
    );
    const orgs = await fetchGitHubUserOrgs('');
    expect(orgs).toEqual([]);
    expect(installed.calls).toHaveLength(0);
  });
});
