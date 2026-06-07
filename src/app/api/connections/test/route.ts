import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/connection-test';
import {
  ErrorCodes,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import { TestConnectionBody } from '@/lib/schemas/connections';

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/connections/test' });

export const runtime = 'nodejs';

/**
 * POST /api/connections/test
 *
 * Round-trips the supplied Snowflake API connection to Snowflake to
 * confirm credentials + reachability. Validation errors are 400;
 * downstream failures are surfaced as 502.
 *
 * No data is persisted, so we don't need to scope by ownerId — but we
 * still read the caller identity defensively so the audit log can
 * attribute the probe.
 */
export async function POST(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  void authResult.caller;

  const raw = await request.json().catch(() => null);
  const parsed = TestConnectionBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }

  try {
    const result = await testConnection(parsed.data.connection);
    return NextResponse.json(result);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'downstream failure');
    return errorResponse(
      502,
      ErrorCodes.BAD_UPSTREAM,
      'Connection test failed.'
    );
  }
}
