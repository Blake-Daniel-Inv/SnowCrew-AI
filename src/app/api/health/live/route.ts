import { NextResponse } from 'next/server';

/**
 * GET /api/health/live
 *
 * Cheap liveness probe — answers "is this process actually responding
 * to requests?" without touching the DB, the network, or auth. Returns
 * 200 unconditionally if the handler runs.
 *
 * Operator notes:
 *   - SPCS / k8s probes call this without identity headers. The
 *     middleware skip-list covers `/api/health/*` so the probe is not
 *     blocked when SPCS context is absent.
 *   - `process.uptime()` requires Node runtime — we pin it explicitly
 *     so an accidental switch to edge runtime doesn't return Infinity.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'snowcrewai',
      uptime: process.uptime(),
    },
    {
      status: 200,
      headers: {
        // Probes hammer this endpoint; never let an intermediary cache
        // a stale 200 across a process restart.
        'Cache-Control': 'no-store',
      },
    }
  );
}
