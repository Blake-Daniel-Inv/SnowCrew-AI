import { describe, expect, it } from 'vitest';
import {
  keyEventToShortcutId,
  SHORTCUT_ENTRIES,
} from './keyboardShortcuts';

describe('SHORTCUT_ENTRIES', () => {
  it('has unique ids', () => {
    const ids = SHORTCUT_ENTRIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders ⌘ on Mac and Ctrl on non-Mac for cmd-prefixed entries', () => {
    const cmdK = SHORTCUT_ENTRIES.find((s) => s.id === 'cmd-k')!;
    expect(cmdK.keys(true)).toEqual(['⌘', 'K']);
    expect(cmdK.keys(false)).toEqual(['Ctrl', 'K']);
  });

  it('marks future entries explicitly', () => {
    const cmdS = SHORTCUT_ENTRIES.find((s) => s.id === 'cmd-s')!;
    expect(cmdS.future).toBe(true);
    const cmdK = SHORTCUT_ENTRIES.find((s) => s.id === 'cmd-k')!;
    expect(cmdK.future).toBeUndefined();
  });

  it('always includes Cmd+K, ?, and Esc', () => {
    const ids = SHORTCUT_ENTRIES.map((s) => s.id);
    expect(ids).toContain('cmd-k');
    expect(ids).toContain('question');
    expect(ids).toContain('escape');
  });
});

describe('keyEventToShortcutId', () => {
  it('maps Cmd+K on Mac to cmd-k', () => {
    expect(
      keyEventToShortcutId(
        { key: 'k', metaKey: true, ctrlKey: false, shiftKey: false },
        true
      )
    ).toBe('cmd-k');
  });

  it('maps Ctrl+K on non-Mac to cmd-k', () => {
    expect(
      keyEventToShortcutId(
        { key: 'k', metaKey: false, ctrlKey: true, shiftKey: false },
        false
      )
    ).toBe('cmd-k');
  });

  it('maps Cmd+S on Mac to cmd-s', () => {
    expect(
      keyEventToShortcutId(
        { key: 's', metaKey: true, ctrlKey: false, shiftKey: false },
        true
      )
    ).toBe('cmd-s');
  });

  it('maps Cmd+Enter to cmd-enter', () => {
    expect(
      keyEventToShortcutId(
        { key: 'Enter', metaKey: true, ctrlKey: false, shiftKey: false },
        true
      )
    ).toBe('cmd-enter');
  });

  it('maps ? to question', () => {
    expect(
      keyEventToShortcutId(
        { key: '?', metaKey: false, ctrlKey: false, shiftKey: true },
        true
      )
    ).toBe('question');
  });

  it('maps Shift+/ to question', () => {
    expect(
      keyEventToShortcutId(
        { key: '/', metaKey: false, ctrlKey: false, shiftKey: true },
        true
      )
    ).toBe('question');
  });

  it('maps Escape to escape', () => {
    expect(
      keyEventToShortcutId(
        { key: 'Escape', metaKey: false, ctrlKey: false, shiftKey: false },
        true
      )
    ).toBe('escape');
  });

  it('returns null for unrelated keys', () => {
    expect(
      keyEventToShortcutId(
        { key: 'q', metaKey: false, ctrlKey: false, shiftKey: false },
        true
      )
    ).toBeNull();
  });

  it('returns null for Cmd+? (browser-reserved)', () => {
    // We don't currently map Cmd+? to a shortcut — it should fall through.
    expect(
      keyEventToShortcutId(
        { key: '?', metaKey: true, ctrlKey: false, shiftKey: true },
        true
      )
    ).toBeNull();
  });

  it('respects platform: Ctrl+K on Mac is NOT mapped', () => {
    expect(
      keyEventToShortcutId(
        { key: 'k', metaKey: false, ctrlKey: true, shiftKey: false },
        true
      )
    ).toBeNull();
  });
});
