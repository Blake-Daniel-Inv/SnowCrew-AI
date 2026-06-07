import { NextResponse } from 'next/server';
import { getCrewStudioWorkspace } from '@/lib/crew-studio-store';
import {
  ErrorCodes,
  IdParam,
  NO_STORE_HEADERS,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import { CreateScheduleSchema } from '@/lib/schemas/schedules';
import {
  createSchedule,
  listSchedules,
} from '@/lib/schedules-db';
import { writeAuditEvent } from '@/lib/audit';
import { humanizeCron, parseCron } from '@/lib/scheduler/cron';
import type { Schedule, SchedulePublic } from '@/types';

export const runtime = 'nodejs';

/**
 * Convert the storage Schedule into the public-facing shape consumed
 * by the UI:
 *   - numeric timestamps → ISO strings (null preserved);
 *   - drop `ownerId` and `running` (server-internal);
 *   - add a `humanizedCron` hint so the panel can render
 *     "Every day at 9 AM" without each client re-parsing cron.
 */
function toPublic(schedule: Schedule): SchedulePublic {
  return {
    id: schedule.id,
    workspaceId: schedule.workspaceId,
    crewId: schedule.crewId,
    name: schedule.name,
    cronExpr: schedule.cronExpr,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    nextFireAt: schedule.nextFireAt
      ? new Date(schedule.nextFireAt).toISOString()
      : null,
    lastFiredAt: schedule.lastFiredAt
      ? new Date(schedule.lastFiredAt).toISOString()
      : null,
    lastRunId: schedule.lastRunId,
    humanizedCron: humanizeCron(schedule.cronExpr),
    createdAt: new Date(schedule.createdAt).toISOString(),
    updatedAt: new Date(schedule.updatedAt).toISOString(),
  };
}

/**
 * GET /api/schedules?workspaceId=<uuid>
 *
 * Lists schedules owned by the caller. Optional `workspaceId` narrows
 * the scope; passing an invalid UUID returns 400 instead of silently
 * dropping the filter.
 */
export async function GET(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  const { searchParams } = new URL(request.url);
  const rawWorkspaceId = searchParams.get('workspaceId');
  let workspaceId: string | undefined;
  if (rawWorkspaceId) {
    const parsed = IdParam.safeParse(rawWorkspaceId);
    if (!parsed.success) {
      return errorResponse(400, ErrorCodes.INVALID_ID, 'Invalid workspaceId');
    }
    workspaceId = parsed.data;
  }

  const schedules = listSchedules(caller.user, workspaceId).map(toPublic);
  return NextResponse.json({ schedules }, { headers: NO_STORE_HEADERS });
}

/**
 * POST /api/schedules
 *
 * Create a new schedule. Validates body shape via Zod, confirms the
 * referenced workspace+crew exist and belong to the caller, then
 * parses the cron expression. A bad cron returns 400 with
 * `invalid_cron` so the client can show the message inline.
 */
export async function POST(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;

  const raw = await request.json().catch(() => null);
  const parsed = CreateScheduleSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }
  const body = parsed.data;

  // Resolve workspace + crew under the caller's ownership before any
  // DB writes. Cross-owner refs surface as 404 so we never leak the
  // existence of someone else's workspace.
  const workspace = getCrewStudioWorkspace(body.workspaceId, caller.user);
  if (!workspace) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found');
  }
  const crew = workspace.crews.find((c) => c.id === body.crewId);
  if (!crew) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Crew not found in workspace');
  }

  const timezone = body.timezone?.trim() || 'UTC';
  const cronCheck = parseCron(body.cronExpr, timezone);
  if (!cronCheck.valid) {
    return errorResponse(
      400,
      'invalid_cron',
      cronCheck.error || 'Invalid cron expression'
    );
  }

  const created = createSchedule({
    ownerId: caller.user,
    workspaceId: body.workspaceId,
    crewId: body.crewId,
    name: body.name,
    cronExpr: body.cronExpr,
    timezone,
    enabled: body.enabled,
  });
  writeAuditEvent({
    ownerId: caller.user,
    action: 'schedule.created',
    targetType: 'schedule',
    targetId: created.id,
    metadata: {
      workspaceId: created.workspaceId,
      crewId: created.crewId,
      cronExpr: created.cronExpr,
    },
  });
  return NextResponse.json(toPublic(created), {
    status: 201,
    headers: { Location: `/api/schedules/${created.id}` },
  });
}

// Exported so the per-id route can render its own GET/PATCH response
// using the exact same projection — keeps client expectations stable
// across collection vs item endpoints.
export { toPublic };
