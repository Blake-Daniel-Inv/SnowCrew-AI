# Snowflake PAT setup for CrewAI Studio

One-time setup so the Studio can call Cortex without you re-MFA-ing every hour.

## 1. Create the read role

Run [setup-cortex-role.sql](./setup-cortex-role.sql) in a Snowsight worksheet as `ACCOUNTADMIN`. Set `APP_ROLE` at the top to the Snowflake role you want the Studio to use. The script grants Cortex, warehouse, and `SNOWFLAKE.ACCOUNT_USAGE` access, then assigns that role to your user.

Edit the data-grant section before running — uncomment and adjust to whichever databases your agents read.

## 2. Generate the PAT

In Snowsight:

1. Click your avatar (top-right) → **My profile**
2. Scroll to **Programmatic access tokens** → **+ Generate new token**
3. Fill in:
   - **Name:** `crewai_studio`
   - **Role:** your `APP_ROLE` value, or leave unrestricted if your default role is already correct
   - **Days to expiry:** `90` (max is 365)
4. Confirm with MFA when prompted
5. **Copy the token value immediately** — Snowflake will not show it again

## 3. Export the env vars

```bash
export SNOWFLAKE_ACCOUNT_ID=<YOUR-ORG>-<YOUR-ACCOUNT>
export SNOWFLAKE_PAT=<paste token value>
```

Find `<YOUR-ORG>-<YOUR-ACCOUNT>` in Snowsight under **Admin → Accounts** (the
"Account Locator" / "Account Identifier" column).

Add these to your shell profile (e.g. `~/.zshrc`) so they're available every time.

## 4. Run the Studio

From a directory where you want the repo to live (e.g. `~/GitHub`):

```bash
git clone https://github.com/Blake-Daniel-Inv/SnowCrew-AI.git
cd SnowCrew-AI
npm run dev
```

The Run panel will show a yellow warning event at run start if either env var is missing, so you'll know immediately rather than hitting a cryptic LiteLLM error.

## When the PAT expires

You'll see Cortex API calls return 401. Generate a new PAT (step 2), update the env var, restart `npm run dev`. Two minutes of work every 90 days.

## When you move to SPCS

In SPCS, Cortex inference, `SYSTEM$SEND_EMAIL`, and statement-API calls all use
the SPCS-injected OAuth session token at `/snowflake/session/token`. No PAT is
required for those paths.

The one remaining PAT user is the upstream `SnowflakeSearchTool` shipped by
`crewai-tools`. Its `SnowflakeConfig` only accepts password or private-key auth
— there is no `authenticator='oauth'` knob — so until that changes upstream we
still inject a PAT for that specific tool's data-access calls.

For SPCS, store the PAT once as a Snowflake `SECRET` and reference it from the
service spec. The container reads it as `SNOWFLAKE_PAT` at runtime, and rotation
= `ALTER SECRET ... SET SECRET_STRING = '<new>'` with no rebuild.

```sql
-- One-time:
USE ROLE SYSADMIN;
USE DATABASE CREWAI_STUDIO;
USE SCHEMA APP;

CREATE SECRET IF NOT EXISTS SNOWFLAKE_CREWAI_PAT_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '<paste raw PAT, no pat/ prefix>'
  COMMENT = 'PAT used by crewai-tools SnowflakeSearchTool for data access';

GRANT USAGE ON SECRET SNOWFLAKE_CREWAI_PAT_SECRET TO ROLE <service-owner-role>;
```

The spec.yaml `secrets:` block already wires this into the container env. To rotate, just update the secret value.

When that PAT expires (max 365 days), regenerate it in Snowsight and `ALTER SECRET ... SET SECRET_STRING = '<new>'`. The next run picks it up — no service restart needed.
