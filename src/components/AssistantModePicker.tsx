'use client';

import { useEffect, useRef, useState } from 'react';

export type AssistantMode = 'auto' | 'sonnet' | 'opus';

const OPTIONS: Array<{ value: AssistantMode; label: string; hint: string }> = [
  { value: 'auto',   label: 'Auto',   hint: 'Pick Sonnet or Opus based on prompt + workspace size' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Faster, cheaper — best for small edits' },
  { value: 'opus',   label: 'Opus',   hint: 'Slower, more capable — best for complex builds' },
];

function labelFor(mode: AssistantMode): string {
  return OPTIONS.find((o) => o.value === mode)?.label || 'Auto';
}

/**
 * Compact dropdown for the Workflow Assistant's model tier (Cortex
 * Code-style). Sits inline next to the send button. Opens upward
 * because it lives at the bottom of the assistant panel.
 */
export function AssistantModePicker({
  mode,
  onChange,
  disabled,
}: {
  mode: AssistantMode;
  onChange: (mode: AssistantMode) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const initialIndex = Math.max(0, OPTIONS.findIndex((o) => o.value === mode));
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  function toggleOpen() {
    setOpen((prev) => {
      if (!prev) setActiveIndex(Math.max(0, OPTIONS.findIndex((o) => o.value === mode)));
      return !prev;
    });
  }

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

  function commit(value: AssistantMode) {
    onChange(value);
    setOpen(false);
  }

  function onListboxKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => Math.min(OPTIONS.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(OPTIONS.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const opt = OPTIONS[activeIndex];
      if (opt) commit(opt.value);
    }
  }

  const activeValue = OPTIONS[activeIndex]?.value || mode;

  return (
    <div ref={wrapperRef} className="assistant-mode-picker">
      <button
        type="button"
        className="assistant-mode-trigger"
        onClick={toggleOpen}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{labelFor(mode)}</span>
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
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          ref={listboxRef}
          className="assistant-mode-popover"
          role="listbox"
          aria-label="Workflow assistant model"
          tabIndex={0}
          aria-activedescendant={`assistant-mode-option-${activeValue}`}
          onKeyDown={onListboxKeyDown}
        >
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              id={`assistant-mode-option-${opt.value}`}
              type="button"
              role="option"
              aria-selected={mode === opt.value}
              tabIndex={-1}
              className={`assistant-mode-option ${mode === opt.value ? 'is-active' : ''} ${activeValue === opt.value ? 'is-focused' : ''}`}
              onClick={() => commit(opt.value)}
            >
              <span className="assistant-mode-option-label">{opt.label}</span>
              <span className="assistant-mode-option-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
