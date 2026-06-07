import { describe, expect, it } from 'vitest';
import {
  classifyShortcut,
  formatRelativeShort,
  isEditableTarget,
} from './useGlobalShortcuts';

describe('classifyShortcut', () => {
  // Node 24 defines navigator as a non-writable getter on globalThis,
  // so we use Object.defineProperty to swap in a fake then restore the
  // descriptor afterwards. This avoids TypeError on plain assignment.
  function withPlatform<T>(platform: string, fn: () => T): T {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { platform, userAgent: platform },
    });
    try {
      return fn();
    } finally {
      if (desc) {
        Object.defineProperty(globalThis, 'navigator', desc);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).navigator;
      }
    }
  }

  it('returns open-palette on Cmd+K on Mac', () => {
    withPlatform('MacIntel', () => {
      expect(
        classifyShortcut({
          key: 'k',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        })
      ).toBe('open-palette');
    });
  });

  it('returns open-palette on Ctrl+K on non-Mac', () => {
    withPlatform('Win32', () => {
      expect(
        classifyShortcut({
          key: 'k',
          metaKey: false,
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
        })
      ).toBe('open-palette');
    });
  });

  it('returns null for Ctrl+K on Mac (browsers may use it)', () => {
    withPlatform('MacIntel', () => {
      expect(
        classifyShortcut({
          key: 'k',
          metaKey: false,
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
        })
      ).toBeNull();
    });
  });

  it('returns null for Cmd+K with Alt held (avoid stealing other shortcuts)', () => {
    withPlatform('MacIntel', () => {
      expect(
        classifyShortcut({
          key: 'k',
          metaKey: true,
          ctrlKey: false,
          altKey: true,
          shiftKey: false,
        })
      ).toBeNull();
    });
  });

  it('returns open-help on bare ?', () => {
    withPlatform('MacIntel', () => {
      expect(
        classifyShortcut({
          key: '?',
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: true, // ? is Shift+/
        })
      ).toBe('open-help');
    });
  });

  it('returns open-help on Shift+/ (alternate event.key path)', () => {
    expect(
      classifyShortcut({
        key: '/',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      })
    ).toBe('open-help');
  });

  it('returns null for ? with Cmd held (Cmd+? is something else)', () => {
    withPlatform('MacIntel', () => {
      expect(
        classifyShortcut({
          key: '?',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        })
      ).toBeNull();
    });
  });

  it('returns null for plain letter keys', () => {
    expect(
      classifyShortcut({
        key: 'a',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBeNull();
  });

  it('handles uppercase K (e.g. with Caps Lock)', () => {
    withPlatform('MacIntel', () => {
      expect(
        classifyShortcut({
          key: 'K',
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        })
      ).toBe('open-palette');
    });
  });
});

describe('isEditableTarget', () => {
  it('returns false for null', () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it('returns true for INPUT', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as Element)).toBe(true);
  });

  it('returns true for TEXTAREA', () => {
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as Element)).toBe(true);
  });

  it('returns true for SELECT', () => {
    expect(isEditableTarget({ tagName: 'SELECT' } as Element)).toBe(true);
  });

  it('returns true for contentEditable elements', () => {
    expect(
      isEditableTarget({
        tagName: 'DIV',
        isContentEditable: true,
      } as unknown as Element)
    ).toBe(true);
  });

  it('returns false for plain divs and buttons', () => {
    expect(isEditableTarget({ tagName: 'DIV' } as Element)).toBe(false);
    expect(isEditableTarget({ tagName: 'BUTTON' } as Element)).toBe(false);
    expect(isEditableTarget({ tagName: 'SPAN' } as Element)).toBe(false);
  });
});

describe('formatRelativeShort', () => {
  const now = new Date('2026-05-12T12:00:00Z').getTime();

  it('returns empty for null/undefined/invalid', () => {
    expect(formatRelativeShort(null, now)).toBe('');
    expect(formatRelativeShort(undefined, now)).toBe('');
    expect(formatRelativeShort('not-a-date', now)).toBe('');
  });

  it('returns "just now" for <60s differences', () => {
    const t = new Date(now - 10_000).toISOString();
    expect(formatRelativeShort(t, now)).toBe('just now');
  });

  it('returns "Nm ago" under an hour', () => {
    const t = new Date(now - 2 * 60_000).toISOString();
    expect(formatRelativeShort(t, now)).toBe('2m ago');
  });

  it('returns "Nh ago" under a day', () => {
    const t = new Date(now - 3 * 60 * 60_000).toISOString();
    expect(formatRelativeShort(t, now)).toBe('3h ago');
  });

  it('returns "Nd ago" over a day', () => {
    const t = new Date(now - 5 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeShort(t, now)).toBe('5d ago');
  });

  it('clamps future timestamps to "just now"', () => {
    const t = new Date(now + 30_000).toISOString();
    expect(formatRelativeShort(t, now)).toBe('just now');
  });
});
