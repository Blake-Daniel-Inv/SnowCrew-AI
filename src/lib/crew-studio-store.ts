import path from 'path';
import { normalizeCrewStudioWorkspace } from './crew-studio';
import { buildFromTemplate, type WorkspaceTemplateKey } from './templates';
import { ensureDataDir, mutateJsonFile, readJsonFile } from './json-store';
import { resolveRepoPath } from './git-utils';
import type { CrewStudioWorkspace } from '@/types';

const CREW_STUDIO_STORE_FILE = path.join(ensureDataDir('crew-studio'), 'workspaces.json');

type StoredWorkspace = Partial<CrewStudioWorkspace>;

function sortWorkspaces(workspaces: CrewStudioWorkspace[]): CrewStudioWorkspace[] {
  return [...workspaces].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function readWorkspaces(): CrewStudioWorkspace[] {
  return sortWorkspaces(
    readJsonFile<StoredWorkspace[]>(CREW_STUDIO_STORE_FILE, []).map(
      normalizeCrewStudioWorkspace
    )
  );
}

/**
 * Ownership gate. Rows must match `ownerId` exactly; the '__legacy__'
 * sentinel is treated as a real distinct identity, so pre-auth rows are
 * invisible to authenticated callers.
 */
function ownedBy(workspace: CrewStudioWorkspace, ownerId: string): boolean {
  return workspace.ownerId === ownerId;
}

export function listCrewStudioWorkspaces(opts: {
  ownerId: string;
  repoPath?: string;
}): CrewStudioWorkspace[] {
  const workspaces = readWorkspaces().filter((workspace) => ownedBy(workspace, opts.ownerId));
  if (!opts.repoPath) {
    return workspaces;
  }

  const resolvedRepoPath = resolveRepoPath(opts.repoPath);
  return workspaces.filter((workspace) => workspace.repoPath === resolvedRepoPath);
}

export function getCrewStudioWorkspace(
  id: string,
  ownerId: string
): CrewStudioWorkspace | null {
  const workspace = readWorkspaces().find((entry) => entry.id === id);
  if (!workspace) return null;
  if (!ownedBy(workspace, ownerId)) return null;
  return workspace;
}

export async function createCrewStudioWorkspace(
  input: Partial<Pick<CrewStudioWorkspace, 'repoPath' | 'name' | 'description'>> & {
    templateKey?: WorkspaceTemplateKey;
  } = {},
  ownerId: string
): Promise<CrewStudioWorkspace> {
  const repoPath = input.repoPath ? resolveRepoPath(input.repoPath) : null;
  const templateKey: WorkspaceTemplateKey = input.templateKey || 'starter';
  const base = buildFromTemplate(templateKey, repoPath);

  const workspace = normalizeCrewStudioWorkspace({
    ...base,
    ownerId,
    name: input.name?.trim() || base.name,
    description: input.description?.trim() || base.description,
    updatedAt: new Date().toISOString(),
  });

  await mutateJsonFile<StoredWorkspace[]>(CREW_STUDIO_STORE_FILE, [], (current) => {
    const normalized = current.map(normalizeCrewStudioWorkspace);
    return sortWorkspaces([workspace, ...normalized]);
  });

  return workspace;
}

/**
 * Persist a pre-built workspace (e.g., from cloneWorkspace) under the
 * caller's identity. This is the narrow companion to
 * createCrewStudioWorkspace: that helper expects a template-key and
 * builds the workspace internally, while this helper accepts a fully-
 * formed workspace and writes it as-is (after a defensive re-normalize
 * to enforce shape). The caller is responsible for stamping ownerId on
 * the workspace before calling — we do not silently override.
 */
export async function persistClonedWorkspace(
  workspace: CrewStudioWorkspace
): Promise<CrewStudioWorkspace> {
  const normalized = normalizeCrewStudioWorkspace(workspace);

  await mutateJsonFile<StoredWorkspace[]>(CREW_STUDIO_STORE_FILE, [], (current) => {
    const existing = current.map(normalizeCrewStudioWorkspace);
    // UUID collision check. With crypto.randomUUID() this is
    // astronomically unlikely, but we surface it as a thrown error so
    // the route can map it to 409 CONFLICT rather than silently
    // overwriting the existing row.
    if (existing.some((entry) => entry.id === normalized.id)) {
      throw new WorkspaceIdCollisionError(normalized.id);
    }
    return sortWorkspaces([normalized, ...existing]);
  });

  return normalized;
}

/** Thrown by persistClonedWorkspace when the new workspace's id
 * collides with an existing row. Practically unreachable with
 * crypto.randomUUID() but defended-against so the API can return 409. */
export class WorkspaceIdCollisionError extends Error {
  constructor(public readonly id: string) {
    super(`Workspace id collision: ${id}`);
    this.name = 'WorkspaceIdCollisionError';
  }
}

export async function updateCrewStudioWorkspace(
  id: string,
  update: Partial<Omit<CrewStudioWorkspace, 'id' | 'createdAt' | 'ownerId'>>,
  ownerId: string
): Promise<CrewStudioWorkspace | null> {
  let updated: CrewStudioWorkspace | null = null;

  await mutateJsonFile<StoredWorkspace[]>(CREW_STUDIO_STORE_FILE, [], (current) => {
    const workspaces = current.map(normalizeCrewStudioWorkspace);
    const index = workspaces.findIndex((workspace) => workspace.id === id);
    if (index === -1) {
      return workspaces;
    }

    const existing = workspaces[index];
    // Ownership gate: silently no-op (treat as not-found) when another
    // caller's row id collides. Returning the untouched list preserves
    // the file; the `updated` outer var stays null so the API returns
    // 404.
    if (!ownedBy(existing, ownerId)) {
      return workspaces;
    }

    const next = normalizeCrewStudioWorkspace({
      ...existing,
      ...update,
      // Owner is immutable once set.
      ownerId: existing.ownerId,
      repoPath:
        typeof update.repoPath === 'string' ? resolveRepoPath(update.repoPath) : existing.repoPath,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });

    workspaces[index] = next;
    updated = next;
    return sortWorkspaces(workspaces);
  });

  return updated;
}

export async function deleteCrewStudioWorkspace(
  id: string,
  ownerId: string
): Promise<boolean> {
  let deleted = false;

  await mutateJsonFile<StoredWorkspace[]>(CREW_STUDIO_STORE_FILE, [], (current) => {
    const workspaces = current.map(normalizeCrewStudioWorkspace);
    const next = workspaces.filter(
      (workspace) => !(workspace.id === id && ownedBy(workspace, ownerId))
    );
    deleted = next.length !== workspaces.length;
    return next;
  });

  return deleted;
}
