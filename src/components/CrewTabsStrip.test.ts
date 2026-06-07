// PR 24 — Pure-function tests for the CrewTabsStrip helpers. The
// vitest env is Node-only (no jsdom), so we exercise the exported
// helpers directly. Component-level interaction tests are covered by
// the surrounding integration tests in CrewStudioApp once a DOM env
// is wired; for now these guarantee the deterministic surface.

import { describe, expect, it } from 'vitest';
import { canCloseTab, formatTabLabel } from './CrewTabsStrip';

describe('CrewTabsStrip — formatTabLabel', () => {
  it('returns short names unchanged', () => {
    expect(formatTabLabel('Lead crew')).toBe('Lead crew');
  });

  it('trims surrounding whitespace before measuring', () => {
    expect(formatTabLabel('   Lead crew   ')).toBe('Lead crew');
  });

  it('truncates names longer than 28 chars with an ellipsis', () => {
    const long = 'This crew name is intentionally far too long';
    const out = formatTabLabel(long);
    expect(out.length).toBe(28);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('This crew name is intention')).toBe(true);
  });

  it('treats null/undefined/empty as empty string', () => {
    expect(formatTabLabel('')).toBe('');
    // Defensive: types say `string`, but stale data sometimes ships
    // null. Guard prevents a runtime crash in render.
    expect(formatTabLabel(undefined as unknown as string)).toBe('');
    expect(formatTabLabel(null as unknown as string)).toBe('');
  });
});

describe('CrewTabsStrip — canCloseTab', () => {
  it('returns false for the only open tab (cannot empty the canvas)', () => {
    expect(canCloseTab(['crew-a'], 'crew-a')).toBe(false);
  });

  it('returns false when openTabs is empty', () => {
    expect(canCloseTab([], 'crew-a')).toBe(false);
  });

  it('returns true when more than one tab is open and the crewId is present', () => {
    expect(canCloseTab(['crew-a', 'crew-b'], 'crew-a')).toBe(true);
    expect(canCloseTab(['crew-a', 'crew-b'], 'crew-b')).toBe(true);
  });

  it('returns false when crewId is not in openTabs', () => {
    expect(canCloseTab(['crew-a', 'crew-b'], 'crew-c')).toBe(false);
  });

  it('returns true for any tab when three or more are open', () => {
    const tabs = ['crew-a', 'crew-b', 'crew-c'];
    for (const id of tabs) {
      expect(canCloseTab(tabs, id)).toBe(true);
    }
  });
});
