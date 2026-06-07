/**
 * Theme catalog. Each entry maps to a `html[data-theme-id='<id>']`
 * block in globals.css that supplies the full set of CSS custom
 * properties. The `mode` flag is read by `data-theme-mode` so any
 * selector that needs to broadly target dark vs light still can.
 *
 * Keep this file in sync with globals.css.
 */

export type ThemeMode = 'dark' | 'light';

export interface ThemeOption {
  id: string;
  label: string;
  mode: ThemeMode;
  /** Three small swatches for the picker (bg-2, panel, accent). */
  swatches: [string, string, string];
}

export const THEMES: ThemeOption[] = [
  {
    id: 'midnight',
    label: 'Midnight',
    mode: 'dark',
    swatches: ['#0b1220', '#0f1729', '#3b82f6'],
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    mode: 'dark',
    swatches: ['#1a1b26', '#24283b', '#7aa2f7'],
  },
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    swatches: ['#282a36', '#44475a', '#bd93f9'],
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    mode: 'dark',
    swatches: ['#0d1117', '#161b22', '#58a6ff'],
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    mode: 'light',
    swatches: ['#f6f8fa', '#ffffff', '#0969da'],
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    mode: 'light',
    swatches: ['#fdf6e3', '#eee8d5', '#268bd2'],
  },
  {
    id: 'one-light',
    label: 'One Light',
    mode: 'light',
    swatches: ['#fafafa', '#f0f0f1', '#a626a4'],
  },
];

export const DEFAULT_THEME_ID = 'midnight';
export const THEME_STORAGE_KEY = 'crewai-studio-theme-id';
export const LEGACY_THEME_STORAGE_KEY = 'crewai-studio-theme';

export function getThemeById(id: string | null | undefined): ThemeOption {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/**
 * Read the persisted theme id, migrating the legacy `'dark'`/`'light'`
 * key if present. Safe in SSR — returns the default when window is
 * unavailable.
 */
export function readStoredThemeId(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID;
  const current = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (current && THEMES.some((t) => t.id === current)) return current;

  const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (legacy === 'light') {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'github-light');
    return 'github-light';
  }
  if (legacy === 'dark') {
    window.localStorage.setItem(THEME_STORAGE_KEY, DEFAULT_THEME_ID);
    return DEFAULT_THEME_ID;
  }
  return DEFAULT_THEME_ID;
}
