import { NextResponse } from 'next/server';
import { getRunsDb } from '@/lib/runs-db';
import { logger } from '@/lib/logger';

/**
 * GET /api/health/ready
 *
 * Readiness probe — answers "is this instance prepared to serve real
 * traffic?". The three things that have to be true for ready=200:
 *   1. SQLite is open + a `SELECT 1` round-trips inside the timeout.
 *   2. Required env vars for the deployment mode are present.
 *      - SPCS (NEXT_PUBLIC_CONTAINER_MODE === '1' or CONTAINER_MODE === '1'
 *        or DATA_DIR set): SNOWFLAKE_HOST is required.
 *      - Local: SNOWFLAKE_ACCOUNT_ID plus one of SNOWFLAKE_PAT or
 *        SNOWFLAKE_JWT must be set.
 *   3. CREDENTIALS_MASTER_KEY is set (per-PR-1, integrations are broken
 *      without it).
 *
 * On failure we return 503 with a structured `checks` block listing
 * which probe failed. The body never echoes env var VALUES — only the
 * NAMES of missing keys — so a public probe URL can't leak credential
 * material via the response.
 *
 * The middleware skip-list lets unauthenticated probes hit this even
 * before SPCS injects identity headers.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DB_CHECK_TIMEOUT_MS = 1_000;

/** Mirrors the container-mode detection in middleware.ts (kept in sync deliberately). */
function isContainerMode(): boolean {
  return (
    process.env.NEXT_PUBLIC_CONTAINER_MODE === '1' ||
    process.env.CONTAINER_MODE === '1' ||
    Boolean(process.env.DATA_DIR)
  );
}

type ReadyCheckResult = {
  db: 'ok' | 'failed';
  envVars: 'ok' | string;
  credentialsKey: 'ok' | 'missing';
};

/**
 * better-sqlite3 is synchronous, so wrapping the call in a manual
 * timeout requires running it inside a Promise.race with a sleep. The
 * SELECT 1 itself returns in microseconds; the timeout only fires if
 * better-sqlite3 itself hangs (e.g., the file system is wedged).
 */
async function checkDb(): Promise<'ok' | 'failed'> {
  return new Promise<'ok' | 'failed'>((resolve) => {
    const timer = setTimeout(() => resolve('failed'), DB_CHECK_TIMEOUT_MS);
    try {
      const db = getRunsDb();
      const row = db.prepare('SELECT 1 AS one').get() as { one: number } | undefined;
      clearTimeout(timer);
      resolve(row?.one === 1 ? 'ok' : 'failed');
    } catch (error) {
      clearTimeout(timer);
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'readiness: db check failed'
      );
      resolve('failed');
    }
  });
}

/**
 * Inspect the env. Returns 'ok' or a `missing:VAR1,VAR2` token listing
 * what's absent. Pure (no logging here so unit tests can call it).
 */
export function checkEnvVars(env: Record<string, string | undefined> = process.env): 'ok' | string {
  const missing: string[] = [];
  if (
    env.NEXT_PUBLIC_CONTAINER_MODE === '1' ||
    env.CONTAINER_MODE === '1' ||
    Boolean(env.DATA_DIR)
  ) {
    // SPCS mode: the runtime needs the internal Snowflake host so REST
    // calls can short-circuit External Access Integration.
    if (!env.SNOWFLAKE_HOST?.trim()) missing.push('SNOWFLAKE_HOST');
  } else {
    // Local mode: an account identifier plus SOME credential. We don't
    // require both PAT and JWT — either is sufficient.
    if (!env.SNOWFLAKE_ACCOUNT_ID?.trim()) missing.push('SNOWFLAKE_ACCOUNT_ID');
    if (!env.SNOWFLAKE_PAT?.trim() && !env.SNOWFLAKE_JWT?.trim()) {
      missing.push('SNOWFLAKE_PAT|SNOWFLAKE_JWT');
    }
  }
  return missing.length === 0 ? 'ok' : `missing:${missing.join(',')}`;
}

/** Master key is required for credentials feature (PR 1). */
export function checkCredentialsKey(
  env: Record<string, string | undefined> = process.env
): 'ok' | 'missing' {
  return env.CREDENTIALS_MASTER_KEY?.trim() ? 'ok' : 'missing';
}

export async function GET(): Promise<NextResponse> {
  const checks: ReadyCheckResult = {
    db: await checkDb(),
    envVars: checkEnvVars(),
    credentialsKey: checkCredentialsKey(),
  };

  const ok =
    checks.db === 'ok' &&
    checks.envVars === 'ok' &&
    checks.credentialsKey === 'ok';

  if (ok) {
    return NextResponse.json(
      {
        status: 'ok',
        service: 'snowcrewai',
        checks,
        mode: isContainerMode() ? 'spcs' : 'local',
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }

  // 503 keeps load balancers from routing traffic here while we boot or
  // reconfigure. We deliberately surface WHICH check failed so on-call
  // engineers don't have to crack open a shell to find out.
  return NextResponse.json(
    {
      status: 'not_ready',
      service: 'snowcrewai',
      checks,
      mode: isContainerMode() ? 'spcs' : 'local',
    },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
