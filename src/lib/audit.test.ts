import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { listAuditEvents, writeAuditEvent } from './audit';

/**
 * Same setup as schedules-db.test.ts: stub the runs-db singleton with
 * an in-memory handle that has the audit_log table. We don't import
 * runs-db's migrations because they'd try to migrate legacy JSON.
 */
type GlobalWithDb = typeof globalThis & {
  __runsDb?: DatabaseType;
  __runsStmts?: unknown;
};
const g = globalThis as GlobalWithDb;

function freshDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_log (
      id              TEXT PRIMARY KEY,
      ts              INTEGER NOT NULL,
      actor_owner_id  TEXT,
      action          TEXT NOT NULL,
      target_type     TEXT,
      target_id       TEXT,
      metadata        TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_audit_log_owner_ts ON audit_log(actor_owner_id, ts);
  `);
  return db;
}

beforeEach(() => {
  g.__runsDb = freshDb();
  g.__runsStmts = undefined;
});

afterEach(() => {
  g.__runsDb?.close();
  g.__runsDb = undefined;
  g.__runsStmts = undefined;
});

describe('writeAuditEvent', () => {
  it('roundtrips a basic event through insert/query', () => {
    writeAuditEvent({
      ownerId: 'user-a',
      action: 'credential.connected',
      targetType: 'credential',
      targetId: 'github:42',
      metadata: { provider: 'github', accountLogin: 'octocat' },
    });

    const events = listAuditEvents({ ownerId: 'user-a' });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('credential.connected');
    expect(events[0].targetType).toBe('credential');
    expect(events[0].targetId).toBe('github:42');
    expect(events[0].metadata).toEqual({
      provider: 'github',
      accountLogin: 'octocat',
    });
    expect(events[0].ts).toBeGreaterThan(0);
    expect(typeof events[0].id).toBe('string');
  });

  it('does not leak across owners', () => {
    writeAuditEvent({ ownerId: 'user-a', action: 'schedule.created' });
    writeAuditEvent({ ownerId: 'user-b', action: 'schedule.created' });
    writeAuditEvent({ ownerId: 'user-a', action: 'schedule.deleted' });

    const a = listAuditEvents({ ownerId: 'user-a' });
    expect(a).toHaveLength(2);
    expect(a.every((e) => e.actorOwnerId === 'user-a')).toBe(true);

    const b = listAuditEvents({ ownerId: 'user-b' });
    expect(b).toHaveLength(1);
    expect(b[0].action).toBe('schedule.created');
  });

  it('accepts ownerId=null for system actions', () => {
    writeAuditEvent({
      ownerId: null,
      action: 'schedule.fired',
      metadata: { runId: 'run-1' },
    });
    const all = listAuditEvents({});
    expect(all).toHaveLength(1);
    expect(all[0].actorOwnerId).toBeNull();
  });

  it('coerces non-object metadata to {} without throwing', () => {
    writeAuditEvent({
      ownerId: 'user-a',
      action: 'credential.disconnected',
      // @ts-expect-error — exercising a contract violation deliberately.
      metadata: 'not-an-object',
    });
    const events = listAuditEvents({ ownerId: 'user-a' });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({});
  });

  it('rejects empty action without throwing', () => {
    writeAuditEvent({ ownerId: 'user-a', action: '' });
    writeAuditEvent({ ownerId: 'user-a', action: '   ' });
    const events = listAuditEvents({ ownerId: 'user-a' });
    expect(events).toHaveLength(0);
  });

  it('never throws on DB failure (audit is best-effort)', () => {
    // Drop the table so the INSERT inside writeAuditEvent fails.
    g.__runsDb!.exec('DROP TABLE audit_log');
    expect(() =>
      writeAuditEvent({ ownerId: 'user-a', action: 'schedule.created' })
    ).not.toThrow();
  });

  it('exposes NO delete API (append-only contract)', async () => {
    const audit = await import('./audit');
    // The module surface must not include any delete export. If a
    // future change adds one, this test fails loudly.
    expect(Object.keys(audit)).toEqual(
      expect.arrayContaining(['writeAuditEvent', 'listAuditEvents'])
    );
    for (const key of Object.keys(audit)) {
      expect(key.toLowerCase()).not.toContain('delete');
      expect(key.toLowerCase()).not.toContain('remove');
    }
  });
});

describe('listAuditEvents filters', () => {
  beforeEach(() => {
    writeAuditEvent({ ownerId: 'user-a', action: 'credential.connected' });
    writeAuditEvent({ ownerId: 'user-a', action: 'schedule.created' });
    writeAuditEvent({ ownerId: 'user-a', action: 'schedule.fired' });
    writeAuditEvent({ ownerId: 'user-b', action: 'schedule.created' });
  });

  it('filters by action', () => {
    const events = listAuditEvents({ action: 'schedule.created' });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.action === 'schedule.created')).toBe(true);
  });

  it('filters by owner AND action together', () => {
    const events = listAuditEvents({
      ownerId: 'user-a',
      action: 'schedule.created',
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorOwnerId).toBe('user-a');
  });

  it('returns events newest-first by ts', () => {
    const events = listAuditEvents({ ownerId: 'user-a' });
    expect(events).toHaveLength(3);
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].ts).toBeGreaterThanOrEqual(events[i].ts);
    }
  });
});
