import { NextResponse } from 'next/server';
import { buildCrewStudioExportBundle } from '@/lib/crew-studio';
import {
  deleteCrewStudioWorkspace,
  getCrewStudioWorkspace,
  updateCrewStudioWorkspace,
} from '@/lib/crew-studio-store';
import { isGitRepo, resolveRepoPath } from '@/lib/git-utils';
import {
  ErrorCodes,
  NO_STORE_HEADERS,
  errorResponse,
  parseIdParam,
  requireCaller,
} from '@/lib/schemas/common';
import { UpdateWorkspaceBody } from '@/lib/schemas/workspaces';
import { buildETag, evaluatePrecondition } from '@/lib/workspace/if-match';
import type { CrewStudioWorkspace } from '@/types';

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/workspaces/[id]' });

export const runtime = 'nodejs';

// Header set on every response from this route so caches don't conflate
// matched / mismatched If-Match results for the same URL. The PATCH
// flow is the actual user of If-Match; GET pins it for symmetry so a
// downstream proxy doesn't strip the variant from the cache key.
const VARY_IF_MATCH = { Vary: 'If-Match' } as const;

/**
 * Validate (and resolve) an optional repoPath patch value. Throws a
 * typed error so the caller can map it to a 400 BAD_REQUEST.
 */
function resolveAndValidateRepoPath(repoPath?: string | null): string | null {
  if (!repoPath?.trim()) {
    return null;
  }
  const resolvedRepoPath = resolveRepoPath(repoPath);
  if (!isGitRepo(resolvedRepoPath)) {
    throw new Error('The selected directory is not a Git repository');
  }
  return resolvedRepoPath;
}

/**
 * GET /api/workspaces/[id]
 *
 * Returns the workspace and its export bundle if owned by the caller.
 * Cross-owner reads return 404 (same as missing) so we don't leak
 * workspace existence.
 *
 * PR 10: Response carries `ETag: "<updatedAt>"` so clients can use the
 * standard `If-Match: <etag>` flow on PATCH. `Vary: If-Match` pairs with
 * the PATCH handler so caches don't conflate variant responses.
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

  const workspace = getCrewStudioWorkspace(idResult.id, caller.user);
  if (!workspace) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found');
  }

  return NextResponse.json(
    {
      workspace,
      exports: buildCrewStudioExportBundle(workspace),
    },
    {
      headers: {
        ...NO_STORE_HEADERS,
        ...VARY_IF_MATCH,
        ETag: buildETag(workspace.updatedAt),
      },
    }
  );
}

/**
 * PATCH /api/workspaces/[id]
 *
 * Partial-update of a workspace. Validation errors return 400 with the
 * zod flatten output; downstream errors from the store return 500. The
 * two paths are split into separate try blocks so we never collapse a
 * Git-repo-path mismatch into the same envelope as a disk-write error.
 *
 * PR 10: Optimistic-concurrency via the If-Match header. Two tabs that
 * race a save against the same workspace MUST NOT silently overwrite
 * each other.
 *
 *   missing header              → 428 PRECONDITION_REQUIRED
 *   header != current updatedAt → 412 PRECONDITION_FAILED (body carries
 *                                  the server's current updatedAt so the
 *                                  client can prompt the user to reload)
 *   header == current updatedAt → proceed with the write
 *
 * The header value may be the raw ISO string OR the quoted ETag form
 * (`"<updatedAt>"`); we normalize before comparing.
 *
 * Note on freshness: we read the workspace, evaluate the precondition,
 * then call the store's update which re-reads under the file lock and
 * writes atomically. A second writer that lands between our read and
 * the store's lock would have the same `updatedAt` we observed, so the
 * second-writer's caller would have already failed the precondition
 * earlier in this handler. The narrow race window where two callers
 * see the same `updatedAt` and one of them squeaks through the lock
 * still results in one tab's update landing — which is the intended
 * "last writer wins after explicit confirmation" semantic.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;
  const { id: rawId } = await context.params;
  const idResult = parseIdParam(rawId);
  if (!idResult.ok) return idResult.response;

  // ---- Precondition phase. Runs before body parsing so we never
  // burn CPU on validation for a stale write that's going to be
  // rejected anyway.
  const existing = getCrewStudioWorkspace(idResult.id, caller.user);
  if (!existing) {
    // Same envelope GET returns for missing/cross-owner so we don't
    // leak workspace existence to an attacker probing ids.
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found');
  }

  const ifMatchHeader = request.headers.get('if-match');
  const decision = evaluatePrecondition(ifMatchHeader, existing.updatedAt);
  if (decision.kind === 'missing') {
    return errorResponse(
      428,
      ErrorCodes.PRECONDITION_REQUIRED,
      'Workspace PATCH requires If-Match header with last-known updatedAt.',
      undefined,
      { headers: VARY_IF_MATCH }
    );
  }
  if (decision.kind === 'mismatch') {
    // Include the server's current updatedAt so the client doesn't
    // need a second round trip to refresh its ETag before prompting
    // the user. Status 412 is the standard "your precondition lost"
    // signal; the canonical envelope embeds `currentUpdatedAt` in
    // `details` so existing error-shape consumers keep parsing.
    return errorResponse(
      412,
      ErrorCodes.PRECONDITION_FAILED,
      'Workspace was modified in another session.',
      { currentUpdatedAt: decision.currentUpdatedAt },
      { headers: VARY_IF_MATCH }
    );
  }

  const raw = await request.json().catch(() => null);
  const parsed = UpdateWorkspaceBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }
  const body = parsed.data;

  // ---- Validation phase: repoPath must resolve to a real git repo. ----
  let nextRepoPath: string | null | undefined;
  try {
    nextRepoPath =
      typeof body.repoPath === 'string'
        ? resolveAndValidateRepoPath(body.repoPath)
        : body.repoPath;
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'repoPath validation failed');
    return errorResponse(400, ErrorCodes.BAD_REQUEST, 'Invalid repository path');
  }

  // ---- Persistence phase: store/disk errors are 500. ----
  try {
    // Cast: zod's parsed shape has deeply-optional fields, but inner entity
    // types (CrewStudioAgent etc.) require name/id at the type level. The
    // normalizer inside updateCrewStudioWorkspace fills in any missing
    // required fields, so a structural cast here is sound.
    const patch = {
      ...body,
      repoPath: typeof nextRepoPath === 'undefined' ? body.repoPath : nextRepoPath,
    } as Partial<Omit<CrewStudioWorkspace, 'id' | 'createdAt' | 'ownerId'>>;
    const workspace = await updateCrewStudioWorkspace(idResult.id, patch, caller.user);

    if (!workspace) {
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found');
    }

    return NextResponse.json(
      {
        workspace,
        exports: buildCrewStudioExportBundle(workspace),
      },
      {
        headers: {
          ...VARY_IF_MATCH,
          ETag: buildETag(workspace.updatedAt),
        },
      }
    );
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'PATCH failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Workspace update failed.'
    );
  }
}

/**
 * DELETE /api/workspaces/[id]
 *
 * Removes the workspace from the store if the caller owns it.
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

  try {
    const deleted = await deleteCrewStudioWorkspace(idResult.id, caller.user);
    if (!deleted) {
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Workspace not found');
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'DELETE failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Workspace deletion failed.'
    );
  }
}
