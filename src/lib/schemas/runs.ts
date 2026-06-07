import { z } from 'zod';

/**
 * Zod schemas for the runs routes:
 *   - POST /api/runs              → StartRunBody
 *   - POST /api/runs/[id]/email   → EmailRunBody
 *
 * All schemas use `.strict()` so unknown keys are rejected.
 */

const SHORT = 200;
const MEDIUM = 2_000;
const RECIPIENTS_MAX = 50;

/** POST /api/runs */
export const StartRunBody = z
  .object({
    workspaceId: z.string().uuid(),
    crewId: z.string().min(1).max(SHORT),
    inputs: z.record(z.string(), z.string().max(MEDIUM)).optional(),
  })
  .strict();
export type StartRunBodyT = z.infer<typeof StartRunBody>;

/**
 * POST /api/runs/[id]/email
 *
 * `recipients` accepts either a single comma/newline-delimited string
 * or an array of strings — both forms have always been supported by the
 * route, so the schema keeps them and the route flattens.
 */
export const EmailRunBody = z
  .object({
    actionId: z.string().min(1).max(SHORT).optional(),
    connectionId: z.string().min(1).max(SHORT).optional(),
    recipients: z
      .union([
        z.string().max(MEDIUM),
        z.array(z.string().max(SHORT)).max(RECIPIENTS_MAX),
      ])
      .optional(),
    subject: z.string().max(SHORT).optional(),
  })
  .strict();
export type EmailRunBodyT = z.infer<typeof EmailRunBody>;
