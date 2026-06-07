import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware for `/api/*`.
 *
 *  1. Resolve caller identity.
 *     - SPCS mode (NEXT_PUBLIC_CONTAINER_MODE === '1'): trust the
 *       Snowflake-injected `Sf-Context-Current-User` header; 401 when
 *       missing because the request did not originate from a
 *       Snowflake-authenticated session.
 *     - Local mode: use $DEV_USER or 'local-user'. Never 401 locally.
 *  2. CSRF: for unsafe methods, require an `Origin` header that matches
 *     the request's own host. 403 otherwise.
 *  3. Forward identity downstream as immutable `x-snowcrew-user` and
 *     `x-snowcrew-user-role` headers so route handlers don't re-implement
 *     this resolution.
 */

export const config = {
  matcher: '/api/:path*',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PREFLIGHT_METHODS = new Set(['HEAD', 'OPTIONS']);
const SPCS_USER_HEADER = 'sf-context-current-user';
const SPCS_ROLE_HEADER = 'sf-context-current-role';
const RESERVED_SENTINELS = new Set(['__legacy__']);

function isContainerMode(): boolean {
  // `NEXT_PUBLIC_*` env vars are inlined at build time; if the build
  // didn't set it, SPCS would silently downgrade to local-mode and
  // multi-tenant identity would collapse to 'local-user'. Read the
  // runtime-only signals too so a non-public flag or the presence of
  // DATA_DIR (set by the SPCS image entrypoint) is sufficient.
  return (
    process.env.NEXT_PUBLIC_CONTAINER_MODE === '1' ||
    process.env.CONTAINER_MODE === '1' ||
    Boolean(process.env.DATA_DIR)
  );
}

function originMatchesHost(originHeader: string, hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    return false;
  }
  return originHost === hostHeader;
}

function resolveDevUser(): string {
  const raw = process.env.DEV_USER?.trim();
  if (
    raw &&
    raw.length > 0 &&
    raw.length <= 256 &&
    !RESERVED_SENTINELS.has(raw) &&
    /^[a-zA-Z0-9._-]+$/.test(raw)
  ) {
    return raw;
  }
  return 'local-user';
}

export function middleware(request: NextRequest) {
  // ---- 0. Preflight short-circuit --------------------------------------
  // HEAD/OPTIONS preflights are unauthenticated by spec; bypass identity
  // injection entirely so SPCS mode doesn't 401 them.
  if (PREFLIGHT_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  // ---- 0b. Health probes ----------------------------------------------
  // SPCS / k8s probes hit `/api/health/live` and `/api/health/ready`
  // without identity headers — they must succeed during boot before
  // Snowflake has injected `Sf-Context-Current-User`. Skip the whole
  // identity + CSRF pipeline so a missing SPCS header on a GET probe
  // doesn't 401 the load balancer's reachability check.
  if (request.nextUrl.pathname.startsWith('/api/health/')) {
    return NextResponse.next();
  }

  // ---- 1. Identity ------------------------------------------------------
  let user: string | null = null;
  let role: string | null = null;

  if (isContainerMode()) {
    user = request.headers.get(SPCS_USER_HEADER);
    role = request.headers.get(SPCS_ROLE_HEADER);
    if (!user) {
      return new NextResponse('Unauthorized: missing Snowflake context', {
        status: 401,
      });
    }
  } else {
    user = resolveDevUser();
    role = request.headers.get(SPCS_ROLE_HEADER); // empty in practice; preserved for parity
  }

  // ---- 2. CSRF ----------------------------------------------------------
  if (!SAFE_METHODS.has(request.method)) {
    const origin = request.headers.get('origin');
    const forwardedHost = request.headers.get('x-forwarded-host');
    const host = forwardedHost || request.headers.get('host');
    if (!origin || !originMatchesHost(origin, host)) {
      return new NextResponse('Forbidden: origin mismatch', { status: 403 });
    }
  }

  // ---- 3. Forward identity ---------------------------------------------
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-snowcrew-user', user);
  requestHeaders.set('x-snowcrew-user-role', role ?? '');

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}
