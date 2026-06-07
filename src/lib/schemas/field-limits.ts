/**
 * Single source of truth for field caps and validation patterns shared
 * between Zod schemas (server-side authoritative gate) and the
 * NodeConfigPanel UI (client-side hints).
 *
 * Centralizing these constants prevents drift: a schema cap of 2,000
 * with a UI counter capped at 1,000 would let the user type past the
 * "ok" zone only to see a server-side rejection on save. Importing
 * `FIELD_LIMITS` everywhere keeps the two in lock-step.
 *
 * PR 16 audit found these values declared three times — in
 * `workspaces.ts`, `connections.ts`, and `models.ts` — with identical
 * values. We're consolidating without changing any cap; if a future PR
 * needs to bump a cap, it now happens here and everyone follows.
 */
export const FIELD_LIMITS = {
  /** Single-line / identifier-sized strings (names, env-var names, role). */
  SHORT: 200,
  /** Mid-length prose (descriptions, agent role/goal). */
  MEDIUM: 2_000,
  /** Long-form prose (backstory, query guide, notes, task description). */
  LONG: 20_000,
  /** Assistant prompt body — the only field that may legitimately
   *  exceed LONG (a chat history can grow before being summarized). */
  PROMPT_MAX: 50_000,
  /** Array cap shared across every list field (tags, tools, etc.). */
  ARR: 200,
  /** Email recipients cap — separate from ARR because mailing-list
   *  blasts have their own reasonable upper bound. */
  RECIPIENTS_MAX: 50,
} as const;

export type FieldLimitKey = keyof typeof FIELD_LIMITS;

/**
 * Validated regex patterns + human-readable hints. The regex values
 * here MUST stay aligned with the ones embedded in the Zod schemas —
 * test coverage in `field-limits.test.ts` asserts that the example
 * strings in `help` actually match the regex, so drift is caught.
 *
 * Note: the schemas use `/^$|^…$/` (allow empty as an explicit
 * "leave default" signal). We mirror that here so the UI hint behaves
 * the same as save-time validation: blank is always allowed.
 */
export const FIELD_PATTERNS = {
  snowflakeAccount: {
    regex: /^$|^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:\.[A-Za-z0-9-]+){0,3}$/,
    help:
      'Letters, digits, hyphens (e.g. acme-prod or acme.us-east-1.aws). ' +
      'Leave blank to use environment default.',
    examples: ['acme-prod', 'acme.us-east-1.aws', ''],
  },
  passwordEnvVar: {
    regex: /^$|^SNOWFLAKE_[A-Z0-9_]+$/,
    help:
      'Must start with SNOWFLAKE_ and use only A-Z, 0-9, _ ' +
      '(e.g. SNOWFLAKE_PAT_PROD).',
    examples: ['SNOWFLAKE_PAT', 'SNOWFLAKE_PAT_PROD', ''],
  },
} as const;

export type FieldPatternKey = keyof typeof FIELD_PATTERNS;

/**
 * System ceilings for sub-crew invocations (PR 20). Centralized here so
 * the Zod schema, the Python tool template (read via env contract), and
 * any future UI counter cannot drift.
 *
 *   MAX_INVOCATIONS_PER_BOX — hard cap on the `maxInvocations` field
 *     per SubCrewInvocation. The Python `SubCrewTool` enforces the
 *     per-instance budget at call time; this cap simply prevents the
 *     UI/API from accepting absurd numbers.
 *
 *   DEFAULT_INVOCATIONS — value the normalizer fills in when the
 *     field is missing or out-of-range. Three is enough for a typical
 *     "first try → critique → retry" loop without inviting runaway.
 *
 *   MAX_NESTING_DEPTH — depth at which the Python tool refuses to
 *     fire. Tracked via the `SUBCREW_NESTING_DEPTH` env var (each
 *     sub-crew kickoff increments it). Five matches the depth a
 *     Coordinator can realistically supervise; deeper is almost always
 *     an accidental loop.
 */
export const SUBCREW_LIMITS = {
  MAX_INVOCATIONS_PER_BOX: 10,
  DEFAULT_INVOCATIONS: 3,
  MAX_NESTING_DEPTH: 5,
} as const;

export type SubcrewLimitKey = keyof typeof SUBCREW_LIMITS;
