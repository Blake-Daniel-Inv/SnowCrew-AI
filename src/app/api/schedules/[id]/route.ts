import { NextResponse } from 'next/server';
import {
  ErrorCodes,
  NO_STORE_HEADERS,
  errorResponse,
  parseIdParam,
  requireCaller,
} from '@/lib/schemas/common';
import { UpdateScheduleSchema } from '@/lib/schemas/schedules';
import {
  deleteSchedule,
  getSchedule,
  updateSchedule,
} from '@/lib/schedules-db';
import { writeAuditEvent } from '@/lib/audit';
import { parseCron } from '@/lib/scheduler/cron';
import { toPublic } from '../route';

export const runtime = 'nodejs';

/**
 * GET /api/schedules/[id]
 *
 * Returns the public projection of a schedule owned by the caller.
 * Cross-owner ids surface as 404, never 403 — we never confirm the
 * existence of a row that belongs to someone else.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  const { id: rawId } = await ctx.params;
  const idCheck = parseIdParam(rawId);
  if (!idCheck.ok) return idCheck.response;

  const schedule = getSchedule(caller.user, idCheck.id);
  if (!schedule) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Schedule not found');
  }
  return NextResponse.json(toPublic(schedule), { headers: NO_STORE_HEADERS });
}

/**
 * PATCH /api/schedules/[id]
 *
 * Partial update. Same cron-validation contract as POST: if the
 * caller is changing the cron expr or timezone we re-parse the
 * resulting pair and reject with `invalid_cron` on failure. The DB
 * layer recomputes `next_fire_at` when relevant fields change so
 * the daemon's claim plan stays in sync.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  const { id: rawId } = await ctx.params;
  const idCheck = parseIdParam(rawId);
  if (!idCheck.ok) return idCheck.response;

  const raw = await request.json().catch(() => null);
  const parsed = UpdateScheduleSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }
  const body = parsed.data;

  // Cron validation when the firing logic could have changed. We use
  // the existing row's values as the fallback for whichever side of
  // the (cronExpr, timezone) pair wasn't supplied, so updating just
  // the timezone still validates the result.
  if (body.cronExpr != null || body.timezone != null) {
    const existing = getSchedule(caller.user, idCheck.id);
    if (!existing) {
      // The 404 here is the same as the bottom-of-function not-found.
      // Surfacing it here saves an extra DB round-trip.
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Schedule not found');
    }
    const cronExpr = body.cronExpr ?? existing.cronExpr;
    const timezone = body.timezone?.trim() || existing.timezone;
    const cronCheck = parseCron(cronExpr, timezone);
    if (!cronCheck.valid) {
      return errorResponse(
        400,
        'invalid_cron',
        cronCheck.error || 'Invalid cron expression'
      );
    }
  }

  const updated = updateSchedule(caller.user, idCheck.id, body);
  if (!updated) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Schedule not found');
  }
  writeAuditEvent({
    ownerId: caller.user,
    action: 'schedule.updated',
    targetType: 'schedule',
    targetId: updated.id,
    metadata: {
      workspaceId: updated.workspaceId,
      crewId: updated.crewId,
      cronExpr: updated.cronExpr,
    },
  });
  return NextResponse.json(toPublic(updated), { headers: NO_STORE_HEADERS });
}

/**
 * DELETE /api/schedules/[id]
 *
 * Owner-scoped delete. `{ deleted: true|false }` keeps the response
 * shape consistent with /api/user/credentials.
 */
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  const { id: rawId } = await ctx.params;
  const idCheck = parseIdParam(rawId);
  if (!idCheck.ok) return idCheck.response;

  const deleted = deleteSchedule(caller.user, idCheck.id);
  if (deleted) {
    writeAuditEvent({
      ownerId: caller.user,
      action: 'schedule.deleted',
      targetType: 'schedule',
      targetId: idCheck.id,
    });
  }
  return NextResponse.json({ deleted }, { headers: NO_STORE_HEADERS });
}
