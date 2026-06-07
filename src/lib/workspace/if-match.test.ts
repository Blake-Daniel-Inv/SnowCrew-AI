import { describe, expect, it } from 'vitest';
import {
  buildETag,
  evaluatePrecondition,
  parseIfMatchHeader,
} from './if-match';

// These tests pin the PR 10 contract by exercising the pure helpers
// the route delegates to. They intentionally do not spin up a Next
// request — the route is a thin layer over `evaluatePrecondition`, so
// covering the matrix here (missing / mismatch / match / quoted form)
// keeps the suite hermetic and fast.

const CURRENT = '2026-05-12T13:30:00.000Z';

describe('parseIfMatchHeader', () => {
  it('returns null for null/undefined/empty', () => {
    expect(parseIfMatchHeader(null)).toBeNull();
    expect(parseIfMatchHeader(undefined)).toBeNull();
    expect(parseIfMatchHeader('')).toBeNull();
    expect(parseIfMatchHeader('   ')).toBeNull();
  });

  it('returns the raw ISO when unquoted', () => {
    expect(parseIfMatchHeader(CURRENT)).toBe(CURRENT);
  });

  it('strips a single matched pair of surrounding double-quotes', () => {
    expect(parseIfMatchHeader(`"${CURRENT}"`)).toBe(CURRENT);
  });

  it('trims surrounding whitespace before and after stripping quotes', () => {
    expect(parseIfMatchHeader(`  "${CURRENT}"  `)).toBe(CURRENT);
    expect(parseIfMatchHeader(`  ${CURRENT}  `)).toBe(CURRENT);
  });

  it('returns null for the empty-quoted form `""`', () => {
    // `""` is a valid ETag for "no version" — treat it the same as
    // missing the header.
    expect(parseIfMatchHeader('""')).toBeNull();
  });

  it('does not strip a single leading or trailing quote', () => {
    // Asymmetric quotes are malformed; preserve them so the equality
    // check below fails and the client gets a clear mismatch back.
    expect(parseIfMatchHeader(`"${CURRENT}`)).toBe(`"${CURRENT}`);
    expect(parseIfMatchHeader(`${CURRENT}"`)).toBe(`${CURRENT}"`);
  });
});

describe('evaluatePrecondition', () => {
  it('reports `missing` when the header is absent', () => {
    expect(evaluatePrecondition(null, CURRENT)).toEqual({ kind: 'missing' });
    expect(evaluatePrecondition(undefined, CURRENT)).toEqual({ kind: 'missing' });
    expect(evaluatePrecondition('', CURRENT)).toEqual({ kind: 'missing' });
  });

  it('reports `mismatch` with the current updatedAt when stale', () => {
    const stale = '2026-05-12T13:00:00.000Z';
    expect(evaluatePrecondition(stale, CURRENT)).toEqual({
      kind: 'mismatch',
      currentUpdatedAt: CURRENT,
    });
  });

  it('reports `match` when the raw header matches', () => {
    expect(evaluatePrecondition(CURRENT, CURRENT)).toEqual({ kind: 'match' });
  });

  it('reports `match` when the quoted-ETag form matches', () => {
    expect(evaluatePrecondition(`"${CURRENT}"`, CURRENT)).toEqual({ kind: 'match' });
  });

  it('reports `mismatch` for a quoted form that decodes to a different value', () => {
    expect(evaluatePrecondition(`"2026-05-12T13:00:00.000Z"`, CURRENT)).toEqual({
      kind: 'mismatch',
      currentUpdatedAt: CURRENT,
    });
  });
});

describe('buildETag', () => {
  it('wraps the value in double quotes', () => {
    expect(buildETag(CURRENT)).toBe(`"${CURRENT}"`);
  });

  it('round-trips through parseIfMatchHeader', () => {
    const tag = buildETag(CURRENT);
    expect(parseIfMatchHeader(tag)).toBe(CURRENT);
  });
});
