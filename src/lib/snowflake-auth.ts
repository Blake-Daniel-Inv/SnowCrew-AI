import fs from 'fs';
import { logger } from './logger';

export type SnowflakeTokenType =
  | 'OAUTH'
  | 'PROGRAMMATIC_ACCESS_TOKEN'
  | 'KEYPAIR_JWT';

export type SnowflakeAuthSource = 'spcs-session' | 'pat-env' | 'jwt-env';

export interface SnowflakeAuth {
  /** Bearer token to send in the Authorization header. */
  token: string;
  /** Value for X-Snowflake-Authorization-Token-Type. */
  tokenType: SnowflakeTokenType;
  /**
   * Host to call. In SPCS this is the internal hostname injected via
   * SNOWFLAKE_HOST and stays inside Snowflake's network (no External
   * Access Integration required). Locally it's `<account>.snowflakecomputing.com`.
   */
  host: string;
  /** How we resolved the credential — useful for /api/me + diagnostics. */
  source: SnowflakeAuthSource;
}

/**
 * SPCS auto-mounts a session token at this path. The token is for the
 * service-owner role and is rotated by SPCS roughly every hour. Reading
 * it on each call is cheap; we cache for 60s to avoid hammering the FS.
 */
const SPCS_TOKEN_PATH = '/snowflake/session/token';

/**
 * Cached SPCS resolution only. The SPCS session token is process-global
 * by design (one container, one service identity), so caching it across
 * callers is safe. Env-based auth, by contrast, varies per caller
 * (`opts.fallbackEnvVar` / `opts.fallbackAccount`) and MUST NOT be
 * cached here — `process.env[key]` reads are cheap enough that the cache
 * isn't worth the cross-tenant credential bleed risk.
 */
let spcsCached: { auth: SnowflakeAuth; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export interface SnowflakeAuthOptions {
  /** Fallback account id (e.g. from a connection node) when env is unset. */
  fallbackAccount?: string;
  /** Fallback PAT env var name (e.g. 'SNOWFLAKE_PAT'); applies in local mode only. */
  fallbackEnvVar?: string;
}

/**
 * Resolve Snowflake credentials + the right hostname to call.
 *
 * Order of preference:
 *   1. SPCS session token at /snowflake/session/token + SNOWFLAKE_HOST env
 *   2. Local PAT in env (SNOWFLAKE_PAT or the caller-specified env var)
 *   3. Local keypair JWT in SNOWFLAKE_JWT
 *
 * Returns null if nothing is available — callers should surface a
 * helpful error to the UI rather than throwing here.
 */
export function getSnowflakeAuth(opts?: SnowflakeAuthOptions): SnowflakeAuth | null {
  const now = Date.now();

  // SPCS path: process-global, safe to cache.
  if (spcsCached && now < spcsCached.expiresAt) return spcsCached.auth;
  const spcs = readSpcsAuth();
  if (spcs) {
    spcsCached = { auth: spcs, expiresAt: now + CACHE_TTL_MS };
    return spcs;
  }
  spcsCached = null;

  // Env path: per-caller, never cached so a request with
  // `fallbackEnvVar=SNOWFLAKE_PAT_TENANT_A` cannot receive a previously
  // cached entry resolved against a different tenant's env var.
  return readEnvAuth(opts);
}

function readSpcsAuth(): SnowflakeAuth | null {
  // Single read in try/catch (no existsSync → readFileSync race). On
  // ENOENT we silently return null (running outside SPCS is normal). On
  // EACCES we surface a server-side warning so a misconfigured volume
  // mount doesn't look like "not in SPCS". The token bytes are never
  // logged regardless of which branch we take.
  let token: string;
  try {
    token = fs.readFileSync(SPCS_TOKEN_PATH, 'utf-8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    if (code === 'EACCES' || code === 'EPERM') {
      logger.warn(
        { tokenPath: SPCS_TOKEN_PATH, code },
        'SPCS token path not readable; check service spec mount permissions'
      );
      return null;
    }
    return null;
  }
  if (!token) return null;
  const host = process.env.SNOWFLAKE_HOST?.trim();
  if (!host) return null;
  return { token, tokenType: 'OAUTH', host, source: 'spcs-session' };
}

// Snowflake account locator: <org>-<account>, optionally followed by
// .<region>.<cloud> segments. Strict allowlist defends against URL
// injection where a hostile `account` like `evil.com/path` would
// otherwise resolve to an attacker-controlled host carrying the
// Authorization: Bearer header on outbound fetch.
const ACCOUNT_RE = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:\.[A-Za-z0-9-]+){0,3}$/;

function normalizeAccountToHost(raw: string): string | null {
  const account = raw
    .replace(/^https?:\/\//, '')
    .replace(/\.snowflakecomputing\.com.*$/i, '')
    .replace(/\/+$/, '')
    .trim();
  if (!ACCOUNT_RE.test(account)) return null;
  return `${account}.snowflakecomputing.com`;
}

function readEnvAuth(opts?: SnowflakeAuthOptions): SnowflakeAuth | null {
  const envVar = opts?.fallbackEnvVar?.trim() || 'SNOWFLAKE_PAT';
  const rawPat = process.env[envVar]?.trim();
  const rawJwt = process.env.SNOWFLAKE_JWT?.trim();

  let token: string | null = null;
  let tokenType: SnowflakeTokenType = 'PROGRAMMATIC_ACCESS_TOKEN';
  let source: SnowflakeAuthSource = 'pat-env';

  if (rawPat) {
    token = rawPat.startsWith('pat/') ? rawPat.slice(4) : rawPat;
    tokenType = 'PROGRAMMATIC_ACCESS_TOKEN';
    source = 'pat-env';
  } else if (rawJwt) {
    // Heuristic: if SNOWFLAKE_JWT is prefixed with pat/ it's actually a
    // PAT; otherwise treat as keypair JWT.
    if (rawJwt.startsWith('pat/')) {
      token = rawJwt.slice(4);
      tokenType = 'PROGRAMMATIC_ACCESS_TOKEN';
      source = 'jwt-env';
    } else {
      token = rawJwt;
      tokenType = 'KEYPAIR_JWT';
      source = 'jwt-env';
    }
  }

  if (!token) return null;

  const accountRaw = (opts?.fallbackAccount || process.env.SNOWFLAKE_ACCOUNT_ID || '').trim();
  if (!accountRaw) return null;
  const host = normalizeAccountToHost(accountRaw);
  if (!host) return null;

  return { token, tokenType, host, source };
}

/**
 * Build the standard auth + content-type headers for Snowflake REST API
 * calls (Cortex inference, statements, etc).
 */
export function snowflakeAuthHeaders(auth: SnowflakeAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    'X-Snowflake-Authorization-Token-Type': auth.tokenType,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Convert auth into the SNOWFLAKE_JWT env var value LiteLLM (used by
 * the Python crew runner) expects:
 *   - PAT → must be prefixed with "pat/"
 *   - Keypair JWT → raw, no prefix
 *   - OAuth → returns null. SPCS-session OAuth tokens are bound to a
 *     specific Snowflake session/audience and must NOT be forwarded as
 *     `SNOWFLAKE_JWT` — LiteLLM/snowpark expect a keypair-signed JWT or
 *     a PAT on that env var, and passing an OAuth token there is a
 *     credential-confusion bug. Callers should fall back to a separate
 *     PAT/JWT env (or skip LiteLLM auth) when this returns null.
 */
export function resolveLiteLlmJwt(auth: SnowflakeAuth): string | null {
  if (auth.tokenType === 'OAUTH') return null;
  if (auth.tokenType === 'PROGRAMMATIC_ACCESS_TOKEN') {
    return auth.token.startsWith('pat/') ? auth.token : `pat/${auth.token}`;
  }
  return auth.token;
}

/**
 * Best-effort account identifier for downstream tools that need the
 * account name (not the host). In SPCS this is provided directly via
 * SNOWFLAKE_ACCOUNT; locally we strip it off the host or fall back to
 * SNOWFLAKE_ACCOUNT_ID.
 */
export function getSnowflakeAccount(opts?: SnowflakeAuthOptions): string {
  const fromEnv = process.env.SNOWFLAKE_ACCOUNT?.trim();
  if (fromEnv) return fromEnv;
  const fromIdEnv = process.env.SNOWFLAKE_ACCOUNT_ID?.trim();
  if (fromIdEnv) return fromIdEnv;
  if (opts?.fallbackAccount) return opts.fallbackAccount.trim();
  return '';
}

/** Force a re-read on next call. Mainly useful for tests / token rotation hints. */
export function clearSnowflakeAuthCache(): void {
  spcsCached = null;
}
