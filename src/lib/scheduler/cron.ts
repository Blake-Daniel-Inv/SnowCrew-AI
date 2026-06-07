import { CronExpressionParser } from 'cron-parser';

/**
 * Thin, deliberately-narrow wrapper around `cron-parser` so the rest
 * of the codebase doesn't import the upstream symbol surface
 * directly. Three responsibilities:
 *
 *   1. Validate a cron expression without ever throwing — the API
 *      route's POST/PATCH paths need a yes/no answer plus a message.
 *   2. Compute the next fire time as a UTC Date, given an expression
 *      + IANA timezone + "after" cutoff. Returns null on parse error
 *      so callers don't have to wrap a try.
 *   3. Best-effort humanize a cron expression for the UI ("Every day
 *      at 9:00 AM"). The lookup covers the common five patterns; any
 *      expression that doesn't match falls back to "Custom schedule"
 *      rather than mis-rendering. We avoid a heavyweight i18n lib —
 *      this is a hint, not a contract.
 *
 * The function names exist as a stable surface for the daemon, the
 * REST validators, and the UI hint; cron-parser's own API evolves
 * across majors and we don't want to leak that drift outward.
 */

export interface CronValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a cron expression in a given timezone. Returns
 * `{ valid: false, error }` instead of throwing so the API route can
 * surface the parser's message to the user as a friendly
 * `invalid_cron` 400.
 */
export function parseCron(
  expr: string,
  timezone: string
): CronValidationResult {
  if (typeof expr !== 'string' || !expr.trim()) {
    return { valid: false, error: 'Cron expression is empty' };
  }
  if (typeof timezone !== 'string' || !timezone.trim()) {
    return { valid: false, error: 'Timezone is required' };
  }
  // cron-parser swallows unknown timezones silently (treats them as
  // UTC), which would let a typoed "Americ/New_York" slip into the DB
  // and silently fire at the wrong instant. Pre-validate via
  // Intl.DateTimeFormat — Node's ICU implementation throws on any
  // non-IANA zone name, which is exactly the gate we want here.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() });
  } catch {
    return { valid: false, error: `Unknown timezone: ${timezone}` };
  }
  try {
    CronExpressionParser.parse(expr.trim(), { tz: timezone.trim() });
    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }
}

/**
 * Compute the next fire time strictly AFTER `after`. cron-parser's
 * `currentDate` is exclusive — its iterator's `.next()` advances past
 * the cursor, which is exactly what we want for the daemon (no
 * double-firing of the just-fired minute).
 *
 * Returns null on any parse error so callers can short-circuit with
 * a single null check.
 */
export function nextFireTime(
  expr: string,
  timezone: string,
  after: Date
): Date | null {
  if (typeof expr !== 'string' || !expr.trim()) return null;
  if (typeof timezone !== 'string' || !timezone.trim()) return null;
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) return null;
  try {
    const it = CronExpressionParser.parse(expr.trim(), {
      tz: timezone,
      currentDate: after,
    });
    // cron-parser's CronDate has a `toDate()` method that returns a
    // plain JS Date in UTC. Coerce defensively in case a future major
    // changes the shape — `+date` works on both Date and CronDate.
    const next = it.next();
    const ms =
      typeof (next as { toDate?: () => Date }).toDate === 'function'
        ? (next as unknown as { toDate: () => Date }).toDate().getTime()
        : +(next as unknown as Date);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Humanization (best-effort)                                        */
/* ------------------------------------------------------------------ */

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function formatHour(h: number, m: number): string {
  const hh = ((h + 11) % 12) + 1;
  const mm = m.toString().padStart(2, '0');
  const ap = h < 12 ? 'AM' : 'PM';
  return `${hh}:${mm} ${ap}`;
}

/**
 * Render a cron expression as English prose, returning "Custom schedule"
 * for anything we don't explicitly recognize. Patterns covered:
 *
 *   * * * * *          → "Every minute"
 *   <min> * * * *      → "Every hour at <min> past"
 *   <min> <hr> * * *   → "Every day at <h:mm> <AM|PM>"
 *   <min> <hr> * * <d> → "Every <Day> at <h:mm> <AM|PM>"
 *   <min> <hr> <day> * *
 *                       → "On day <day> of each month at <h:mm> <AM|PM>"
 *
 * Multi-value lists (`1,15 9 * * *`) and step expressions
 * (`*\/15 * * * *`) collapse to "Custom schedule" — covering them
 * accurately is more code than this hint warrants. The UI shows the
 * raw expression alongside, so users with custom expressions still
 * have full information.
 */
export function humanizeCron(expr: string): string {
  if (typeof expr !== 'string' || !expr.trim()) return 'Custom schedule';
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return 'Custom schedule';
  const [min, hr, day, month, dow] = parts;

  // Helper: only treat numeric singletons as recognized.
  const isStar = (s: string) => s === '*';
  const asInt = (s: string): number | null => {
    if (!/^\d{1,2}$/.test(s)) return null;
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  };

  // * * * * * — every minute.
  if (isStar(min) && isStar(hr) && isStar(day) && isStar(month) && isStar(dow)) {
    return 'Every minute';
  }
  const minInt = asInt(min);
  const hrInt = asInt(hr);
  // <min> * * * * — every hour at <min> past.
  if (
    minInt != null &&
    isStar(hr) &&
    isStar(day) &&
    isStar(month) &&
    isStar(dow)
  ) {
    return `Every hour at ${minInt.toString().padStart(2, '0')} minutes past`;
  }
  // <min> <hr> ... — anything with a fixed hour-of-day.
  if (minInt != null && hrInt != null && isStar(month)) {
    const time = formatHour(hrInt, minInt);
    if (isStar(day) && isStar(dow)) return `Every day at ${time}`;
    const dowInt = asInt(dow);
    if (isStar(day) && dowInt != null && dowInt >= 0 && dowInt <= 6) {
      // cron-parser treats both 0 and 7 as Sunday; we only emit a
      // friendly name for the 0–6 canonical range.
      return `Every ${DAY_NAMES[dowInt]} at ${time}`;
    }
    const dayInt = asInt(day);
    if (dayInt != null && isStar(dow)) {
      return `On day ${dayInt} of each month at ${time}`;
    }
  }
  return 'Custom schedule';
}
