import { z } from 'zod';

/**
 * Zod schemas for the schedules routes:
 *   - POST   /api/schedules
 *   - PATCH  /api/schedules/[id]
 *
 * `.strict()` everywhere so the API rejects rogue keys instead of
 * silently ignoring them — matches the rest of the codebase.
 *
 * Cron validity itself is NOT enforced here. We can't import the
 * cron-parser wrapper into a pure schema module without making the
 * schema file depend on Node-only code, which would break the future
 * "validate on the client" use case. The route does the parseCron
 * check after Zod parsing and returns a friendly 400 with
 * `invalid_cron` on failure.
 */

const NAME_MAX = 200;
const CRON_MAX = 100;
const TIMEZONE_MAX = 50;

/** POST /api/schedules */
export const CreateScheduleSchema = z
  .object({
    workspaceId: z.string().uuid(),
    crewId: z.string().min(1).max(NAME_MAX),
    name: z.string().min(1).max(NAME_MAX),
    cronExpr: z.string().min(1).max(CRON_MAX),
    timezone: z.string().max(TIMEZONE_MAX).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type CreateScheduleInputT = z.infer<typeof CreateScheduleSchema>;

/** PATCH /api/schedules/[id] — all fields optional. */
export const UpdateScheduleSchema = z
  .object({
    name: z.string().min(1).max(NAME_MAX).optional(),
    cronExpr: z.string().min(1).max(CRON_MAX).optional(),
    timezone: z.string().max(TIMEZONE_MAX).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  // Reject an empty PATCH body — every legit caller has at least one
  // field to update. An empty body is almost always a client bug.
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateScheduleInputT = z.infer<typeof UpdateScheduleSchema>;
