import { NextResponse } from 'next/server';
import {
  getCrewStudioWorkspace,
  persistClonedWorkspace,
  WorkspaceIdCollisionError,
} from '@/lib/crew-studio-store';
import { cloneWorkspace } from '@/lib/workspace/clone';
import {
  ErrorCodes,
  errorResponse,
  parseIdParam,
  requireCaller,
} from '@/lib/schemas/common';
import { CloneWorkspaceBody } from '@/lib/schemas/workspaces';

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/workspaces/[id]/clone' });

export const runtime = 'nodejs';

/**
 * POST /api/workspaces/[id]/clone
 *
 * Duplicates the source workspace under the caller's identity. Every
 * entity gets a fresh UUID; every cross-reference is rewired through
 * the id map. The new workspace records `forkedFromId = source.id`.
 *
 *   body: { name?: string }   (both fields optional)
 *   201:  the new workspace (same shape POST /api/workspaces returns)
 *   400:  invalid body
 *   404:  source missing or not owned by caller (don't leak existence)
 *   409:  UUID collision (practically unreachable; defended-against)
 *   500:  store write failure
 *
 * Auth: the source workspace must be owned by the caller (cross-owner
 * reads return 404). The clone is stamped with the caller's identity
 * regardless of who owned the source — this is deliberate so a user
 * can fork another user's exported workspace once they import it.
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

  // Empty body is fine — both fields are optional. Tolerate POSTs
  // with no Content-Type / no body by coercing failure to `{}`.
  const raw = await request.json().catch(() => ({}));
  const parsed = CloneWorkspaceBody.safeParse(raw ?? {});
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }

  const source = getCrewStudioWorkspace(idResult.id, caller.user);
  if (!source) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found');
  }

  // Build the deep-clone (new UUIDs everywhere) and stamp the caller
  // as owner. cloneWorkspace itself re-normalizes; persistClonedWorkspace
  // does a defensive second normalize before writing.
  const cloned = cloneWorkspace(source, {
    newOwnerId: caller.user,
    newName: parsed.data.name,
  });

  try {
    const persisted = await persistClonedWorkspace(cloned);
    return NextResponse.json(persisted, { status: 201 });
  } catch (error) {
    if (error instanceof WorkspaceIdCollisionError) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'uuid collision');
      return errorResponse(
        409,
        ErrorCodes.CONFLICT,
        'A workspace with this id already exists.'
      );
    }
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'persist failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Workspace clone failed.'
    );
  }
}
