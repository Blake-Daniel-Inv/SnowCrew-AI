'use client';

/**
 * Tiny render helpers for inline character counters and regex pattern
 * hints. Extracted from NodeConfigPanel so the Field helper extension
 * stays narrow: one new prop block + two lines per render to call
 * these. Pure-function classifier + format helpers live below the
 * components so they can be unit-tested without jsdom.
 */

export type CounterTone = 'muted' | 'warn' | 'error';

/**
 * Map (current length, cap) onto one of three tones.
 *
 *   < 75%      muted   (no color signal — just informational)
 *   75-94%     warn    (amber — heads-up that you're approaching cap)
 *   >= 95%     error   (red — over-cap or about-to-be over-cap; the
 *                       Zod schema will reject at exactly cap+1)
 *
 * Edge cases: cap <= 0 yields 'muted' (treat as "no counter"). A
 * negative current is treated as 0.
 */
export function classifyCounterTone(current: number, max: number): CounterTone {
  if (!Number.isFinite(max) || max <= 0) return 'muted';
  const cur = Math.max(0, current);
  const ratio = cur / max;
  if (ratio >= 0.95) return 'error';
  if (ratio >= 0.75) return 'warn';
  return 'muted';
}

/** True when the value is strictly over the cap. */
export function isOverLimit(current: number, max: number): boolean {
  return Number.isFinite(max) && max > 0 && current > max;
}

/**
 * Whether a regex hint is currently in an error state for the given
 * value. Blank values are always allowed (the underlying patterns use
 * `^$|...` to encode "leave blank to use default"); we keep that
 * convention in the UI hint by short-circuiting the empty case.
 */
export function isPatternInvalid(value: string, pattern: RegExp | undefined): boolean {
  if (!pattern) return false;
  if (value === '') return false;
  return !pattern.test(value);
}

export function FieldCounter({
  current,
  max,
}: {
  current: number;
  max: number;
}) {
  const tone = classifyCounterTone(current, max);
  const over = isOverLimit(current, max);
  const className =
    tone === 'error'
      ? 'config-field-counter config-field-counter-error'
      : tone === 'warn'
        ? 'config-field-counter config-field-counter-warn'
        : 'config-field-counter';
  // aria-live='polite' only matters once we hit the error tone;
  // adding it everywhere would announce every keystroke. Keep the
  // attribute always present so screen readers track the live region
  // for the same node, but the announcement only triggers when the
  // tone (and therefore text) actually changes meaningfully.
  return (
    <span
      className={className}
      aria-live="polite"
      aria-atomic="true"
    >
      {current.toLocaleString()} / {max.toLocaleString()}
      {over && (
        <span aria-hidden="false">
          {' · '}
          {(current - max).toLocaleString()} chars over limit
        </span>
      )}
    </span>
  );
}
