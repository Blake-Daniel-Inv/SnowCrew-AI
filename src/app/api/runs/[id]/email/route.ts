import { NextResponse } from 'next/server';
import { crewRunner } from '@/lib/crew-runner';
import { getCrewStudioWorkspace } from '@/lib/crew-studio-store';
import { sendRunActionEmail } from '@/lib/snowflake-email';
import {
  ErrorCodes,
  errorResponse,
  parseIdParam,
  requireCaller,
} from '@/lib/schemas/common';
import { EmailRunBody } from '@/lib/schemas/runs';

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/runs/[id]/email' });

export const runtime = 'nodejs';

/**
 * Flatten `recipients` into a deduped array. Accepts either a single
 * delimited string (comma/newline) or an array of strings; mirrors the
 * pre-zod behavior so the UI doesn't need a code change.
 */
function parseRecipients(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => entry.split(/[,\n]+/))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return (value || '')
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * POST /api/runs/[id]/email
 *
 * Sends a "this run is done" email via Snowflake's notification
 * integration. Validates the body shape, scopes the run + workspace
 * lookup to the caller, then forwards to the email helper.
 *
 * Downstream failures bubble up as 502 BAD_UPSTREAM with the canonical
 * error envelope — previously the route returned the helper's result
 * shape with a 400, which violated the contract.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;
  const { id: rawId } = await context.params;
  const idResult = parseIdParam(rawId);
  if (!idResult.ok) return idResult.response;

  const run = crewRunner.getRun(idResult.id, caller.user);
  if (!run) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Run not found');
  }
  if (run.status !== 'completed') {
    return errorResponse(
      409,
      ErrorCodes.CONFLICT,
      'Only completed runs can be emailed.'
    );
  }

  const workspace = getCrewStudioWorkspace(run.workspaceId, caller.user);
  if (!workspace) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found for run.');
  }

  const raw = await request.json().catch(() => null);
  // Accept an empty body — the route historically falls back to action defaults.
  const parsed = EmailRunBody.safeParse(raw ?? {});
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }

  const body = parsed.data;
  const action = body.actionId
    ? workspace.actions.find((candidate) => candidate.id === body.actionId)
    : null;
  if (body.actionId && !action) {
    return errorResponse(
      404,
      ErrorCodes.NOT_FOUND,
      'Email action not found in workspace.'
    );
  }
  if (action && !action.enabled) {
    return errorResponse(
      409,
      ErrorCodes.CONFLICT,
      'Email action is disabled.'
    );
  }

  const recipients = parseRecipients(body.recipients);

  try {
    const result = await sendRunActionEmail({
      workspace,
      run,
      action,
      connectionId: body.connectionId,
      recipients,
      subject: body.subject,
    });

    if (!result.ok) {
      // The helper signalled a downstream failure (Snowflake call rejected
      // the SYSTEM$SEND_EMAIL). Return as 502 with the canonical envelope.
      // Full result (including any upstream body details) is logged
      // server-side; we deliberately do NOT echo `result.details` or
      // `result.message` to the client to avoid leaking upstream content.
      log.error({ runId: idResult.id, result }, 'downstream email failure');
      return errorResponse(502, ErrorCodes.BAD_UPSTREAM, 'Email delivery failed', undefined);
    }
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'unhandled email error');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Email delivery failed.'
    );
  }
}
