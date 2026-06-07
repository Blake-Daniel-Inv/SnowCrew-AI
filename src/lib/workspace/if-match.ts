// PR 10: Pure helpers for the If-Match precondition guard on
// PATCH /api/workspaces/[id]. Extracted from the route so the
// decision can be unit-tested without spinning up a Next request.
//
// HTTP contract:
//   no header        → 428 Precondition Required
//   header mismatch  → 412 Precondition Failed (body includes server updatedAt)
//   header matches   → caller proceeds with the write
//
// Accept either the raw ISO string (`2026-05-12T...`) or the standard
// quoted-ETag form (`"2026-05-12T..."`). Strong-ETag W/ weak prefix is
// not accepted — workspace serialization is deterministic, so we don't
// need weak comparison semantics.

/**
 * Normalize an If-Match header value into the underlying updatedAt
 * ISO string. Returns null when the header is absent or empty after
 * stripping whitespace + quotes (we treat `""` and missing the same —
 * neither identifies a version).
 */
export function parseIfMatchHeader(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  // Strip surrounding double-quotes if present (standard ETag form is
  // `"..."`). We only strip a matched outer pair — a value containing
  // a stray quote inside the timestamp would be rejected later by the
  // equality check anyway.
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1).trim();
    return inner || null;
  }
  return trimmed;
}

export type PreconditionDecision =
  | { kind: 'missing' }
  | { kind: 'mismatch'; currentUpdatedAt: string }
  | { kind: 'match' };

/**
 * Compare a parsed If-Match value against the server's current
 * updatedAt. Centralizing this so the route handler stays a thin
 * orchestration layer and so the matrix (missing/mismatch/match) is
 * exercised by a single test suite.
 */
export function evaluatePrecondition(
  ifMatchRaw: string | null | undefined,
  currentUpdatedAt: string
): PreconditionDecision {
  const ifMatch = parseIfMatchHeader(ifMatchRaw);
  if (!ifMatch) return { kind: 'missing' };
  if (ifMatch !== currentUpdatedAt) {
    return { kind: 'mismatch', currentUpdatedAt };
  }
  return { kind: 'match' };
}

/**
 * The ETag value we hand out on GET so clients can plumb it straight
 * back into If-Match without normalizing themselves. Quoted form is
 * the wire-standard; clients may send either form back.
 */
export function buildETag(updatedAt: string): string {
  return `"${updatedAt}"`;
}
