import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

/**
 * PR 12: focused regression test for the user_credentials.metadata
 * migration. The full runs-db init path is exercised end-to-end by
 * the existing credentials-db test, but that suite bypasses the
 * migration by injecting a hand-rolled schema. This file proves the
 * migration step itself is idempotent — a hard constraint of PR 12.
 *
 * We replicate the guarded ALTER TABLE pattern verbatim from
 * `applyMigrations` and run it twice on a "pre-PR-12" schema. The
 * second pass must be a no-op.
 */
function applyMetadataMigration(db: Database.Database): void {
  const credCols = db
    .prepare(`PRAGMA table_info(user_credentials)`)
    .all() as Array<{ name: string }>;
  if (!credCols.some((c) => c.name === 'metadata')) {
    db.exec(
      `ALTER TABLE user_credentials ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`
    );
  }
}

function createPrePr12Schema(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Pre-PR-12 user_credentials shape — no metadata column.
  db.exec(`
    CREATE TABLE user_credentials (
      id                TEXT PRIMARY KEY,
      owner_id          TEXT NOT NULL,
      provider          TEXT NOT NULL,
      account_login     TEXT,
      account_id        TEXT,
      scopes            TEXT NOT NULL DEFAULT '[]',
      ciphertext        TEXT NOT NULL,
      iv                TEXT NOT NULL,
      auth_tag          TEXT NOT NULL,
      data_key_wrapped  TEXT NOT NULL,
      connected_at      INTEGER NOT NULL,
      last_used_at      INTEGER,
      expires_at        INTEGER,
      UNIQUE(owner_id, provider)
    );
  `);
  return db;
}

describe('user_credentials.metadata migration', () => {
  it('adds the metadata column on a pre-PR-12 schema', () => {
    const db = createPrePr12Schema();
    try {
      // Pre-migration: column absent.
      const before = db
        .prepare(`PRAGMA table_info(user_credentials)`)
        .all() as Array<{ name: string }>;
      expect(before.some((c) => c.name === 'metadata')).toBe(false);

      applyMetadataMigration(db);

      // Post-migration: column present.
      const after = db
        .prepare(`PRAGMA table_info(user_credentials)`)
        .all() as Array<{ name: string }>;
      const meta = after.find((c) => c.name === 'metadata');
      expect(meta).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('is idempotent — running the migration twice is a no-op', () => {
    const db = createPrePr12Schema();
    try {
      // Seed a row so we can confirm it survives the second pass.
      db.prepare(
        `INSERT INTO user_credentials
           (id, owner_id, provider, account_login, account_id, scopes,
            ciphertext, iv, auth_tag, data_key_wrapped,
            connected_at, last_used_at, expires_at)
         VALUES ('id1', 'user-a', 'github', 'octocat', '42', '[]',
                 'c', 'i', 'a', 'k', 1000, null, null)`
      ).run();

      applyMetadataMigration(db);
      // The first migration backfills existing rows to the default '{}'.
      const firstPass = db
        .prepare(`SELECT metadata FROM user_credentials WHERE id = 'id1'`)
        .get() as { metadata: string };
      expect(firstPass.metadata).toBe('{}');

      // Second pass: the guard MUST short-circuit. We assert it
      // (a) does not throw, (b) does not change the row, (c) does
      // not add a second metadata column.
      applyMetadataMigration(db);

      const colsAfter2 = db
        .prepare(`PRAGMA table_info(user_credentials)`)
        .all() as Array<{ name: string }>;
      const metadataCount = colsAfter2.filter(
        (c) => c.name === 'metadata'
      ).length;
      expect(metadataCount).toBe(1);

      const secondPass = db
        .prepare(`SELECT metadata FROM user_credentials WHERE id = 'id1'`)
        .get() as { metadata: string };
      expect(secondPass.metadata).toBe('{}');
    } finally {
      db.close();
    }
  });

  it('preserves caller-written metadata across a re-run of the migration', () => {
    const db = createPrePr12Schema();
    try {
      applyMetadataMigration(db);
      // Insert with a non-default metadata blob.
      db.prepare(
        `INSERT INTO user_credentials
           (id, owner_id, provider, account_login, account_id, scopes,
            ciphertext, iv, auth_tag, data_key_wrapped,
            connected_at, last_used_at, expires_at, metadata)
         VALUES ('id1', 'user-a', 'github', 'octocat', '42', '[]',
                 'c', 'i', 'a', 'k', 1000, null, null,
                 '{"organizations":[{"login":"acme","id":1,"description":null,"avatarUrl":null}]}')`
      ).run();

      // Re-run; existing data must not be clobbered.
      applyMetadataMigration(db);

      const row = db
        .prepare(`SELECT metadata FROM user_credentials WHERE id = 'id1'`)
        .get() as { metadata: string };
      const parsed = JSON.parse(row.metadata) as {
        organizations: Array<{ login: string }>;
      };
      expect(parsed.organizations[0].login).toBe('acme');
    } finally {
      db.close();
    }
  });
});


// =============================================================
// PR γ — events.metadata migration
// =============================================================

function applyEventsMetadataMigration(db: Database.Database): void {
  const eventCols = db
    .prepare(`PRAGMA table_info(events)`)
    .all() as Array<{ name: string }>;
  if (!eventCols.some((c) => c.name === 'metadata')) {
    db.exec(
      `ALTER TABLE events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`
    );
  }
}

function createPrePrGammaEventsSchema(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Stand-alone parent table so the FK on events resolves; we don't
  // exercise it in these tests.
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY
    );
    INSERT INTO runs (id) VALUES ('r1');
  `);
  // Pre-PR-γ events shape — no metadata column.
  db.exec(`
    CREATE TABLE events (
      run_id     TEXT NOT NULL,
      sequence   INTEGER NOT NULL,
      id         TEXT NOT NULL,
      timestamp  TEXT NOT NULL,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      detail     TEXT,
      task_name  TEXT,
      agent_name TEXT,
      tool_name  TEXT,
      task_id    TEXT,
      agent_id   TEXT,
      node_id    TEXT,
      phase      TEXT,
      tokens     INTEGER,
      PRIMARY KEY (run_id, sequence),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
  `);
  return db;
}

describe('events.metadata migration (PR γ)', () => {
  it('adds the metadata column on a pre-PR-γ schema', () => {
    const db = createPrePrGammaEventsSchema();
    try {
      const before = db
        .prepare(`PRAGMA table_info(events)`)
        .all() as Array<{ name: string }>;
      expect(before.some((c) => c.name === 'metadata')).toBe(false);

      applyEventsMetadataMigration(db);

      const after = db
        .prepare(`PRAGMA table_info(events)`)
        .all() as Array<{ name: string }>;
      const meta = after.find((c) => c.name === 'metadata');
      expect(meta).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('is idempotent — running the migration twice is a no-op', () => {
    const db = createPrePrGammaEventsSchema();
    try {
      // Seed an event so we can confirm the row survives the second pass.
      db.prepare(
        `INSERT INTO events
           (run_id, sequence, id, timestamp, type, title)
         VALUES ('r1', 1, 'e1', '2026-01-01T00:00:00Z', 'log', 'hello')`
      ).run();

      applyEventsMetadataMigration(db);
      const firstPass = db
        .prepare(`SELECT metadata FROM events WHERE id = 'e1'`)
        .get() as { metadata: string };
      expect(firstPass.metadata).toBe('{}');

      // Second pass: must short-circuit. No throw, no duplicate column,
      // no row mutation.
      applyEventsMetadataMigration(db);

      const colsAfter2 = db
        .prepare(`PRAGMA table_info(events)`)
        .all() as Array<{ name: string }>;
      expect(
        colsAfter2.filter((c) => c.name === 'metadata').length
      ).toBe(1);

      const secondPass = db
        .prepare(`SELECT metadata FROM events WHERE id = 'e1'`)
        .get() as { metadata: string };
      expect(secondPass.metadata).toBe('{}');
    } finally {
      db.close();
    }
  });

  it('roundtrips metadata on insert + select', () => {
    const db = createPrePrGammaEventsSchema();
    try {
      applyEventsMetadataMigration(db);
      const meta = {
        parentInvocationId: 'inv-1',
        invocationDepth: 1,
        invocationNumber: 2,
        invocationTotal: 3,
      };
      db.prepare(
        `INSERT INTO events
           (run_id, sequence, id, timestamp, type, title, metadata)
         VALUES ('r1', 1, 'e1', '2026-01-01T00:00:00Z', 'agent_started', 'nested', ?)`
      ).run(JSON.stringify(meta));

      const row = db
        .prepare(`SELECT metadata FROM events WHERE id = 'e1'`)
        .get() as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual(meta);
    } finally {
      db.close();
    }
  });
});

