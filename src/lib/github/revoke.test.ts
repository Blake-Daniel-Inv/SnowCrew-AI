import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeGitHubToken } from './revoke';

// We mock `globalThis.fetch` per-test using vi.fn().mockImplementation()
// so we can assert call args without relying on a global module mock.
// The pattern mirrors the rest of the codebase: tiny, explicit, no MSW.

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(
  impl: (call: CapturedCall) => Promise<Response> | Response
): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  const mockFetch = vi.fn().mockImplementation(
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
  // Cast through unknown so we don't fight the Response/Request fetch shape.
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    mockFetch as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
    },
  };
}

describe('revokeGitHubToken', () => {
  let installed: ReturnType<typeof installFetchMock> | null = null;

  beforeEach(() => {
    installed = null;
  });

  afterEach(() => {
    installed?.restore();
    installed = null;
  });

  it('returns { ok: true, status: 204 } on a successful revoke', async () => {
    installed = installFetchMock(
      () => new Response(null, { status: 204 })
    );
    const result = await revokeGitHubToken({
      token: 'gho_abc',
      clientId: 'cid',
      clientSecret: 'csec',
    });
    expect(result).toEqual({ ok: true, status: 204 });
  });

  it('sends DELETE to the documented URL with Basic auth + JSON body', async () => {
    installed = installFetchMock(
      () => new Response(null, { status: 204 })
    );
    await revokeGitHubToken({
      token: 'gho_xyz',
      clientId: 'my-client',
      clientSecret: 'my-secret',
    });
    expect(installed.calls).toHaveLength(1);
    const [call] = installed.calls;
    expect(call.url).toBe(
      'https://api.github.com/applications/my-client/grant'
    );
    expect(call.init.method).toBe('DELETE');

    // Headers — accept any header shape (Headers | Record | array of pairs).
    const headers = new Headers(call.init.headers as HeadersInit);
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.get('User-Agent')).toBe('SnowCrewAI');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    const expectedBasic = Buffer.from('my-client:my-secret').toString('base64');
    expect(headers.get('Authorization')).toBe(`Basic ${expectedBasic}`);

    // Body must carry the access_token field and nothing surprising.
    expect(typeof call.init.body).toBe('string');
    const parsed = JSON.parse(call.init.body as string) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ access_token: 'gho_xyz' });
  });

  it('treats 404 as a non-throwing { ok: false, status: 404 } (already revoked)', async () => {
    installed = installFetchMock(
      () => new Response(null, { status: 404 })
    );
    const result = await revokeGitHubToken({
      token: 'gho_abc',
      clientId: 'cid',
      clientSecret: 'csec',
    });
    expect(result).toEqual({ ok: false, status: 404 });
  });

  it('returns { ok: false, status: 500 } on upstream server errors', async () => {
    installed = installFetchMock(
      () => new Response('boom', { status: 500 })
    );
    const result = await revokeGitHubToken({
      token: 'gho_abc',
      clientId: 'cid',
      clientSecret: 'csec',
    });
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('rejects with AbortError when the upstream call times out', async () => {
    // Simulate a fetch that respects AbortSignal but never resolves on
    // its own. Wire the abort listener BEFORE we kick off the
    // revokeGitHubToken call (so the rejection is owned by the
    // returned promise from the start) — that prevents the
    // unhandled-rejection warning vitest reports otherwise.
    installed = installFetchMock(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal | undefined;
          if (!signal) {
            reject(new Error('no signal wired'));
            return;
          }
          const onAbort = () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        })
    );

    vi.useFakeTimers();
    try {
      const promise = revokeGitHubToken({
        token: 'gho_abc',
        clientId: 'cid',
        clientSecret: 'csec',
      });
      // Attach the rejection handler immediately so the rejection is
      // never "unhandled" in the brief window between abort and assert.
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on missing token / clientId / clientSecret', async () => {
    installed = installFetchMock(
      () => new Response(null, { status: 204 })
    );
    await expect(
      revokeGitHubToken({ token: '', clientId: 'a', clientSecret: 'b' })
    ).rejects.toThrow(/token/);
    await expect(
      revokeGitHubToken({ token: 't', clientId: '', clientSecret: 'b' })
    ).rejects.toThrow(/clientId/);
    await expect(
      revokeGitHubToken({ token: 't', clientId: 'a', clientSecret: '' })
    ).rejects.toThrow(/clientSecret/);
    // No fetch should have been issued for the bad inputs.
    expect(installed.calls).toHaveLength(0);
  });
});
