import { logger } from './logger';
import type {
  CrewRun,
  CrewStudioAction,
  CrewStudioConnection,
  CrewStudioEmailBodyMode,
  CrewStudioWorkspace,
} from '@/types';
import { extractCleanRunOutput, markdownToSafeHtml, sanitizeHtml, stripAnsi } from './run-output';
import {
  getSnowflakeAuth,
  snowflakeAuthHeaders,
  type SnowflakeAuth,
} from './snowflake-auth';

function compactRecipients(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(/[,\n]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function emailHtml(markdown: string): string {
  return `<!doctype html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;line-height:1.55;">
${markdownToSafeHtml(markdown)}
</body>
</html>`;
}

function rawEmailHtml(html: string): string {
  const stripped = stripAnsi(html || '').trim();
  // No <html>/<body> early-return: the wrapper-stripping check used to
  // hand attacker-controlled markup straight to the mail client. We
  // always run the same allowlist regardless of caller-supplied wrapper.
  const safeBody = sanitizeHtml(stripped);
  return `<!doctype html>
<html>
<body>
${safeBody}
</body>
</html>`;
}

function renderEmailBody(content: string, bodyMode: CrewStudioEmailBodyMode): string {
  return bodyMode === 'raw-html' ? rawEmailHtml(content) : emailHtml(content);
}

type SnowflakeStatementBody = {
  statementHandle?: string;
  data?: unknown;
  code?: string;
  message?: string;
};

type SnowflakeStatementResult = {
  status: number;
  bodyText: string;
  body: SnowflakeStatementBody | null;
};

async function readStatementResult(response: Response): Promise<SnowflakeStatementResult> {
  const bodyText = await response.text().catch(() => '');
  let body: SnowflakeStatementBody | null = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as SnowflakeStatementBody;
    } catch {
      body = null;
    }
  }
  return { status: response.status, bodyText, body };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStatementStatus(
  auth: SnowflakeAuth,
  statementHandle: string
): Promise<SnowflakeStatementResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(
      `https://${auth.host}/api/v2/statements/${encodeURIComponent(statementHandle)}`,
      {
        method: 'GET',
        signal: controller.signal,
        headers: snowflakeAuthHeaders(auth),
      }
    );
    return readStatementResult(response);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForStatementResult(
  auth: SnowflakeAuth,
  initial: SnowflakeStatementResult
): Promise<SnowflakeStatementResult> {
  let current = initial;
  let lastTransportError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (current.status !== 202) return current;
    const handle = current.body?.statementHandle;
    if (!handle) return current;
    await delay(Math.min(500 + attempt * 250, 2_000));
    try {
      current = await fetchStatementStatus(auth, handle);
      lastTransportError = null;
    } catch (error) {
      lastTransportError = error;
      // Keep current.status === 202 so the loop retries within the budget.
    }
  }
  if (current.status === 202) {
    if (lastTransportError) {
      logger.error({ err: lastTransportError instanceof Error ? lastTransportError.message : String(lastTransportError), errName: lastTransportError instanceof Error ? lastTransportError.name : 'unknown' }, 'snowflake-email poll error');
    }
    const reason =
      lastTransportError instanceof Error && lastTransportError.name === 'AbortError'
        ? 'Snowflake statement status poll timed out.'
        : lastTransportError
          ? 'Email delivery failed (upstream poll error)'
          : 'Snowflake statement status poll exhausted retries before completion.';
    return {
      status: 504,
      bodyText: reason,
      body: { message: reason },
    };
  }
  return current;
}

function firstResultCell(data: unknown): string | null {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const value = data[0][0];
  return value == null ? null : String(value);
}

function resultDetails(result: SnowflakeStatementResult): { status: number; reason: string } {
  // Log full body server-side for debugging; do NOT return it to the client.
  // Body is bounded server-side. We intentionally do NOT redact the
  // body preview — Snowflake's email API returns operator-facing error
  // text (integration name, recipient validation), never secrets.
  logger.error(
    { status: result.status, bodyText: result.bodyText?.slice(0, 2000) },
    'snowflake-email non-2xx response'
  );
  return {
    status: result.status,
    reason: result.status === 504 ? 'timeout' : 'upstream-error',
  };
}

export interface SendRunEmailInput {
  connection: CrewStudioConnection;
  recipients: string[];
  subject: string;
  content: string;
  bodyMode?: CrewStudioEmailBodyMode;
}

export interface SendRunEmailResult {
  ok: boolean;
  message: string;
  details?: string[] | { status: number; reason: string };
}

export interface SendRunActionEmailInput {
  workspace: CrewStudioWorkspace;
  run: CrewRun;
  action?: CrewStudioAction | null;
  connectionId?: string;
  recipients?: string[];
  subject?: string;
}

function resolveEmailConnection(
  workspace: CrewStudioWorkspace,
  action?: CrewStudioAction | null,
  connectionId?: string
): CrewStudioConnection | null {
  return (
    workspace.connections.find((conn) => conn.id === (connectionId || action?.connectionId || '') && conn.enabled && conn.mode === 'snowflake-api') ||
    workspace.connections.find((conn) => conn.enabled && conn.mode === 'snowflake-api' && conn.isDefault) ||
    workspace.connections.find((conn) => conn.enabled && conn.mode === 'snowflake-api') ||
    null
  );
}

export async function sendRunActionEmail({
  workspace,
  run,
  action,
  connectionId,
  recipients = [],
  subject,
}: SendRunActionEmailInput): Promise<SendRunEmailResult> {
  const connection = resolveEmailConnection(workspace, action, connectionId);
  if (!connection) {
    return {
      ok: false,
      message: 'No enabled Snowflake API connection is available for email delivery.',
    };
  }

  const finalOutput = extractCleanRunOutput(run.output);
  if (!finalOutput) {
    return { ok: false, message: 'No clean result output is available to email.' };
  }

  return sendRunResultEmail({
    connection,
    recipients: recipients.length > 0 ? recipients : action?.recipients.length ? action.recipients : connection.emailDefaultRecipients,
    subject:
      subject?.trim() ||
      action?.subject.trim() ||
      `${run.crewName} result - ${new Date(run.startedAt).toLocaleString()}`,
    content: finalOutput,
    bodyMode: action?.emailBodyMode || 'clean',
  });
}

export async function sendRunResultEmail({
  connection,
  recipients,
  subject,
  content,
  bodyMode = 'clean',
}: SendRunEmailInput): Promise<SendRunEmailResult> {
  const integration =
    connection.emailNotificationIntegration.trim() ||
    process.env.SNOWFLAKE_EMAIL_INTEGRATION?.trim() ||
    '';
  if (!integration) {
    return {
      ok: false,
      message: 'Missing Snowflake email notification integration on the connection.',
      details: [
        'Create an email notification integration in Snowflake, then add its name to the Snowflake API connection.',
      ],
    };
  }

  const normalizedRecipients = compactRecipients(recipients);
  if (normalizedRecipients.length === 0) {
    return {
      ok: false,
      message: 'Add at least one verified Snowflake user email recipient.',
    };
  }

  if (!connection.account.trim()) {
    return { ok: false, message: 'Connection is missing a Snowflake account identifier.' };
  }

  const auth = getSnowflakeAuth({
    fallbackAccount: connection.account,
    fallbackEnvVar: connection.passwordEnvVar.trim() || 'SNOWFLAKE_PAT',
  });
  if (!auth) {
    return {
      ok: false,
      message:
        'No Snowflake credentials available. In SPCS the session token mount is missing; locally set SNOWFLAKE_PAT (or SNOWFLAKE_JWT).',
    };
  }

  const renderedBody = renderEmailBody(content, bodyMode);
  const subjectText = subject || 'CrewAI Studio run result';
  const recipientsText = normalizedRecipients.join(', ');

  const statement = 'CALL SYSTEM$SEND_EMAIL(?, ?, ?, ?, ?)';
  const bindings = {
    '1': { type: 'TEXT', value: integration },
    '2': { type: 'TEXT', value: recipientsText },
    '3': { type: 'TEXT', value: subjectText },
    '4': { type: 'TEXT', value: renderedBody },
    '5': { type: 'TEXT', value: 'text/html' },
  } as const;

  const requestBody: Record<string, unknown> = {
    statement,
    bindings,
    timeout: 60,
  };
  if (connection.warehouse.trim()) requestBody.warehouse = connection.warehouse.trim();
  if (connection.database.trim()) requestBody.database = connection.database.trim();
  if (connection.schema.trim()) requestBody.schema = connection.schema.trim();
  if (connection.role.trim()) requestBody.role = connection.role.trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`https://${auth.host}/api/v2/statements`, {
      method: 'POST',
      signal: controller.signal,
      headers: snowflakeAuthHeaders(auth),
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, message: 'Snowflake statement request timed out' };
    }
    logger.error({ err: error instanceof Error ? error.message : String(error), errName: error instanceof Error ? error.name : 'unknown' }, 'snowflake-email statement request error');
    return {
      ok: false,
      message: 'Email delivery failed (upstream poll error)',
    };
  } finally {
    clearTimeout(timer);
  }

  const initialResult = await readStatementResult(response);
  const result = await waitForStatementResult(auth, initialResult);
  if (result.status === 202) {
    return {
      ok: false,
      message: 'Snowflake email statement did not finish before verification timed out.',
      details: resultDetails(result),
    };
  }

  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      message: `Snowflake email call failed with HTTP ${result.status}.`,
      details: resultDetails(result),
    };
  }

  const sendResult = firstResultCell(result.body?.data);
  if (sendResult && sendResult.trim().toLowerCase() === 'false') {
    return {
      ok: false,
      message: 'Snowflake reported that SYSTEM$SEND_EMAIL returned false.',
      details: resultDetails(result),
    };
  }

  return {
    ok: true,
    message: `Sent result email to ${normalizedRecipients.join(', ')}.`,
    details: resultDetails(result),
  };
}
