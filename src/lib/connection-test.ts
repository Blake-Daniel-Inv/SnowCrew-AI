import {
  getSnowflakeAuth,
  snowflakeAuthHeaders,
  type SnowflakeAuth,
} from './snowflake-auth';
import { logger } from './logger';
import type { CrewStudioConnection, ConnectionTestResult } from '@/types';

/**
 * Try a single model against the Cortex inference endpoint, using the
 * resolved auth (SPCS session token in-cluster, PAT locally).
 */
async function callCortex(
  auth: SnowflakeAuth,
  model: string
): Promise<{ status: number; body: string }> {
  const url = `https://${auth.host}/api/v2/cortex/inference:complete`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: snowflakeAuthHeaders(auth),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
    const body = await response.text().catch(() => '');
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * End-to-end auth probe. We try a few candidate model IDs because
 * availability varies by account region / entitlements.
 *
 *  - 200 from any model  -> auth + Cortex + that model all work
 *  - 400 "unknown model" -> auth worked, just the model isn't enabled.
 *                           That still proves the credential is valid,
 *                           so we report success and tell the user
 *                           which model failed.
 *  - 401 / 403           -> real auth problems (token bad, role missing
 *                           Cortex grants, etc.)
 *
 * Cost: one max-1-token call. Fractions of a cent at most.
 */
async function probeCortexAuth(
  auth: SnowflakeAuth
): Promise<{ ok: boolean; status?: number; message: string }> {
  const candidates = [
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'mistral-large2',
  ];
  let lastUnknownModel: { model: string; body: string } | null = null;

  for (const model of candidates) {
    let result: { status: number; body: string };
    try {
      result = await callCortex(auth, model);
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error), errName: error instanceof Error ? error.name : 'unknown' }, 'connection-test probe error');
      return {
        ok: false,
        message: 'Cortex probe failed',
      };
    }

    if (result.status === 200) {
      return {
        ok: true,
        status: 200,
        message: `${authLabel(auth)} authenticates; model "${model}" is available.`,
      };
    }
    if (result.status === 401) {
      return {
        ok: false,
        status: 401,
        message: `${authLabel(auth)} was rejected (401). Token may be expired, revoked, or for a different account.`,
      };
    }
    if (result.status === 403) {
      return {
        ok: false,
        status: 403,
        message: "Authenticated, but role lacks Cortex access (403). Grant SNOWFLAKE.CORTEX_USER to the calling role.",
      };
    }
    if (result.status === 404) {
      return {
        ok: false,
        status: 404,
        message: 'Cortex endpoint returned 404. Check account identifier or that Cortex is enabled in your region.',
      };
    }
    if (result.status === 400 && /unknown model/i.test(result.body)) {
      lastUnknownModel = { model, body: result.body };
      continue;
    }
    logger.error(
      { status: result.status, body: result.body?.slice(0, 2000) },
      'connection-test unexpected status'
    );
    return {
      ok: false,
      status: result.status,
      message: `Unexpected response status ${result.status}`,
    };
  }

  if (lastUnknownModel) {
    return {
      ok: true,
      status: 400,
      message:
        `${authLabel(auth)} authenticates, but none of the test models are enabled in this region. ` +
        `Run SELECT SYSTEM$GET_CORTEX_AVAILABLE_MODELS() in Snowflake to see what's available, ` +
        `then update the agent's LLM dropdown.`,
    };
  }

  return { ok: false, message: 'Cortex probe exhausted candidate models without a definitive result.' };
}

function authLabel(auth: SnowflakeAuth): string {
  if (auth.source === 'spcs-session') return 'SPCS session token';
  if (auth.tokenType === 'PROGRAMMATIC_ACCESS_TOKEN') return 'PAT';
  return 'Snowflake JWT';
}

async function testSnowflakeApi(conn: CrewStudioConnection): Promise<ConnectionTestResult> {
  const details: string[] = [];
  const started = Date.now();

  if (!conn.account.trim()) {
    return { ok: false, latencyMs: 0, message: 'Missing account identifier', details };
  }
  if (!conn.user.trim()) {
    return { ok: false, latencyMs: 0, message: 'Missing user', details };
  }

  const auth = getSnowflakeAuth({
    fallbackAccount: conn.account,
    fallbackEnvVar: conn.passwordEnvVar.trim() || 'SNOWFLAKE_PAT',
  });
  if (!auth) {
    return {
      ok: false,
      latencyMs: 0,
      message:
        'No Snowflake credentials available. In SPCS the session token mount is missing; locally set SNOWFLAKE_PAT (or SNOWFLAKE_JWT) and SNOWFLAKE_ACCOUNT_ID.',
      details,
    };
  }

  details.push(
    auth.source === 'spcs-session'
      ? `Using SPCS session token (host: ${auth.host})`
      : `Using ${authLabel(auth)} from env (host: ${auth.host})`
  );

  if (!conn.warehouse) details.push('Warehouse not specified — required for SQL queries');
  if (!conn.database) details.push('Database not specified');

  const probe = await probeCortexAuth(auth);
  details.push(probe.message);

  return {
    ok: probe.ok,
    latencyMs: Date.now() - started,
    message: probe.ok ? `${authLabel(auth)} authenticates with Cortex` : probe.message,
    details,
  };
}

export async function testConnection(conn: CrewStudioConnection): Promise<ConnectionTestResult> {
  if (!conn.enabled) {
    return { ok: false, latencyMs: 0, message: 'Connection is disabled' };
  }
  return testSnowflakeApi(conn);
}
