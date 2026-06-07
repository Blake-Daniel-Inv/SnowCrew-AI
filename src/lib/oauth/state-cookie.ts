import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-signed OAuth state cookie helpers.
 *
 * Purpose: when we redirect a user to GitHub for authorize, we need to
 * remember two things until they come back:
 *   1. The 32-byte `state` value (CSRF defense for the OAuth handshake).
 *   2. The userId who started the flow — so a different user finishing
 *      the same browser's redirect cannot bind a token to their account.
 *
 * We pack both into a single cookie and sign it with HMAC-SHA256 keyed
 * off `CREDENTIALS_MASTER_KEY`. The master key never leaves the server,
 * so the client cannot forge a state payload. Verification uses
 * `crypto.timingSafeEqual` so we don't leak the HMAC byte by byte.
 *
 * Wire format (all base64url-safe so it fits inside a cookie value
 * without escaping):
 *
 *   <state-b64url>.<userId-b64url>.<hmac-b64url>
 *
 * The HMAC covers `state || '.' || userId` so re-ordering or swapping
 * the two values invalidates the signature.
 */

/** Cookie name. The `__Host-` prefix locks the cookie to HTTPS + path=/. */
export const GH_OAUTH_STATE_COOKIE = '__Host-gh-oauth-state';

/**
 * Cookie option block re-used by the start and callback routes so they
 * stay in lockstep. `Path` must be `/` for `__Host-` prefix to validate
 * (the prefix forbids `Domain` and requires `Secure`).
 *
 * 600s = 10 minutes. The OAuth round-trip is usually under a minute;
 * 10 minutes is enough slack for a user who walks away mid-flow without
 * leaving the state hanging around indefinitely.
 */
export const GH_OAUTH_STATE_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 600,
});

/**
 * Cleared-cookie option block. Same scope as the live cookie, with
 * `maxAge: 0` so the browser drops it immediately. Use after both
 * success and failure on the callback so a replayed state can't be
 * reused.
 */
export const GH_OAUTH_STATE_COOKIE_CLEAR_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 0,
});

function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function fromBase64Url(input: string): Buffer | null {
  // base64url chars only — reject anything that would silently decode
  // to garbage (e.g., embedded '.' from a malformed cookie split).
  if (input.length === 0 || !/^[A-Za-z0-9_-]+$/.test(input)) return null;
  try {
    return Buffer.from(input, 'base64url');
  } catch {
    return null;
  }
}

function computeHmac(state: string, userId: string, masterKey: Buffer): Buffer {
  // We bind state and userId via an unambiguous separator so a payload
  // like `state="a.b", userId="c"` can't collide with `state="a", userId="b.c"`.
  // Base64url-encoding both sides before joining keeps the separator clean.
  const stateB64 = toBase64Url(state);
  const userIdB64 = toBase64Url(userId);
  const mac = createHmac('sha256', masterKey);
  mac.update(`${stateB64}.${userIdB64}`);
  return mac.digest();
}

/**
 * Build the cookie value for a fresh OAuth flow. The caller is expected
 * to wrap this in the cookie-setting machinery (NextResponse headers,
 * etc) with `GH_OAUTH_STATE_COOKIE_OPTIONS`.
 */
export function signStatePayload(
  state: string,
  userId: string,
  masterKey: Buffer
): string {
  if (!state) throw new Error('signStatePayload: state is required');
  if (!userId) throw new Error('signStatePayload: userId is required');
  if (!masterKey || masterKey.length === 0) {
    throw new Error('signStatePayload: masterKey is required');
  }
  const hmac = computeHmac(state, userId, masterKey);
  return [
    toBase64Url(state),
    toBase64Url(userId),
    toBase64Url(hmac),
  ].join('.');
}

/**
 * Verify a cookie value. Returns the decoded `{ state, userId }` on
 * success or `null` on any failure — wrong master key, tampered
 * payload, malformed input, or missing components. Never throws on
 * untrusted input; the route layer needs a clean boolean to decide
 * between 403 and "proceed".
 *
 * HMAC comparison uses `crypto.timingSafeEqual` so the running time
 * doesn't leak which byte first diverged.
 */
export function verifyStatePayload(
  cookieValue: string,
  masterKey: Buffer
): { state: string; userId: string } | null {
  if (typeof cookieValue !== 'string' || cookieValue.length === 0) return null;
  if (!masterKey || masterKey.length === 0) return null;

  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;

  const [stateB64, userIdB64, hmacB64] = parts;
  const stateBuf = fromBase64Url(stateB64);
  const userIdBuf = fromBase64Url(userIdB64);
  const hmacBuf = fromBase64Url(hmacB64);
  if (!stateBuf || !userIdBuf || !hmacBuf) return null;

  const state = stateBuf.toString('utf8');
  const userId = userIdBuf.toString('utf8');
  if (state.length === 0 || userId.length === 0) return null;

  const expected = computeHmac(state, userId, masterKey);
  // timingSafeEqual requires equal lengths — bail out before calling it
  // if the lengths diverge so we don't throw on a short/long forgery.
  if (expected.length !== hmacBuf.length) return null;
  if (!timingSafeEqual(expected, hmacBuf)) return null;

  return { state, userId };
}
