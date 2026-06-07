import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewStudioWorkspace } from '@/types';

// PR 10: End-to-end coverage of the If-Match precondition flow on
// PATCH /api/workspaces/[id]. The route depends on the crew-studio
// store and the canvas exporter; both are mocked here so the test
// stays hermetic. The pure decision matrix lives in
// src/lib/workspace/if-match.test.ts — this file exercises the route's
// HTTP envelope (status codes, headers, body shape).

// Mock the store BEFORE importing the route. Vitest hoists vi.mock so
// any module the route resolves transitively gets the mocked version.
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@/lib/crew-studio-store', () => ({
  getCrewStudioWorkspace: mockGet,
  updateCrewStudioWorkspace: mockUpdate,
  deleteCrewStudioWorkspace: mockDelete,
}));

// Export bundle isn't relevant for these tests — return a constant
// shape so the route's NextResponse.json doesn't blow up.
vi.mock('@/lib/crew-studio', () => ({
  buildCrewStudioExportBundle: () => ({
    agentsYaml: '',
    tasksYaml: '',
    crewPython: '',
    envExample: '',
  }),
}));

// repoPath validation hits the filesystem; bypass it in tests by
// shimming the predicates to "always a git repo, same resolved path".
vi.mock('@/lib/git-utils', () => ({
  isGitRepo: () => true,
  resolveRepoPath: (p: string) => p,
}));

// Route uses dynamic import so the mocks land first.
async function loadRoute() {
  return await import('./route');
}

const OWNER = 'test-owner';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const ORIGINAL_UPDATED_AT = '2026-05-12T13:30:00.000Z';
const NEW_UPDATED_AT = '2026-05-12T13:35:00.000Z';

function buildWorkspace(overrides: Partial<CrewStudioWorkspace> = {}): CrewStudioWorkspace {
  return {
    id: WORKSPACE_ID,
    ownerId: OWNER,
    repoPath: null,
    name: 'Test Workspace',
    description: '',
    productBrief: '',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: [],
    agents: [],
    tasks: [],
    actions: [],
    crews: [],
    connections: [],
    subCrewInvocations: [],
    canvasLayout: { nodes: {}, zoom: 1, panX: 0, panY: 0 },
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: ORIGINAL_UPDATED_AT,
    ...overrides,
  };
}

function buildPatchRequest(opts: {
  ifMatch?: string;
  body?: Record<string, unknown>;
}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Mirror middleware: route reads identity from x-snowcrew-user.
    'x-snowcrew-user': OWNER,
  };
  if (typeof opts.ifMatch !== 'undefined') {
    headers['if-match'] = opts.ifMatch;
  }
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(opts.body ?? { name: 'Updated Name' }),
  });
}

function buildContext() {
  return { params: Promise.resolve({ id: WORKSPACE_ID }) };
}

beforeEach(() => {
  mockGet.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PATCH /api/workspaces/[id] — If-Match precondition', () => {
  it('returns 428 PRECONDITION_REQUIRED when If-Match is missing', async () => {
    mockGet.mockReturnValueOnce(buildWorkspace());
    const { PATCH } = await loadRoute();

    const res = await PATCH(buildPatchRequest({}), buildContext());

    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.error.code).toBe('PRECONDITION_REQUIRED');
    expect(body.error.message).toMatch(/If-Match/);
    expect(res.headers.get('Vary')).toContain('If-Match');
    // Store update must NOT have been called.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 412 PRECONDITION_FAILED with currentUpdatedAt on mismatch', async () => {
    mockGet.mockReturnValueOnce(buildWorkspace());
    const { PATCH } = await loadRoute();

    const stale = '2026-05-12T12:00:00.000Z';
    const res = await PATCH(
      buildPatchRequest({ ifMatch: stale }),
      buildContext()
    );

    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.error.code).toBe('PRECONDITION_FAILED');
    expect(body.error.message).toMatch(/another session/);
    expect(body.error.details).toEqual({ currentUpdatedAt: ORIGINAL_UPDATED_AT });
    expect(res.headers.get('Vary')).toContain('If-Match');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 200 when If-Match matches (raw ISO form)', async () => {
    mockGet.mockReturnValueOnce(buildWorkspace());
    const updated = buildWorkspace({ name: 'Updated Name', updatedAt: NEW_UPDATED_AT });
    mockUpdate.mockResolvedValueOnce(updated);
    const { PATCH } = await loadRoute();

    const res = await PATCH(
      buildPatchRequest({ ifMatch: ORIGINAL_UPDATED_AT, body: { name: 'Updated Name' } }),
      buildContext()
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspace.name).toBe('Updated Name');
    expect(body.workspace.updatedAt).toBe(NEW_UPDATED_AT);
    // ETag echoes the new updatedAt in quoted form.
    expect(res.headers.get('ETag')).toBe(`"${NEW_UPDATED_AT}"`);
    expect(res.headers.get('Vary')).toContain('If-Match');
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it('accepts the quoted-ETag form of If-Match', async () => {
    mockGet.mockReturnValueOnce(buildWorkspace());
    const updated = buildWorkspace({ updatedAt: NEW_UPDATED_AT });
    mockUpdate.mockResolvedValueOnce(updated);
    const { PATCH } = await loadRoute();

    const res = await PATCH(
      buildPatchRequest({ ifMatch: `"${ORIGINAL_UPDATED_AT}"` }),
      buildContext()
    );

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it('returns 404 (not 412/428) when the workspace does not exist', async () => {
    mockGet.mockReturnValueOnce(null);
    const { PATCH } = await loadRoute();

    const res = await PATCH(
      buildPatchRequest({ ifMatch: ORIGINAL_UPDATED_AT }),
      buildContext()
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    // No precondition evaluation when the workspace is missing — we
    // shouldn't leak existence via a 412 vs 404 split.
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('GET /api/workspaces/[id] — ETag', () => {
  it('exposes ETag: "<updatedAt>" and Vary: If-Match', async () => {
    mockGet.mockReturnValueOnce(buildWorkspace());
    const { GET } = await loadRoute();

    const req = new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}`, {
      headers: { 'x-snowcrew-user': OWNER },
    });
    const res = await GET(req, buildContext());

    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${ORIGINAL_UPDATED_AT}"`);
    expect(res.headers.get('Vary')).toContain('If-Match');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
