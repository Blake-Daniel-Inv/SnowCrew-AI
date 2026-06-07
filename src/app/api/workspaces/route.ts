import { NextResponse } from 'next/server';
import {
  createCrewStudioWorkspace,
  listCrewStudioWorkspaces,
} from '@/lib/crew-studio-store';
import { isGitRepo, resolveRepoPath } from '@/lib/git-utils';
import {
  ErrorCodes,
  NO_STORE_HEADERS,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import {
  CreateWorkspaceBody,
  WorkspacesListQuery,
} from '@/lib/schemas/workspaces';

import { loggerWithContext } from '@/lib/logger';

const log = loggerWithContext({ route: '/api/workspaces' });

export const runtime = 'nodejs';

/**
 * Validate (and resolve) an optional repoPath query/body field. Throws
 * a typed error so the caller can map it to a 400.
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
 * GET /api/workspaces?repoPath=<path>
 *
 * Lists workspaces owned by the caller. The store filters by ownerId;
 * we never mix owners' workspaces in the response.
 */
export async function GET(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;
  const { searchParams } = new URL(request.url);

  const parsedQuery = WorkspacesListQuery.safeParse({
    repoPath: searchParams.get('repoPath') ?? undefined,
  });
  if (!parsedQuery.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid query',
      parsedQuery.error.flatten()
    );
  }

  let repoPath: string | null;
  try {
    repoPath = resolveAndValidateRepoPath(parsedQuery.data.repoPath ?? null);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'repoPath validation failed');
    return errorResponse(400, ErrorCodes.BAD_REQUEST, 'Invalid repository path');
  }

  const workspaces = listCrewStudioWorkspaces({
    ownerId: caller.user,
    repoPath: repoPath || undefined,
  });
  return NextResponse.json({ workspaces }, { headers: NO_STORE_HEADERS });
}

/**
 * POST /api/workspaces
 *
 * Creates a new workspace for the caller. The store stamps ownerId
 * from the second argument; the body's optional fields are validated
 * by zod and unknown keys are rejected.
 */
export async function POST(request: Request) {
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  const caller = authResult.caller;
  const raw = await request.json().catch(() => null);
  const parsed = CreateWorkspaceBody.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(
      400,
      ErrorCodes.BAD_REQUEST,
      'Invalid body',
      parsed.error.flatten()
    );
  }

  let repoPath: string | null;
  try {
    repoPath = resolveAndValidateRepoPath(parsed.data.repoPath ?? null);
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'repoPath validation failed');
    return errorResponse(400, ErrorCodes.BAD_REQUEST, 'Invalid repository path');
  }

  try {
    const workspace = await createCrewStudioWorkspace(
      {
        repoPath,
        name: parsed.data.name,
        description: parsed.data.description,
        templateKey: parsed.data.templateKey,
      },
      caller.user
    );
    return NextResponse.json(workspace, { status: 201 });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'create failed');
    return errorResponse(
      500,
      ErrorCodes.INTERNAL_ERROR,
      'Workspace creation failed.'
    );
  }
}
