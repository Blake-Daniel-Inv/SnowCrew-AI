import { randomUUID } from 'node:crypto';
import { getRunsDb } from './runs-db';
import { logger as rootLogger } from './logger';

/**
 * Append-only audit log for high-value mutations.
 *
 * The contract that makes this useful for HIPAA-style reviews:
 *   - Every successful state change at a sensitive site writes a row.
 *   - Rows are append-only: there is no exported deleteAuditEvent, no
 *     route handler exposes DELETE, and `metadata` is a JSON blob the
 *     caller hands us (no nested mutation API).
 *   - Failures here MUST NEVER throw — audit is best-effort, and an
 *     audit-DB hiccup must not roll back the originating mutation.
 *     We log the failure to pino at error level and continue.
 *
 * Wired in PR 33 to:
 *   - credential.connected / credential.disconnected
 *   - schedule.created / schedule.updated / schedule.deleted / schedule.fired
 *   - email.sent
 *
 * The action string is intentionally NOT a TS union: enumerating it
 * would push every new wiring site through this file and create churn.
 * Pino-grep + the runbook table in docs/OPERATIONS.md is the
 * authoritative inventory.
 */

const log = rootLogger.child({ module: 'audit' });

export interface AuditEventInput {
  /**
   * Caller's owner id (the authenticated user). `null` is allowed for
   * system-internal actions (e.g., a scheduler-triggered fire where
   * the daemon acts on a user's behalf without a request context); use
   * sparingly and prefer passing the schedule's owner_id when known.
   */
  ownerId: string | null;
  /**
   * Short dotted-namespace action. Conventions:
   *   - lowercase, dot-separated
   *   - subject.past-tense-verb, e.g. `credential.connected`
   */
  action: string;
  /** Optional category for the target (`credential`, `schedule`, etc.). */
  targetType?: string;
  /** Optional id of the target row. */
  targetId?: string;
  /**
   * Free-form key/value blob persisted as JSON. MUST be a plain object;
   * arrays/strings/numbers are rejected (logged + dropped) to keep the
   * column shape consistent for downstream querying.
   *
   * IMPORTANT: do not put sensitive material here. The metadata column
   * is NOT scrubbed by the pino redact list since it's persisted as a
   * stringified blob; treat it as plaintext in the DB.
   */
  metadata?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  // Array.isArray covers arrays; Object.getPrototypeOf catches Map / Date / etc.
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Write a single audit event. Synchronous, never throws.
 *
 * The DB write is a single INSERT; we don't wrap in a transaction
 * because there's nothing to atomically combine — the caller has
 * already committed the originating mutation by the time we're called.
 *
 * Returns void (and never throws) so the calling code can fire-and-forget:
 *
 *   await deleteCredential(ownerId, 'github');
 *   writeAuditEvent({ ownerId, action: 'credential.disconnected', ... });
 */
export function writeAuditEvent(input: AuditEventInput): void {
  try {
    const action = input.action?.trim();
    if (!action) {
      log.warn({ input }, 'writeAuditEvent: missing action; skipping');
      return;
    }

    let metadataJson = '{}';
    if (input.metadata !== undefined) {
      if (!isPlainObject(input.metadata)) {
        log.warn(
          { action, metadataType: typeof input.metadata },
          'writeAuditEvent: metadata is not a plain object; coercing to {}'
        );
      } else {
        try {
          metadataJson = JSON.stringify(input.metadata);
        } catch (err) {
          log.warn(
            { action, err: err instanceof Error ? err.message : String(err) },
            'writeAuditEvent: metadata JSON.stringify failed; coercing to {}'
          );
          metadataJson = '{}';
        }
      }
    }

    const db = getRunsDb();
    db.prepare(
      `INSERT INTO audit_log
         (id, ts, actor_owner_id, action, target_type, target_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      Date.now(),
      input.ownerId ?? null,
      action,
      input.targetType ?? null,
      input.targetId ?? null,
      metadataJson
    );
  } catch (err) {
    // Audit failures MUST NOT break the originating mutation. Log at
    // error so the operator can grep for "audit write failed" if the
    // table is corrupted, then move on.
    log.error(
      {
        action: input.action,
        err: err instanceof Error ? err.message : String(err),
      },
      'audit write failed (suppressed)'
    );
  }
}

/**
 * Read API exposed for tests and internal inspection only. Filters by
 * owner_id when provided so the per-user view in the runbook is
 * trivial to drive from a Node REPL. NOT wired to any HTTP route.
 */
export function listAuditEvents(opts: {
  ownerId?: string;
  action?: string;
  limit?: number;
} = {}): Array<{
  id: string;
  ts: number;
  actorOwnerId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}> {
  const limit = Math.max(1, Math.min(1_000, opts.limit ?? 100));
  const db = getRunsDb();
  let rows: Array<{
    id: string;
    ts: number;
    actor_owner_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    metadata: string;
  }>;
  if (opts.ownerId && opts.action) {
    rows = db
      .prepare(
        `SELECT * FROM audit_log
         WHERE actor_owner_id = ? AND action = ?
         ORDER BY ts DESC LIMIT ?`
      )
      .all(opts.ownerId, opts.action, limit) as typeof rows;
  } else if (opts.ownerId) {
    rows = db
      .prepare(
        `SELECT * FROM audit_log
         WHERE actor_owner_id = ?
         ORDER BY ts DESC LIMIT ?`
      )
      .all(opts.ownerId, limit) as typeof rows;
  } else if (opts.action) {
    rows = db
      .prepare(
        `SELECT * FROM audit_log
         WHERE action = ?
         ORDER BY ts DESC LIMIT ?`
      )
      .all(opts.action, limit) as typeof rows;
  } else {
    rows = db
      .prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`)
      .all(limit) as typeof rows;
  }
  return rows.map((row) => {
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (isPlainObject(parsed)) meta = parsed;
    } catch {
      // Drop unparseable metadata to {} rather than throwing — the
      // audit log should be readable even with a corrupt row.
    }
    return {
      id: row.id,
      ts: row.ts,
      actorOwnerId: row.actor_owner_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: meta,
    };
  });
}
