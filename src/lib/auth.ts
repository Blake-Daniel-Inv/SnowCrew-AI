/**
 * Auth helpers for route handlers. Identity resolution + CSRF live in
 * middleware.ts; this module just reads the headers that middleware
 * guarantees are populated.
 *
 * Header contract (set by src/middleware.ts):
 *   x-snowcrew-user        — caller identity (never empty post-middleware)
 *   x-snowcrew-user-role   — caller role (may be empty)
 */

export const SNOWCREW_USER_HEADER = 'x-snowcrew-user';
export const SNOWCREW_USER_ROLE_HEADER = 'x-snowcrew-user-role';

/**
 * Thrown when caller identity cannot be resolved from request headers.
 * Middleware should have populated `x-snowcrew-user` for every `/api/*`
 * request — encountering this error means middleware was bypassed or
 * misconfigured, which is a server bug (500), not an unauthenticated
 * client (401). Route handlers may still catch it for defense in depth.
 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface CallerIdentity {
  user: string;
  role: string | null;
}

/**
 * Read caller identity from headers set by middleware. Throws AuthError
 * if the user header is missing — this should never happen for routes
 * matched by the middleware's `/api/:path*` matcher.
 */
export function getCallerFromRequest(req: Request): CallerIdentity {
  const user = req.headers.get(SNOWCREW_USER_HEADER);
  if (!user) {
    throw new AuthError(
      `Missing ${SNOWCREW_USER_HEADER} header — middleware did not run for this request.`
    );
  }
  const roleRaw = req.headers.get(SNOWCREW_USER_ROLE_HEADER);
  const role = roleRaw && roleRaw.length > 0 ? roleRaw : null;
  return { user, role };
}
