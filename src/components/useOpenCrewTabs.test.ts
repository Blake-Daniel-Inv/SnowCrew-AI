// PR 24 — Pure-function tests for the four exported helpers backing
// useOpenCrewTabs. We don't render the hook (no jsdom in this repo);
// instead we exercise the deterministic surface that the hook
// composes. Persistence is verified via a minimal in-memory
// localStorage shim attached to the global object — exactly how the
// surrounding usePaneSizes / useUserCredentials tests would do it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewStudioCrew } from '@/types';
import {
  applyCloseTab,
  applyOpenTab,
  applySelectTab,
  loadPersistedTabs,
} from './useOpenCrewTabs';

// ----- Test helpers ----- //

function makeCrew(id: string, name = id): CrewStudioCrew {
  return {
    id,
    name,
    description: '',
    process: 'sequential',
    agentIds: [],
    taskIds: [],
    managerAgentId: null,
    memory: false,
    planning: false,
    verbose: false,
    tags: [],
  };
}

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
  get length(): number {
    return this.data.size;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  key(_: number): string | null {
    return null;
  }
}

const originalWindow = globalThis.window;

beforeEach(() => {
  const storage = new MemoryStorage();
  // Minimal `window` shim so the hook's `typeof window !== 'undefined'`
  // guards take the populated branch under Node.
  (globalThis as unknown as { window: { localStorage: MemoryStorage } }).window = {
    localStorage: storage,
  };
});

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window: typeof originalWindow }).window = originalWindow;
  }
});

// ----- loadPersistedTabs ----- //

describe('useOpenCrewTabs — loadPersistedTabs', () => {
  it('returns empty state when workspaceId is null', () => {
    const state = loadPersistedTabs(null, []);
    expect(state).toEqual({ openTabs: [], activeCrewId: null });
  });

  it('seeds with the first crew when nothing is persisted and crews exist', () => {
    const crews = [makeCrew('crew-a'), makeCrew('crew-b')];
    const state = loadPersistedTabs('ws-1', crews);
    expect(state).toEqual({ openTabs: ['crew-a'], activeCrewId: 'crew-a' });
  });

  it('returns empty state when nothing is persisted and no crews exist', () => {
    const state = loadPersistedTabs('ws-1', []);
    expect(state).toEqual({ openTabs: [], activeCrewId: null });
  });

  it('roundtrips: persisted state with present ids is restored verbatim', () => {
    const crews = [makeCrew('crew-a'), makeCrew('crew-b'), makeCrew('crew-c')];
    window.localStorage.setItem(
      'snowcrew.openCrewTabs.ws-1',
      JSON.stringify({ openTabs: ['crew-b', 'crew-c'], activeCrewId: 'crew-c' })
    );
    const state = loadPersistedTabs('ws-1', crews);
    expect(state.openTabs).toEqual(['crew-b', 'crew-c']);
    expect(state.activeCrewId).toBe('crew-c');
  });

  it('filters ghost crew ids on reload (deleted between sessions)', () => {
    const crews = [makeCrew('crew-a'), makeCrew('crew-b')];
    window.localStorage.setItem(
      'snowcrew.openCrewTabs.ws-1',
      JSON.stringify({ openTabs: ['crew-b', 'crew-zombie'], activeCrewId: 'crew-zombie' })
    );
    const state = loadPersistedTabs('ws-1', crews);
    expect(state.openTabs).toEqual(['crew-b']);
    // Active was the ghost — fall back to the first remaining tab.
    expect(state.activeCrewId).toBe('crew-b');
  });

  it('seeds with first crew when filtering leaves the list empty', () => {
    const crews = [makeCrew('crew-a'), makeCrew('crew-b')];
    window.localStorage.setItem(
      'snowcrew.openCrewTabs.ws-1',
      JSON.stringify({ openTabs: ['crew-zombie-1', 'crew-zombie-2'], activeCrewId: 'crew-zombie-1' })
    );
    const state = loadPersistedTabs('ws-1', crews);
    expect(state).toEqual({ openTabs: ['crew-a'], activeCrewId: 'crew-a' });
  });

  it('treats corrupt JSON as nothing persisted', () => {
    const crews = [makeCrew('crew-a')];
    window.localStorage.setItem('snowcrew.openCrewTabs.ws-1', '{not json');
    const state = loadPersistedTabs('ws-1', crews);
    expect(state).toEqual({ openTabs: ['crew-a'], activeCrewId: 'crew-a' });
  });

  it('falls back to first tab when persisted activeCrewId is missing from openTabs', () => {
    const crews = [makeCrew('crew-a'), makeCrew('crew-b')];
    window.localStorage.setItem(
      'snowcrew.openCrewTabs.ws-1',
      JSON.stringify({ openTabs: ['crew-a', 'crew-b'], activeCrewId: null })
    );
    const state = loadPersistedTabs('ws-1', crews);
    expect(state.activeCrewId).toBe('crew-a');
  });

  it('throws no error when localStorage.getItem throws (denied / sandbox)', () => {
    const denied = {
      getItem: vi.fn(() => {
        throw new Error('SecurityError: localStorage denied');
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: () => null,
    };
    (globalThis as unknown as { window: { localStorage: typeof denied } }).window = {
      localStorage: denied,
    };
    const crews = [makeCrew('crew-a')];
    const state = loadPersistedTabs('ws-1', crews);
    expect(state).toEqual({ openTabs: ['crew-a'], activeCrewId: 'crew-a' });
  });
});

// ----- applyOpenTab ----- //

describe('useOpenCrewTabs — applyOpenTab', () => {
  it('appends and activates a brand-new tab', () => {
    const state = { openTabs: ['crew-a'], activeCrewId: 'crew-a' };
    const next = applyOpenTab(state, 'crew-b');
    expect(next.openTabs).toEqual(['crew-a', 'crew-b']);
    expect(next.activeCrewId).toBe('crew-b');
  });

  it('activates an already-open tab without duplicating it', () => {
    const state = { openTabs: ['crew-a', 'crew-b'], activeCrewId: 'crew-a' };
    const next = applyOpenTab(state, 'crew-b');
    expect(next.openTabs).toEqual(['crew-a', 'crew-b']);
    expect(next.activeCrewId).toBe('crew-b');
  });

  it('is a no-op when the tab is already open AND already active', () => {
    const state = { openTabs: ['crew-a'], activeCrewId: 'crew-a' };
    const next = applyOpenTab(state, 'crew-a');
    expect(next).toBe(state);
  });
});

// ----- applyCloseTab ----- //

describe('useOpenCrewTabs — applyCloseTab', () => {
  it('removes the tab without changing active when closing an inactive tab', () => {
    const state = {
      openTabs: ['crew-a', 'crew-b', 'crew-c'],
      activeCrewId: 'crew-b',
    };
    const next = applyCloseTab(state, 'crew-a');
    expect(next.openTabs).toEqual(['crew-b', 'crew-c']);
    expect(next.activeCrewId).toBe('crew-b');
  });

  it('closing the active tab activates the previous tab', () => {
    const state = {
      openTabs: ['crew-a', 'crew-b', 'crew-c'],
      activeCrewId: 'crew-b',
    };
    const next = applyCloseTab(state, 'crew-b');
    expect(next.openTabs).toEqual(['crew-a', 'crew-c']);
    expect(next.activeCrewId).toBe('crew-a');
  });

  it('closing the active first tab activates the next tab', () => {
    const state = {
      openTabs: ['crew-a', 'crew-b'],
      activeCrewId: 'crew-a',
    };
    const next = applyCloseTab(state, 'crew-a');
    expect(next.openTabs).toEqual(['crew-b']);
    expect(next.activeCrewId).toBe('crew-b');
  });

  it('closing the only tab leaves activeCrewId null', () => {
    const state = { openTabs: ['crew-a'], activeCrewId: 'crew-a' };
    const next = applyCloseTab(state, 'crew-a');
    expect(next).toEqual({ openTabs: [], activeCrewId: null });
  });

  it('is a no-op when the crewId is not in openTabs', () => {
    const state = { openTabs: ['crew-a'], activeCrewId: 'crew-a' };
    const next = applyCloseTab(state, 'crew-other');
    expect(next).toBe(state);
  });
});

// ----- applySelectTab ----- //

describe('useOpenCrewTabs — applySelectTab', () => {
  it('sets activeCrewId when the tab is already open', () => {
    const state = { openTabs: ['crew-a', 'crew-b'], activeCrewId: 'crew-a' };
    const next = applySelectTab(state, 'crew-b');
    expect(next.activeCrewId).toBe('crew-b');
    expect(next.openTabs).toEqual(['crew-a', 'crew-b']);
  });

  it('implicitly opens a tab when crewId is not already in openTabs', () => {
    // This is the "Open target crew →" cross-navigation path.
    const state = { openTabs: ['crew-a'], activeCrewId: 'crew-a' };
    const next = applySelectTab(state, 'crew-other');
    expect(next.openTabs).toEqual(['crew-a', 'crew-other']);
    expect(next.activeCrewId).toBe('crew-other');
  });

  it('is a no-op when crewId is already active', () => {
    const state = { openTabs: ['crew-a'], activeCrewId: 'crew-a' };
    const next = applySelectTab(state, 'crew-a');
    expect(next).toBe(state);
  });
});
