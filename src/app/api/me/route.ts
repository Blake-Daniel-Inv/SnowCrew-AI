import { NextResponse } from 'next/server';
import { getCallerFromRequest } from '@/lib/auth';
import { NO_STORE_HEADERS } from '@/lib/schemas/common';
import { getSnowflakeAuth } from '@/lib/snowflake-auth';

export const runtime = 'nodejs';

type MeMode = 'spcs' | 'local' | 'unavailable' | 'unauthenticated';

/**
 * GET /api/me
 *
 * Returns the visiting user's Snowflake identity (when running behind
 * the SPCS public ingress) and the auth mode the server is using.
 *
 * The Studio displays this in the toolbar so it's clear who is logged
 * in and which auth path is active. Identity is sourced exclusively
 * from the middleware-set `x-snowcrew-user` header (via
 * `getCallerFromRequest`). We deliberately do NOT fall back to the raw
 * `Sf-Context-*` request headers here — those can be spoofed by any
 * client when middleware is not enforcing them, and trusting them
 * would let unauthenticated callers impersonate any Snowflake user.
 */
export async function GET(request: Request) {
  let callerUser: string | null = null;
  let callerRole: string | null = null;
  let identityResolved = false;
  try {
    const caller = getCallerFromRequest(request);
    callerUser = caller.user;
    callerRole = caller.role;
    identityResolved = true;
  } catch {
    // Middleware did not stamp the identity headers. Do NOT consult the
    // raw ingress headers — they're untrusted on this path.
    callerUser = null;
    callerRole = null;
    identityResolved = false;
  }

  const auth = getSnowflakeAuth();
  let mode: MeMode;
  if (!identityResolved) {
    mode = 'unauthenticated';
  } else if (!auth) {
    mode = 'unavailable';
  } else {
    mode = auth.source === 'spcs-session' ? 'spcs' : 'local';
  }

  return NextResponse.json(
    {
      user: callerUser,
      role: callerRole,
      account: null,
      mode,
      host: auth?.host || null,
      tokenType: auth?.tokenType || null,
    },
    { headers: NO_STORE_HEADERS }
  );
}
