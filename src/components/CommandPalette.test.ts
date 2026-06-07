import { describe, expect, it } from 'vitest';
import {
  filterCommands,
  scoreMatch,
  type Command,
} from './CommandPalette';

/**
 * The CommandPalette JSX requires a DOM, but the matching logic is
 * pure JS. We test the matching here so the suite stays node-only
 * (the project's vitest config is environment: 'node').
 */

const makeCmd = (
  id: string,
  section: Command['section'],
  label: string,
  extra: Partial<Command> = {}
): Command => ({
  id,
  section,
  label,
  invoke: () => {},
  ...extra,
});

describe('scoreMatch', () => {
  it('returns 0 for empty query (matches everything equally)', () => {
    expect(scoreMatch('Run crew', '')).toBe(0);
    expect(scoreMatch('Anything at all', '')).toBe(0);
  });

  it('returns null when a query char is missing', () => {
    expect(scoreMatch('Run crew', 'xyz')).toBeNull();
    expect(scoreMatch('hello', 'helloo')).toBeNull(); // extra char
  });

  it('is case-insensitive', () => {
    expect(scoreMatch('Run Crew', 'run')).not.toBeNull();
    expect(scoreMatch('Run Crew', 'RUN')).not.toBeNull();
    expect(scoreMatch('Run Crew', 'rUn')).not.toBeNull();
  });

  it('prefers contiguous matches over scattered ones', () => {
    const contiguous = scoreMatch('foobar', 'foo')!;
    const scattered = scoreMatch('f.o.o.bar', 'foo')!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('rewards start-of-string matches', () => {
    const start = scoreMatch('crew runner', 'cr')!;
    const middle = scoreMatch('xx crew runner', 'cr')!;
    expect(start).toBeGreaterThan(middle);
  });

  it('only matches characters in order', () => {
    expect(scoreMatch('abc', 'cba')).toBeNull();
    expect(scoreMatch('abcdef', 'ace')).not.toBeNull();
  });

  it('respects query-character order even on repeated chars', () => {
    expect(scoreMatch('mississippi', 'msi')).not.toBeNull();
    expect(scoreMatch('mississippi', 'ssm')).toBeNull();
  });

  it('returns a higher score for shorter equivalent haystacks', () => {
    const short = scoreMatch('Run', 'run')!;
    const long = scoreMatch('Run crew with extra detail and stuff', 'run')!;
    expect(short).toBeGreaterThan(long);
  });
});

describe('filterCommands', () => {
  const commands: Command[] = [
    makeCmd('run', 'Actions', 'Run crew'),
    makeCmd('save', 'Actions', 'Save workspace'),
    makeCmd('settings', 'Actions', 'Open settings'),
    makeCmd('integ', 'Actions', 'Open integrations'),
    makeCmd('ws-1', 'Workspaces', 'Workspace: Alpha'),
    makeCmd('ws-2', 'Workspaces', 'Workspace: Beta'),
    makeCmd('ws-3', 'Workspaces', 'Workspace: Gamma'),
    makeCmd('rr-1', 'Recent runs', 'Run: abc · CrewA · 2m ago'),
    makeCmd('rr-2', 'Recent runs', 'Run: def · CrewB · 5m ago'),
  ];

  it('empty query returns every enabled command unchanged', () => {
    const out = filterCommands(commands, '');
    expect(out.length).toBe(commands.length);
    expect(out.map((c) => c.id)).toEqual(commands.map((c) => c.id));
  });

  it('whitespace-only query returns every enabled command', () => {
    expect(filterCommands(commands, '   ').length).toBe(commands.length);
  });

  it('filters out disabled commands even with empty query', () => {
    const cs: Command[] = [
      ...commands,
      makeCmd('disabled', 'Actions', 'Disabled action', { disabled: true }),
    ];
    const out = filterCommands(cs, '');
    expect(out.find((c) => c.id === 'disabled')).toBeUndefined();
  });

  it('exact-substring match outranks scattered match within a section', () => {
    const out = filterCommands(commands, 'run');
    // "Run crew" (exact run prefix) should outrank "Open integrations" (no
    // match) and "Workspace: Alpha" (also no match) — and within Actions
    // it should also outrank action labels that match scattered chars.
    expect(out[0].id).toBe('run');
  });

  it('is case-insensitive', () => {
    expect(filterCommands(commands, 'OPEN').map((c) => c.id)).toEqual(
      filterCommands(commands, 'open').map((c) => c.id)
    );
  });

  it('preserves section order: Actions before Workspaces before Recent runs', () => {
    // "ru" matches "Run crew", "Workspace: Gamma" (r in Gamma? no — let's
    // pick a query that hits all three sections).
    const out = filterCommands(commands, 'r');
    const sections = out.map((c) => c.section);
    // No Workspaces section should appear before any Actions section.
    let lastIdx = -1;
    const ORDER = ['Actions', 'Workspaces', 'Recent runs'] as const;
    for (const section of sections) {
      const idx = ORDER.indexOf(section as (typeof ORDER)[number]);
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });

  it('returns empty array when no chars match', () => {
    expect(filterCommands(commands, 'zzqq')).toEqual([]);
  });

  it('matches against section name as fallback (typing "rec" surfaces Recent runs)', () => {
    const out = filterCommands(commands, 'recent');
    expect(out.some((c) => c.section === 'Recent runs')).toBe(true);
  });

  it('eliminates commands whose label is missing one query char', () => {
    const out = filterCommands(commands, 'workspaze');
    // No "Workspace:" label has a 'z' — they should all be filtered out.
    expect(out.find((c) => c.label.startsWith('Workspace:'))).toBeUndefined();
  });

  it('is deterministic for equal scores (preserves input order)', () => {
    const cs: Command[] = [
      makeCmd('first', 'Workspaces', 'Workspace: X'),
      makeCmd('second', 'Workspaces', 'Workspace: X'),
    ];
    const out = filterCommands(cs, 'workspace');
    expect(out.map((c) => c.id)).toEqual(['first', 'second']);
  });

  it('handles multi-word queries (spaces are query chars)', () => {
    // "run crew" — each char including the space must appear in order.
    const out = filterCommands(commands, 'run crew');
    expect(out[0].id).toBe('run');
  });

  it('keeps a recent-runs row when the query matches the time hint', () => {
    // "ago" appears in both recent-run labels; both should remain.
    const out = filterCommands(commands, 'ago');
    expect(out.filter((c) => c.section === 'Recent runs').length).toBe(2);
  });

  it('returns commands with no duplication when section name also matches', () => {
    // "a" appears in multiple labels and section names; each command must
    // appear at most once.
    const out = filterCommands(commands, 'a');
    const ids = out.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
