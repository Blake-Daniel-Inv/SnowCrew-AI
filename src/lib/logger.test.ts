import { describe, expect, it } from 'vitest';
import pino from 'pino';

/**
 * The logger module's exported singleton writes to stdout, which isn't
 * captureable inside vitest in a stable way. So these tests rebuild a
 * logger with the SAME configuration block, but pointed at a
 * write-to-buffer destination. The redact / child / level behavior is a
 * property of those options, not of the destination, so this proves the
 * production logger behaves the same way.
 *
 * Keep this config in lock-step with src/lib/logger.ts. The duplication
 * is intentional: drifting the test from prod is a louder failure mode
 * than the small maintenance cost.
 */
function buildTestLogger(opts: { level?: string } = {}): {
  logger: pino.Logger;
  read: () => Array<Record<string, unknown>>;
} {
  const lines: string[] = [];
  const destination: pino.DestinationStream = {
    write(chunk: string): void {
      // pino writes one JSON document per line. Tests parse line-by-line
      // because slow paths (rate-limit, batches) might emit > 1 per call.
      lines.push(chunk);
    },
  };
  const logger = pino(
    {
      level: opts.level || 'debug',
      base: { env: 'test', service: 'snowcrewai' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
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
        remove: false,
        censor: '[REDACTED]',
      },
    },
    destination
  );
  return {
    logger,
    read: () =>
      lines
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger redact', () => {
  it('censors password, token, Authorization, and Snowflake secret keys', () => {
    const { logger, read } = buildTestLogger();
    logger.info(
      {
        req: {
          password: 'plaintext-pw',
          token: 'gho_abc123',
          Authorization: 'Bearer secret-bearer',
          SNOWFLAKE_PAT: 'pat/abc',
        },
      },
      'redact check'
    );
    const entries = read();
    expect(entries).toHaveLength(1);
    const req = entries[0].req as Record<string, string>;
    expect(req.password).toBe('[REDACTED]');
    expect(req.token).toBe('[REDACTED]');
    expect(req.Authorization).toBe('[REDACTED]');
    expect(req.SNOWFLAKE_PAT).toBe('[REDACTED]');
    // The literal secret values must not appear anywhere in the rendered
    // output — guards against a future config change accidentally
    // demoting redaction to a shallow path.
    const rendered = JSON.stringify(entries[0]);
    expect(rendered).not.toContain('plaintext-pw');
    expect(rendered).not.toContain('gho_abc123');
    expect(rendered).not.toContain('secret-bearer');
    expect(rendered).not.toContain('pat/abc');
  });

  it('also censors lowercase authorization, passwordEnvVar, SNOWFLAKE_JWT, GITHUB_TOKEN', () => {
    const { logger, read } = buildTestLogger();
    logger.warn(
      {
        env: {
          authorization: 'Bearer lower',
          passwordEnvVar: 'SNOWFLAKE_PAT_TENANT_A',
          SNOWFLAKE_JWT: 'eyJ.jwt.value',
          GITHUB_TOKEN: 'gh-pat-xyz',
        },
      },
      'redact lowercase + env vars'
    );
    const env = read()[0].env as Record<string, string>;
    expect(env.authorization).toBe('[REDACTED]');
    expect(env.passwordEnvVar).toBe('[REDACTED]');
    expect(env.SNOWFLAKE_JWT).toBe('[REDACTED]');
    expect(env.GITHUB_TOKEN).toBe('[REDACTED]');
  });
});

describe('logger.child', () => {
  it('propagates ctx fields into every emitted log line', () => {
    const { logger, read } = buildTestLogger();
    const child = logger.child({ runId: 'r1', ownerId: 'u-7' });
    child.info('hello');
    child.warn({ extra: 'detail' }, 'world');
    const entries = read();
    expect(entries).toHaveLength(2);
    expect(entries[0].runId).toBe('r1');
    expect(entries[0].ownerId).toBe('u-7');
    expect(entries[0].msg).toBe('hello');
    expect(entries[1].runId).toBe('r1');
    expect(entries[1].ownerId).toBe('u-7');
    expect(entries[1].extra).toBe('detail');
    expect(entries[1].msg).toBe('world');
  });

  it('base fields (env, service) appear on every line', () => {
    const { logger, read } = buildTestLogger();
    logger.info('base check');
    const entry = read()[0];
    expect(entry.env).toBe('test');
    expect(entry.service).toBe('snowcrewai');
  });
});

describe('logger level filtering', () => {
  it('drops debug calls when level=info', () => {
    const { logger, read } = buildTestLogger({ level: 'info' });
    logger.debug('should be dropped');
    logger.info('should pass');
    const entries = read();
    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('should pass');
  });
});
