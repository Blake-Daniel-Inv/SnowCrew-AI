import { NextResponse } from 'next/server';
import { crewRunner } from '@/lib/crew-runner';
import {
  ErrorCodes,
  NO_STORE_HEADERS,
  errorResponse,
  parseIdParam,
  requireCaller,
} from '@/lib/schemas/common';

export const runtime = 'nodejs';

/**
 * GET /api/runs/[id]
 *
 * Returns the run if it belongs to the caller. Cross-owner reads return
 * 404 (same as missing) so we don't leak existence.
 */
export async function GET(
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
  return NextResponse.json(run, { headers: NO_STORE_HEADERS });
}

/**
 * DELETE /api/runs/[id]
 *
 * Cancels a run. Differentiates between the cases the API reviewer
 * called out:
 *   - 404 NOT_FOUND  : run does not exist (or is owned by someone else)
 *   - 409 CONFLICT   : run is in a terminal state we did not produce
 *                      (`completed` / `errored`) — caller can't cancel
 *                      something that's already done.
 *   - 200 ok         : run was active and was cancelled.
 *   - 200 alreadyTerminal : run was already `cancelled` — idempotent so
 *                            a second DELETE on a cancelled run is a
 *                            no-op success.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;
  const { id: rawId } = await context.params;
  const idResult = parseIdParam(rawId);
  if (!idResult.ok) return idResult.response;

  // Resolve the run first so we can tell missing vs. terminal apart.
  const run = crewRunner.getRun(idResult.id, caller.user);
  if (!run) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Run not found');
  }

  // Idempotent: second DELETE on a run we already cancelled is a success.
  if (run.status === 'cancelled') {
    return NextResponse.json(
      { ok: true, alreadyTerminal: true },
      { headers: NO_STORE_HEADERS }
    );
  }

  // Genuine state conflict: caller wants to cancel a run that already
  // finished under its own steam. Surface a 409 so the UI can refresh.
  if (run.status === 'completed' || run.status === 'errored') {
    return errorResponse(
      409,
      ErrorCodes.CONFLICT,
      `Run is already in terminal state '${run.status}'`
    );
  }

  const cancelled = crewRunner.cancelRun(idResult.id, caller.user);
  if (!cancelled) {
    // Race: the run flipped to terminal between getRun and cancelRun.
    // Treat as idempotent success — the user got what they asked for.
    return NextResponse.json(
      { ok: true, alreadyTerminal: true },
      { headers: NO_STORE_HEADERS }
    );
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
}
