import { NextResponse } from 'next/server';
import { discoverCortexModels } from '@/lib/cortex-models';
import {
  ErrorCodes,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import { CortexModelsBody } from '@/lib/schemas/models';

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/models/cortex' });

export const runtime = 'nodejs';

/**
 * POST /api/models/cortex
 *
 * Probes Cortex's `inference:complete` endpoint for each candidate model
 * to figure out which ones are available to the caller's account/role.
 * Validation errors are 400; downstream Snowflake failures are 502.
 */
export async function POST(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  void authResult.caller;

  const raw = await request.json().catch(() => null);
  const parsed = CortexModelsBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }

  try {
    const result = await discoverCortexModels(parsed.data.connection);
    return NextResponse.json(result);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'downstream failure');
    return errorResponse(
      502,
      ErrorCodes.BAD_UPSTREAM,
      'Cortex model discovery failed.'
    );
  }
}
