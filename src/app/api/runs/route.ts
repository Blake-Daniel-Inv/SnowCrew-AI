import { NextResponse } from 'next/server';
import { crewRunner } from '@/lib/crew-runner';
import { getCrewStudioWorkspace } from '@/lib/crew-studio-store';
import {
  ErrorCodes,
  IdParam,
  NO_STORE_HEADERS,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import { StartRunBody } from '@/lib/schemas/runs';

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/runs' });

export const runtime = 'nodejs';

/**
 * GET /api/runs?workspaceId=<uuid>
 *
 * Lists run summaries owned by the caller, optionally scoped to a single
 * workspace. The runner enforces owner isolation; we just pass through
 * the caller identity from middleware.
 */
export async function GET(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get('workspaceId') || '';
  if (!workspaceId) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'workspaceId query parameter is required'
    );
  }
  const idCheck = IdParam.safeParse(workspaceId);
  if (!idCheck.success) {
    return errorResponse(400, ErrorCodes.INVALID_ID, 'Invalid workspaceId');
  }

  const runs = crewRunner.listRuns({
    workspaceId: idCheck.data,
    ownerId: caller.user,
  });
  return NextResponse.json({ runs }, { headers: NO_STORE_HEADERS });
}

/**
 * POST /api/runs
 *
 * Starts a new crew run. Validates the body shape, resolves the workspace
 * scoped to the caller (cross-owner workspaces appear as not-found so we
 * don't leak existence), and hands off to the runner.
 *
 * On success returns 201 with a Location header pointing at the new run.
 */
export async function POST(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;
  const raw = await request.json().catch(() => null);
  const parsed = StartRunBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }

  const workspace = getCrewStudioWorkspace(parsed.data.workspaceId, caller.user);
  if (!workspace) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found');
  }

  const crew = workspace.crews.find((c) => c.id === parsed.data.crewId);
  if (!crew) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Crew not found in workspace');
  }

  try {
    const run = await crewRunner.startRun(
      workspace,
      crew,
      parsed.data.inputs || {},
      caller.user
    );
    return NextResponse.json(run, {
      status: 201,
      headers: { Location: `/api/runs/${run.id}` },
    });
  } catch (error) {
    // Log server-side; never echo raw downstream error strings.
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'startRun failed');
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return errorResponse(
        statusCode,
        ErrorCodes.BAD_REQUEST,
        'Run could not be started'
      );
    }
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Run could not be started');
  }
}
