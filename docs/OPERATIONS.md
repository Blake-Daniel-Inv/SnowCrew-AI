# SnowCrewAI Operations Runbook

This is the single operator playbook for running SnowCrewAI on
Snowpark Container Services (SPCS). Every command in this file is
intended to be pasteable; copy/paste into a terminal or Snowsight
worksheet as labeled.

For day-1 PAT generation (the local-dev path), see
[`snowflake/PAT-SETUP.md`](../snowflake/PAT-SETUP.md). This document
covers the production deploy + ongoing operations side.

## Contents

1. [One-time setup](#1-one-time-setup)
2. [Post-deploy health check](#2-post-deploy-health-check)
3. [Backups and restore](#3-backups-and-restore)
4. [Rotating secrets](#4-rotating-secrets)
5. [Draining the scheduler for deploys](#5-draining-the-scheduler-for-deploys)
6. [Investigating a failed run](#6-investigating-a-failed-run)
7. [Manually clearing a stuck schedule row](#7-manually-clearing-a-stuck-schedule-row)
8. [Audit log inspection](#8-audit-log-inspection)

---

## 1. One-time setup

Run these in order on a brand-new Snowflake account.

### 1.1 Cortex role

In Snowsight, run [`snowflake/setup-cortex-role.sql`](../snowflake/setup-cortex-role.sql)
as `ACCOUNTADMIN`. Adjust the `APP_ROLE` value at the top before
executing.

### 1.2 Database, stage, compute pool, secrets

Run [`snowflake/setup.sql`](../snowflake/setup.sql) section by section
as `SYSADMIN` (or the role that owns the Studio).

Two secrets must exist before the service can start:

#### a. `SNOWFLAKE_CREWAI_PAT_SECRET`

Generate a PAT per `snowflake/PAT-SETUP.md`, then:

```sql
USE DATABASE CREWAI_STUDIO; USE SCHEMA APP;

CREATE SECRET IF NOT EXISTS SNOWFLAKE_CREWAI_PAT_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '<paste raw PAT, no pat/ prefix>'
  COMMENT = 'PAT used by crewai-tools SnowflakeSearchTool for data access';

GRANT USAGE ON SECRET SNOWFLAKE_CREWAI_PAT_SECRET TO ROLE SYSADMIN;
```

#### b. `CREDENTIALS_MASTER_KEY_SECRET` (PR 33)

Generate a 32-byte base64 value locally — never on the Snowflake side:

```bash
openssl rand -base64 32
```

Copy the output, then in Snowsight:

```sql
USE DATABASE CREWAI_STUDIO; USE SCHEMA APP;

CREATE SECRET IF NOT EXISTS CREDENTIALS_MASTER_KEY_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '<paste openssl output here>'
  COMMENT = 'KEK for encrypted per-user credentials';

GRANT USAGE ON SECRET CREDENTIALS_MASTER_KEY_SECRET TO ROLE SYSADMIN;
```

The `spec.yaml` already references both secrets — don't change those
identifiers without also updating `spec.yaml`.

### 1.3 OAuth secrets (GitHub integration)

If the deploy uses the GitHub integration, also store the OAuth app
credentials:

```bash
export GITHUB_OAUTH_CLIENT_ID=<id>
export GITHUB_OAUTH_CLIENT_SECRET=<secret>
export GITHUB_OAUTH_CALLBACK_URL=https://<ingress-host>/api/auth/github/callback
```

These are read from the container env at startup; bind them via the
same `secrets:` block pattern in `spec.yaml` for production. (For
local dev, exporting in your shell is enough.)

### 1.4 Build, push, deploy

```bash
./snowflake/deploy.sh
```

The script tags + pushes the image to `CREWAI_STUDIO_REPO` and creates
the service. After the script returns:

```sql
SELECT SYSTEM$GET_SERVICE_STATUS('CREWAI_STUDIO_SVC');
```

Wait for `READY`.

---

## 2. Post-deploy health check

After `deploy.sh` returns and the service status is `READY`:

```bash
# Replace with the SHOW ENDPOINTS ingress_url
INGRESS=https://<your-ingress-host>

curl -sf "$INGRESS/api/health/live"
# Expect: {"status":"ok","uptime":...}

curl -sf "$INGRESS/api/health/ready"
# Expect: {"status":"ok","checks":{"db":"ok","envVars":"ok","credentialsKey":"ok"},...}
```

A 503 from `/api/health/ready` means one of:

- `checks.db != ok` — SQLite handle could not open or `SELECT 1` timed
  out. Check the volume mount for `/data` and the file permissions
  (uid/gid 1001).
- `checks.envVars` starts with `missing:` — the listed env vars are
  unset. For SPCS the only required one is `SNOWFLAKE_HOST` — make
  sure `spec.yaml` has the right `<ORG>-<ACCOUNT>.snowflakecomputing.com`
  value (NOT the placeholder).
- `checks.credentialsKey != ok` — `CREDENTIALS_MASTER_KEY_SECRET` is
  not bound. Verify the secret exists in `CREWAI_STUDIO.APP` and that
  the service role has `USAGE` on it.

The liveness probe (`/api/health/live`) is a process-only check; if it
ever returns non-200, SPCS will restart the container automatically.

---

## 3. Backups and restore

### 3.1 Backups

The `runs.db` SQLite database lives at `$DATA_DIR/crew-studio/runs.db`
(defaults to `/data/crew-studio/runs.db` in container mode).

`scripts/backup-db.sh` performs a hot online backup using the
`sqlite3 .backup` command (consistent snapshot with no service
downtime). It keeps the 7 most recent backups in
`$DATA_DIR/backups/`.

Cron example (run as the service user, hourly):

```cron
17 * * * * /opt/snowcrewai/scripts/backup-db.sh >> /data/backups/backup.log 2>&1
```

Manual on-demand:

```bash
DATA_DIR=/data /opt/snowcrewai/scripts/backup-db.sh
```

### 3.2 Restore

To restore a previous snapshot:

1. **Stop the service** so no writers are touching the file:

   ```sql
   ALTER SERVICE CREWAI_STUDIO_SVC SUSPEND;
   ```

2. **Replace the live DB** from the chosen backup. Inside a shell
   attached to the data volume (or via stage download):

   ```bash
   cp /data/backups/runs-<TIMESTAMP>.db /data/crew-studio/runs.db
   ```

3. **Restart the service**:

   ```sql
   ALTER SERVICE CREWAI_STUDIO_SVC RESUME;
   ```

4. Verify `/api/health/ready` returns 200 and recent runs are visible
   in the Studio UI.

---

## 4. Rotating secrets

### 4.1 PAT

```sql
ALTER SECRET CREWAI_STUDIO.APP.SNOWFLAKE_CREWAI_PAT_SECRET
  SET SECRET_STRING = '<new PAT value>';
```

No service restart — the next subprocess invocation picks up the new
value on read.

### 4.2 Master key

**WARNING**: rotating `CREDENTIALS_MASTER_KEY_SECRET` will invalidate
every encrypted credential row (GitHub OAuth tokens, etc.). Each user
will need to re-connect their integration. Until a re-encryption tool
exists (tracked as TODO in PR 33's body), **do not rotate the master
key in production** unless you accept that all connected integrations
will require user-side reconnect.

### 4.3 GitHub OAuth secrets

Update `GITHUB_OAUTH_CLIENT_SECRET` (if bound via a Snowflake secret)
and restart the service. Existing connected accounts continue to work
because token storage uses the master key, not the OAuth app secret.

---

## 5. Draining the scheduler for deploys

The in-process scheduler daemon polls every minute and claims due
schedules atomically. To avoid a schedule firing mid-deploy with stale
code:

1. **Disable the daemon** by setting `SCHEDULER_DISABLED=1` in
   `spec.yaml`, redeploy, and watch the container logs for:

   ```
   scheduler daemon disabled (env)
   ```

2. **Run the upgrade**: build, push, swap the image tag in `spec.yaml`,
   redeploy.

3. **Re-enable**: unset `SCHEDULER_DISABLED` (or remove the env
   binding) and redeploy. The daemon's boot-time sweep
   (`resetStuckSchedules`) will clear any rows whose previous fire was
   interrupted; you'll see:

   ```
   Reset stuck schedules on startup (count=N)
   ```

   in the daemon's `info` log when there's anything to clear, or
   nothing on the happy path.

---

## 6. Investigating a failed run

Every run has a UUIDv4 `runId` that threads through the trace, the
events table, and every pino log line.

### 6.1 Find the runId

In the UI: click the run row in the history pane — the URL becomes
`/runs/<runId>`.

From logs: every relevant log line is structured JSON with `runId`
populated. To grep:

```bash
# Container logs via Snowflake
CALL SYSTEM$GET_SERVICE_LOGS('CREWAI_STUDIO_SVC', 0, 'crewai-studio', 1000);
```

then locally:

```bash
... | jq 'select(.runId == "<runId>")'
```

### 6.2 Read the events table

```bash
# Open a sqlite3 shell against a read-only snapshot
sqlite3 /data/crew-studio/runs.db
```

```sql
SELECT type, title, detail, timestamp
FROM events
WHERE run_id = '<runId>'
ORDER BY sequence;
```

The `runs.error` column holds the terminal failure message; the
`run_errored` event in `events` holds the human-friendly title.

### 6.3 Look for upstream failures

LLM call telemetry is in the `llm_calls` table — useful for "did the
crew exhaust its budget?" or "did Cortex return a 503?":

```sql
SELECT timestamp, model, prompt_tokens, completion_tokens, latency_ms
FROM llm_calls
WHERE run_id = '<runId>'
ORDER BY sequence;
```

---

## 7. Manually clearing a stuck schedule row

PR 33 added a boot-time sweep
(`resetStuckSchedules` in `src/lib/schedules-db.ts`) that
automatically clears any `running = 1` rows when the daemon starts.
You should never need to run the manual SQL below.

If the sweep itself failed (e.g., SQLite write error during startup),
the daemon's log will surface the failure and you can manually unstick
a row:

```bash
sqlite3 /data/crew-studio/runs.db
```

```sql
-- Find stuck schedules
SELECT id, name, owner_id, last_fired_at
FROM schedules
WHERE running = 1;

-- Clear them all
UPDATE schedules SET running = 0 WHERE running = 1;
```

---

## 8. Audit log inspection

PR 33 introduced an append-only `audit_log` table for high-value
mutation sites (credential connect/disconnect, schedule
create/update/delete/fire, email send).

```bash
sqlite3 /data/crew-studio/runs.db
```

```sql
-- Recent audit events across the system
SELECT
  datetime(ts/1000, 'unixepoch') AS when_utc,
  actor_owner_id,
  action,
  target_type,
  target_id,
  metadata
FROM audit_log
ORDER BY ts DESC
LIMIT 50;

-- Per-user history
SELECT *
FROM audit_log
WHERE actor_owner_id = '<userId>'
ORDER BY ts DESC;
```

The table is append-only — there is no DELETE API. The `metadata`
column is JSON-encoded and varies by `action`:

- `credential.connected` — `{ provider, accountLogin }`
- `credential.disconnected` — `{ provider, remoteRevoked }`
- `schedule.created` / `schedule.updated` / `schedule.deleted` —
  `{ workspaceId, crewId, cronExpr }`
- `schedule.fired` — `{ runId, scheduleName }`
- `email.sent` — `{ recipientCount, subject }` (body is never recorded)

---

## Appendix: Quick reference

| Concern | Path |
|---|---|
| Service spec | `snowflake/spec.yaml` |
| One-time setup SQL | `snowflake/setup.sql` |
| Cortex role grants | `snowflake/setup-cortex-role.sql` |
| Build + push + create service | `snowflake/deploy.sh` |
| PAT walkthrough | `snowflake/PAT-SETUP.md` |
| Backup script | `scripts/backup-db.sh` |
| Readiness probe | `GET /api/health/ready` |
| Liveness probe | `GET /api/health/live` |
| Master key env | `CREDENTIALS_MASTER_KEY` |
| Scheduler kill switch | `SCHEDULER_DISABLED=1` |
