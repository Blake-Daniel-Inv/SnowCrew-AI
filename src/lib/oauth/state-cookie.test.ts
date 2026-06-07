import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  GH_OAUTH_STATE_COOKIE,
  GH_OAUTH_STATE_COOKIE_OPTIONS,
  GH_OAUTH_STATE_COOKIE_CLEAR_OPTIONS,
  signStatePayload,
  verifyStatePayload,
} from './state-cookie';

const KEY = randomBytes(32);

function flipFirstChar(s: string): string {
  // Flip the first base64url char to a guaranteed-different but still
  // base64url-valid char so we exercise "valid format, wrong content"
  // rather than "malformed input rejected at parse".
  const first = s[0];
  const replacement = first === 'A' ? 'B' : 'A';
  return replacement + s.slice(1);
}

describe('signStatePayload / verifyStatePayload', () => {
  it('round-trips state + userId', () => {
    const state = randomBytes(32).toString('base64url');
    const cookie = signStatePayload(state, 'user-alice', KEY);
    const decoded = verifyStatePayload(cookie, KEY);
    expect(decoded).not.toBeNull();
    expect(decoded?.state).toBe(state);
    expect(decoded?.userId).toBe('user-alice');
  });

  it('round-trips userIds with non-ASCII and email-shaped values', () => {
    const cases = [
      'blake.daniel@adventhealth.com',
      'BLAKE_DANIEL',
      'user.with.中文',
      'user@example.com',
    ];
    for (const userId of cases) {
      const cookie = signStatePayload('abc123', userId, KEY);
      expect(verifyStatePayload(cookie, KEY)?.userId).toBe(userId);
    }
  });

  it('detects tampering with the state component', () => {
    const cookie = signStatePayload('state-original', 'user-a', KEY);
    const [s, u, h] = cookie.split('.');
    const tampered = [flipFirstChar(s), u, h].join('.');
    expect(verifyStatePayload(tampered, KEY)).toBeNull();
  });

  it('detects tampering with the userId component', () => {
    const cookie = signStatePayload('state-original', 'user-a', KEY);
    const [s, u, h] = cookie.split('.');
    const tampered = [s, flipFirstChar(u), h].join('.');
    expect(verifyStatePayload(tampered, KEY)).toBeNull();
  });

  it('detects tampering with the hmac component', () => {
    const cookie = signStatePayload('state-original', 'user-a', KEY);
    const [s, u, h] = cookie.split('.');
    const tampered = [s, u, flipFirstChar(h)].join('.');
    expect(verifyStatePayload(tampered, KEY)).toBeNull();
  });

  it('rejects a payload signed with a different master key', () => {
    const cookie = signStatePayload('abc', 'user-a', KEY);
    const wrongKey = randomBytes(32);
    expect(verifyStatePayload(cookie, wrongKey)).toBeNull();
  });

  it('rejects swapped state/userId order (HMAC binds both)', () => {
    const cookie = signStatePayload('alpha', 'beta', KEY);
    const [s, u, h] = cookie.split('.');
    // Swap the encoded state and userId components but keep the HMAC.
    const swapped = [u, s, h].join('.');
    expect(verifyStatePayload(swapped, KEY)).toBeNull();
  });

  describe('malformed input returns null (not throws)', () => {
    const malformed = [
      '',
      'no-dots-here',
      'only.two',
      'has.four.dots.here',
      'A.B.', // empty hmac
      '.B.C', // empty state
      'A..C', // empty userId
      '!!!.???.@@@', // non-base64url chars
      'spaces in here',
    ];
    for (const bad of malformed) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        expect(verifyStatePayload(bad, KEY)).toBeNull();
      });
    }
  });

  it('rejects a too-short HMAC after truncation', () => {
    const cookie = signStatePayload('abc', 'user-a', KEY);
    const [s, u, h] = cookie.split('.');
    // Truncate the HMAC to one byte's worth of base64url. timingSafeEqual
    // throws on unequal lengths; the helper must short-circuit.
    const truncated = [s, u, h.slice(0, 2)].join('.');
    expect(verifyStatePayload(truncated, KEY)).toBeNull();
  });

  it('signStatePayload throws on empty inputs', () => {
    expect(() => signStatePayload('', 'user-a', KEY)).toThrow();
    expect(() => signStatePayload('abc', '', KEY)).toThrow();
    expect(() => signStatePayload('abc', 'user-a', Buffer.alloc(0))).toThrow();
  });

  it('cookie name uses the __Host- prefix', () => {
    expect(GH_OAUTH_STATE_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('cookie options enforce HttpOnly + Secure + SameSite=Lax + path=/', () => {
    expect(GH_OAUTH_STATE_COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(GH_OAUTH_STATE_COOKIE_OPTIONS.secure).toBe(true);
    expect(GH_OAUTH_STATE_COOKIE_OPTIONS.sameSite).toBe('lax');
    expect(GH_OAUTH_STATE_COOKIE_OPTIONS.path).toBe('/');
    expect(GH_OAUTH_STATE_COOKIE_OPTIONS.maxAge).toBeGreaterThan(0);
    // Clear options must share path/secure/httpOnly so the browser
    // matches the cookie and actually deletes it.
    expect(GH_OAUTH_STATE_COOKIE_CLEAR_OPTIONS.path).toBe('/');
    expect(GH_OAUTH_STATE_COOKIE_CLEAR_OPTIONS.maxAge).toBe(0);
  });
});
