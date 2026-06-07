import { z } from 'zod';

/**
 * Zod schema for POST /api/models/cortex.
 *
 * The route takes a connection blob and probes Cortex for available
 * models. Same connection shape as /api/connections/test.
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
    account: z
      .string()
      .max(SHORT)
      .regex(
        /^$|^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:\.[A-Za-z0-9-]+){0,3}$/,
        'invalid Snowflake account locator'
      ),
    user: z.string().max(SHORT),
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

export const CortexModelsBody = z
  .object({
    connection: ConnectionSchema,
  })
  .strict();
export type CortexModelsBodyT = z.infer<typeof CortexModelsBody>;
