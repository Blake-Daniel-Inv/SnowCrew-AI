import { z } from 'zod';
import { CredentialProviderSchema } from './credentials';

/**
 * Zod schemas for the auth / credentials routes added in PR 2.
 *
 * `GitHubCallbackQuerySchema` validates the query string GitHub sends
 * back to /api/auth/github/callback. GitHub delivers EITHER:
 *   - success: `code` + `state`
 *   - failure: `error` + optional `error_description` + `state`
 *
 * The `.refine()` rule below enforces "at least one of code|error" so
 * the route can branch cleanly without re-checking presence.
 *
 * `DeleteCredentialBodySchema` validates the body of DELETE
 * /api/user/credentials. It is intentionally strict (no unknown keys)
 * so we never silently drop fields that callers thought we honored.
 */

/** Tight upper bound on an OAuth `code`; GitHub codes are ~40 chars. */
const CODE_MAX = 500;
/** Tight upper bound on a `state` token; we issue 32 random bytes → 43 b64url chars. */
const STATE_MAX = 500;
/** Bound on the human-readable error blob so a hostile redirect can't bloat logs. */
const ERROR_MAX = 200;
const ERROR_DESC_MAX = 2_000;

/**
 * GET /api/auth/github/callback?code=...&state=...
 *   - on user-cancel/denied: ?error=access_denied&error_description=...&state=...
 *
 * Both `code` and `error` are individually optional, but the schema
 * rejects payloads that have neither — that shape would be GitHub
 * malformed, not a path the route should try to handle.
 */
export const GitHubCallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(CODE_MAX).optional(),
    error: z.string().min(1).max(ERROR_MAX).optional(),
    error_description: z.string().max(ERROR_DESC_MAX).optional(),
    state: z.string().min(1).max(STATE_MAX),
  })
  .strict()
  .refine((value) => Boolean(value.code) || Boolean(value.error), {
    message: 'Either `code` or `error` must be present.',
    path: ['code'],
  });
export type GitHubCallbackQueryT = z.infer<typeof GitHubCallbackQuerySchema>;

/**
 * DELETE /api/user/credentials body. Strict so we reject anything
 * we don't recognize — callers that pass `{ provider, scope: '...' }`
 * (for example) get a 400 instead of a silent partial delete.
 */
export const DeleteCredentialBodySchema = z
  .object({
    provider: CredentialProviderSchema,
  })
  .strict();
export type DeleteCredentialBodyT = z.infer<typeof DeleteCredentialBodySchema>;
