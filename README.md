# SnowCrew AI

![CI](https://github.com/Blake-Daniel-Inv/SnowCrew-AI/actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A standalone Next.js app for building and managing CrewAI-style agents, tasks, crews, and Snowflake connections — run it locally for development or deploy it to Snowflake Container Services for production.

## What It Does

- Creates local workspaces for CrewAI planning and export
- Models agents, tasks, crews, and Snowflake connections
- Supports Snowflake API-style config
- Exports starter `agents.yaml`, `tasks.yaml`, `crew.py`, `.env.example`
- Stores app data locally in `~/.crewai-studio-local/` (overridable via `DATA_DIR` for container/SPCS deployments)

## Running It

### Development (Local)

For local development and trying it out:

```bash
git clone https://github.com/Blake-Daniel-Inv/SnowCrew-AI.git
cd SnowCrew-AI
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

To verify a production build locally:

```bash
npm run build
npm start
```

### Production (Snowflake Container Services)

In production, SnowCrew AI runs as a [Snowpark Container Services (SPCS)](https://docs.snowflake.com/en/developer-guide/snowpark-container-services/overview) service inside your Snowflake account. The high-level flow:

1. **Provision** the Cortex role, database, image repository, stage, compute pool, and secrets. Run [`snowflake/setup-cortex-role.sql`](snowflake/setup-cortex-role.sql) and [`snowflake/setup.sql`](snowflake/setup.sql) — see [`docs/OPERATIONS.md` §1](docs/OPERATIONS.md) for the full walkthrough, including the `SNOWFLAKE_PAT` and `CREDENTIALS_MASTER_KEY` secrets ([snowflake/PAT-SETUP.md](snowflake/PAT-SETUP.md)).
2. **Authenticate** to your account's image registry:
   ```bash
   docker login <org>-<account>.registry.snowflakecomputing.com -u <snowflake_user>
   ```
3. **Build, push, and deploy** the service:
   ```bash
   ./snowflake/deploy.sh <image_repository_url>
   ```
4. **Wait until the service is ready**, then health-check it:
   ```sql
   SELECT SYSTEM$GET_SERVICE_STATUS('CREWAI_STUDIO_SVC');  -- wait for READY
   ```
   ```bash
   curl -sf "https://<your-ingress-host>/api/health/ready"
   ```

The service spec is [`snowflake/spec.yaml`](snowflake/spec.yaml), and app data is persisted to `DATA_DIR` (a mounted stage) rather than `~/.crewai-studio-local/`. The complete runbook — secrets, GitHub OAuth setup, backups, secret rotation, and debugging — lives in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Integrations

SnowCrewAI agents can call out to third-party APIs on a per-user basis. The first integration is GitHub (read-only access to private repos, pull requests, and issues).

To enable it:

1. Register a GitHub OAuth App at https://github.com/settings/developers. Set the callback URL to `https://<your-host>/api/auth/github/callback` (or `http://localhost:3000/api/auth/github/callback` for local dev).
2. Set the following environment variables before starting the server:
   - `GITHUB_OAUTH_CLIENT_ID` — the App's Client ID
   - `GITHUB_OAUTH_CLIENT_SECRET` — the App's Client Secret
   - `CREDENTIALS_MASTER_KEY` — a 32-byte key (base64 or hex) used to envelope-encrypt stored tokens
3. Restart `npm run dev` (or your production server).
4. Open `/settings` and click **Connect GitHub**. After authorizing, your agents that declare the `github` tool will pick up your token automatically the next time their crew runs.
5. After connecting, your GitHub organizations are listed so you can see which org repos your agents have access to.

## License

Released under the [MIT License](LICENSE).

## Acknowledgments

Built on top of [CrewAI](https://github.com/crewAIInc/crewAI), the open-source multi-agent
framework (MIT licensed). CrewAI is installed separately in your Python environment and is
not redistributed as part of this project.
