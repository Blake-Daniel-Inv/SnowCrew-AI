'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { THEMES, getThemeById, type ThemeOption } from '@/lib/themes';

/**
 * Bottom-left dropdown that lets the user pick from the theme catalog.
 * Anchored absolutely inside the canvas area so it sits next to the
 * ReactFlow Controls and doesn't crowd the toolbar.
 */
export function ThemePicker({
  currentThemeId,
  onSelect,
}: {
  currentThemeId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const current = getThemeById(currentThemeId);

  // Themes in display order (Dark group then Light group) so the active
  // descendant index lines up with what the user sees.
  const ordered = useMemo<ThemeOption[]>(() => {
    return [
      ...THEMES.filter((t) => t.mode === 'dark'),
      ...THEMES.filter((t) => t.mode === 'light'),
    ];
  }, []);

  const initialActiveIndex = Math.max(0, ordered.findIndex((t) => t.id === current.id));
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);

  // Reset the active descendant to the current theme each time the
  // popover opens so screen readers announce the right starting point.
  function toggleOpen() {
    setOpen((prev) => {
      if (!prev) setActiveIndex(Math.max(0, ordered.findIndex((t) => t.id === current.id)));
      return !prev;
    });
  }

  // Move focus to the listbox when it opens so arrow keys work
  // immediately without an extra tab-stop.
  useEffect(() => {
    if (open) listboxRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function commit(theme: ThemeOption) {
    onSelect(theme.id);
    setOpen(false);
  }

  function onListboxKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(ordered.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(ordered.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const theme = ordered[activeIndex];
      if (theme) commit(theme);
    }
  }

  const dark = ordered.filter((t) => t.mode === 'dark');
  const light = ordered.filter((t) => t.mode === 'light');
  const activeId = ordered[activeIndex]?.id || current.id;

  return (
    <div ref={wrapperRef} className="theme-picker">
      <button
        type="button"
        className="theme-picker-trigger"
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Theme: ${current.label}`}
      >
        <ThemeSwatchTrio swatches={current.swatches} />
        <span className="theme-picker-trigger-label">{current.label}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      {open && (
        <div
          ref={listboxRef}
          className="theme-picker-popover"
          role="listbox"
          aria-label="Theme"
          tabIndex={0}
          aria-activedescendant={`theme-picker-option-${activeId}`}
          onKeyDown={onListboxKeyDown}
        >
          <div className="theme-picker-header">Theme</div>
          <ThemeGroup
            label="Dark"
            themes={dark}
            currentId={current.id}
            activeId={activeId}
            onSelect={commit}
          />
          <ThemeGroup
            label="Light"
            themes={light}
            currentId={current.id}
            activeId={activeId}
            onSelect={commit}
          />
        </div>
      )}
    </div>
  );
}

function ThemeGroup({
  label,
  themes,
  currentId,
  activeId,
  onSelect,
}: {
  label: string;
  themes: ThemeOption[];
  currentId: string;
  activeId: string;
  onSelect: (theme: ThemeOption) => void;
}) {
  return (
    <div className="theme-picker-group">
      <div className="theme-picker-group-label">{label}</div>
      {themes.map((theme) => (
        <button
          key={theme.id}
          id={`theme-picker-option-${theme.id}`}
          type="button"
          className={`theme-picker-row ${theme.id === currentId ? 'is-selected' : ''} ${theme.id === activeId ? 'is-active' : ''}`}
          onClick={() => onSelect(theme)}
          role="option"
          aria-selected={theme.id === currentId}
          tabIndex={-1}
        >
          <ThemeSwatchTrio swatches={theme.swatches} />
          <span className="theme-picker-row-label">{theme.label}</span>
          {theme.id === currentId && (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="theme-picker-row-check"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}

function ThemeSwatchTrio({ swatches }: { swatches: [string, string, string] }) {
  return (
    <span className="theme-swatch-trio" aria-hidden="true">
      {swatches.map((color, i) => (
        <span key={i} className="theme-swatch" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}
