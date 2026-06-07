import { z } from 'zod';

/**
 * Zod schemas for /api/connections/test.
 *
 * The route receives a full CrewStudioConnection blob from the studio
 * UI and forwards it to the connection-test helper. We validate the
 * shape strictly so a malformed payload can't reach the Snowflake
 * round-trip.
 */

// Caps imported from the shared field-limits module so the UI hints
// stay in lock-step with the Zod schema. See field-limits.ts.
import { FIELD_LIMITS } from './field-limits';
const { SHORT, MEDIUM, LONG, ARR, RECIPIENTS_MAX } = FIELD_LIMITS;

const ConnectionSchema = z
  .object({
    id: z.string().min(1).max(SHORT),
    name: z.string().max(SHORT),
    description: z.string().max(MEDIUM),
    mode: z.literal('snowflake-api'),
    enabled: z.boolean(),
    isDefault: z.boolean(),
    // Snowflake account locator allowlist defends against URL injection
    // (`account: "evil.com/path"` would otherwise resolve to an
    // attacker-controlled host carrying the Authorization: Bearer header).
    account: z
      .string()
      .max(SHORT)
      .regex(
        /^$|^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:\.[A-Za-z0-9-]+){0,3}$/,
        'invalid Snowflake account locator'
      ),
    user: z.string().max(SHORT),
    // Restrict to env vars beginning with `SNOWFLAKE_` so a malicious
    // client can't enumerate / exfiltrate unrelated process env vars
    // (PATH, AWS_SECRET_ACCESS_KEY, etc.) by setting this to an
    // arbitrary name and observing downstream behavior. Kept as a
    // string (not a closed enum) to preserve compatibility with
    // existing workspaces that already persist this field.
    passwordEnvVar: z
      .string()
      .max(SHORT)
      .regex(/^SNOWFLAKE_[A-Z0-9_]+$/, 'must start with SNOWFLAKE_')
      .or(z.literal('')),
    warehouse: z.string().max(SHORT),
    database: z.string().max(SHORT),
    schema: z.string().max(SHORT),
    role: z.string().max(SHORT),
    queryGuide: z.string().max(LONG),
    toolName: z.string().max(SHORT),
    allowedTools: z.array(z.string().max(SHORT)).max(ARR),
    emailNotificationIntegration: z.string().max(SHORT),
    emailDefaultRecipients: z
      .array(z.string().max(SHORT))
      .max(RECIPIENTS_MAX),
    notes: z.string().max(LONG),
  })
  .strict();

export const TestConnectionBody = z
  .object({
    connection: ConnectionSchema,
  })
  .strict();
export type TestConnectionBodyT = z.infer<typeof TestConnectionBody>;
