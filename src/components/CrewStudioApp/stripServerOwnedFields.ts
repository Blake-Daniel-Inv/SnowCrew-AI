// Wave 2's zod `.strict()` schemas on /api/workspaces[/:id] and
// /api/workspaces/assistant reject unknown keys. The frontend's draft state
// carries the full server document — including `id`, `ownerId`, `createdAt`,
// `updatedAt` — but those are server-owned and must be removed from the
// request body, otherwise every save and every assistant call returns 400.
import type { CrewStudioWorkspace } from '@/types';

export function stripServerOwnedFields(ws: CrewStudioWorkspace) {
  const { id: _id, ownerId: _ownerId, createdAt: _createdAt, updatedAt: _updatedAt, ...patch } = ws;
  void _id; void _ownerId; void _createdAt; void _updatedAt;
  return patch;
}
