import pino from 'pino';

/**
 * Process-shared pino logger for the Next.js server runtime.
 *
 * Why pino:
 *   - Fast JSON output that downstream log shippers (Splunk, Datadog,
 *     SPCS log stream) can parse without a custom parser.
 *   - Worker-thread-free in the default sync mode, which keeps the
 *     bundling story simple — no transports, no `pino-pretty`.
 *
 * Usage hints:
 *   - Use `logger.child({ runId, ownerId })` at the start of long-lived
 *     operations so downstream logs auto-include context. The runner
 *     does this per-run; routes do it per-request.
 *   - Do NOT log raw tokens or credentials. The redact list catches the
 *     common keys (Authorization headers, password fields, SNOWFLAKE_PAT,
 *     SNOWFLAKE_JWT, GITHUB_TOKEN), but a NEW credential field added
 *     elsewhere needs an explicit entry here or the value will leak.
 *   - Pass structured fields as the FIRST argument and a short string
 *     as the second: `logger.error({ runId, err: error.message }, 'msg')`.
 *     Reversed argument order (string first, object second) makes the
 *     object render as `extra: {...}` instead of merging into the entry.
 *
 * Levels:
 *   - LOG_LEVEL env var overrides everything (one of fatal/error/warn/info/debug/trace).
 *   - Otherwise: `info` in production, `debug` in dev/test. The dev/test
 *     default keeps stack traces on warnings while production stays
 *     quiet enough to avoid log-storm costs.
 */

const LOG_LEVEL =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const baseOptions: pino.LoggerOptions = {
  level: LOG_LEVEL,
  base: {
    env: process.env.NODE_ENV,
    service: 'snowcrewai',
  },
  // ISO-8601 timestamps — easier to grep + merge across services than
  // pino's default millisecond epoch.
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // Glob-style paths that pino's fast-redact scrubs before serialisation.
    // The leading `*.` means "match this key anywhere at depth 1+", which
    // is enough for the structured fields we actually log (req headers,
    // env snapshots, error objects). Deeper nesting needs explicit paths.
    paths: [
      '*.password',
      '*.token',
      '*.Authorization',
      '*.authorization',
      '*.passwordEnvVar',
      '*.GITHUB_TOKEN',
      '*.SNOWFLAKE_JWT',
      '*.SNOWFLAKE_PAT',
    ],
    // `remove: false` keeps the key with the censor string so structure
    // is preserved (helps debugging "is the field there at all?"
    // questions). `censor: '[REDACTED]'` is conventional and string-typed
    // so JSON consumers don't have to special-case it.
    remove: false,
    censor: '[REDACTED]',
  },
};

export const logger: pino.Logger = pino(baseOptions);

/**
 * Build a child logger that auto-attaches `ctx` to every log line. Cheap
 * — pino child loggers share the parent's underlying destination, so
 * each call is essentially a metadata merge plus a level check.
 *
 * Typical use:
 *   const log = loggerWithContext({ route: '/api/runs/[id]/email' });
 *   log.error({ runId, status: 502 }, 'email send failed');
 */
export function loggerWithContext(ctx: Record<string, unknown>): pino.Logger {
  return logger.child(ctx);
}
