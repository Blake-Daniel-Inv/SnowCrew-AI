-- ============================================================
-- CrewAI Studio — Snowpark Container Services (SPCS) Setup
-- ============================================================
-- Run these statements in order in a Snowflake worksheet.
-- Adjust names, warehouse sizes, and roles to fit your org.
-- ============================================================

-- 1. Use a role with CREATE COMPUTE POOL + CREATE SERVICE privileges
USE ROLE SYSADMIN;  -- or a custom role with the right grants

-- 2. Database & schema for the app
CREATE DATABASE IF NOT EXISTS CREWAI_STUDIO;
USE DATABASE CREWAI_STUDIO;
CREATE SCHEMA IF NOT EXISTS APP;
USE SCHEMA APP;

-- 3. Image repository — holds your Docker image
CREATE IMAGE REPOSITORY IF NOT EXISTS CREWAI_STUDIO_REPO;

-- Show the repository URL (you'll need this for docker push)
SHOW IMAGE REPOSITORIES IN SCHEMA;
-- Copy the repository_url column, e.g.:
--   <org>-<account>.registry.snowflakecomputing.com/crewai_studio/app/crewai_studio_repo

-- 4. Internal stage — mounted into the container for persistent data
CREATE STAGE IF NOT EXISTS CREWAI_DATA
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Persistent workspace data for CrewAI Studio';

-- 5. Compute pool — the cluster that runs your container
-- CPU_X64_XS = 1 vCPU, 4 GB RAM — plenty for a small web app
CREATE COMPUTE POOL IF NOT EXISTS CREWAI_STUDIO_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_RESUME  = TRUE
  AUTO_SUSPEND_SECS = 3600          -- suspend after 1 hour idle
  COMMENT = 'Compute pool for CrewAI Studio';

-- Check pool status (wait for ACTIVE/IDLE before creating service)
DESCRIBE COMPUTE POOL CREWAI_STUDIO_POOL;

-- 6. Auth (hybrid model)
--
-- Cortex inference, SYSTEM$SEND_EMAIL, and statement API calls all use
-- the SPCS-injected OAuth session token at /snowflake/session/token —
-- no PAT, no External Access Integration, no rotation needed for those
-- paths. Calls go through the internal SNOWFLAKE_HOST.
--
-- The ONE exception is the SnowflakeSearchTool that crewai-tools wires
-- into agents at runtime. Its SnowflakeConfig only accepts password or
-- private_key_path — no `authenticator='oauth'` knob — so until that
-- changes upstream we still inject a PAT for that specific tool's use.
-- Same secret can be used across services; rotate via ALTER SECRET.
--
-- Generate a PAT first per snowflake/PAT-SETUP.md, then run:
--
-- CREATE SECRET IF NOT EXISTS SNOWFLAKE_CREWAI_PAT_SECRET
--   TYPE = GENERIC_STRING
--   SECRET_STRING = '<paste raw PAT value here, no pat/ prefix>'
--   COMMENT = 'PAT used by crewai-tools SnowflakeSearchTool for data access';
--
-- Grant USAGE to whichever role owns the service:
-- GRANT USAGE ON SECRET SNOWFLAKE_CREWAI_PAT_SECRET TO ROLE SYSADMIN;
--
-- To rotate later (no service restart needed):
-- ALTER SECRET SNOWFLAKE_CREWAI_PAT_SECRET SET SECRET_STRING = '<new PAT value>';
--
-- LOCAL DEV: same env-var pattern. SNOWFLAKE_PAT in your shell handles
-- both Cortex calls and SnowflakeSearchTool. See snowflake/PAT-SETUP.md.

-- 6b. Credentials master key secret (PR 33)
--
-- The Next.js app encrypts per-user OAuth tokens (GitHub, etc.) at rest
-- using AES-256-GCM with envelope crypto. CREDENTIALS_MASTER_KEY is the
-- KEK that wraps each row's data key. Without it bound, /api/health/ready
-- returns 503 forever and SPCS bounces the container indefinitely.
--
-- OPERATOR ACTION REQUIRED: generate a fresh 32-byte key locally and
-- paste the base64 value into the SECRET_STRING below before running.
--   openssl rand -base64 32
--
-- Treat this value like a root credential:
--   - Never commit it to git
--   - Never log it (the pino redact list catches CREDENTIALS_MASTER_KEY)
--   - Rotating it WILL invalidate every stored credential — do not
--     rotate in production until re-encryption tooling exists
--     (tracked as TODO in PR 33's body).
--
-- CREATE SECRET IF NOT EXISTS CREDENTIALS_MASTER_KEY_SECRET
--   TYPE = GENERIC_STRING
--   SECRET_STRING = '<replace-with-openssl-rand-base64-32-output>'
--   COMMENT = 'KEK for encrypted per-user credentials (PR 1 envelope crypto)';
--
-- GRANT USAGE ON SECRET CREDENTIALS_MASTER_KEY_SECRET TO ROLE SYSADMIN;

-- 7. Upload spec.yaml to the stage
--
-- Option A: Snowsight web UI (easiest)
--   Go to Data > Databases > CREWAI_STUDIO > APP > Stages > CREWAI_DATA
--   Click "+ Files", create folder path "spec", upload spec.yaml
--
-- Option B: SnowSQL CLI (PUT cannot run in the web UI)
--   PUT file:///path/to/snowflake/spec.yaml @CREWAI_DATA/spec/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
--
-- Option C: Snow CLI
--   snow stage copy snowflake/spec.yaml @CREWAI_DATA/spec/ --overwrite --database CREWAI_STUDIO --schema APP

-- Verify the file landed:
LIST @CREWAI_DATA/spec.yaml;

-- 8. Create the service
CREATE SERVICE IF NOT EXISTS CREWAI_STUDIO_SVC
  IN COMPUTE POOL CREWAI_STUDIO_POOL
  FROM @CREWAI_DATA
  SPECIFICATION_FILE = 'spec.yaml'
  MIN_INSTANCES = 1
  MAX_INSTANCES = 1
  COMMENT = 'CrewAI Studio web application';

-- 9. Check service status
SELECT SYSTEM$GET_SERVICE_STATUS('CREWAI_STUDIO_SVC');
CALL SYSTEM$GET_SERVICE_LOGS('CREWAI_STUDIO_SVC', 0, 'crewai-studio', 50);

-- 10. Grant access to users/roles
-- The service endpoint is accessible via the ingress URL.
-- DEFAULT: restrict access. Pick the role(s) that should use the Studio.
-- CREATE ROLE IF NOT EXISTS CREWAI_USERS;
-- GRANT USAGE ON SERVICE CREWAI_STUDIO_SVC TO ROLE CREWAI_USERS;
--
-- Only enable PUBLIC if you genuinely intend every account user to reach the UI:
-- GRANT USAGE ON SERVICE CREWAI_STUDIO_SVC TO ROLE PUBLIC;

-- 11. Get the public endpoint URL
SHOW ENDPOINTS IN SERVICE CREWAI_STUDIO_SVC;
-- The ingress_url column is the URL your users visit.

-- ============================================================
-- Teardown (if needed)
-- ============================================================
-- DROP SERVICE IF EXISTS CREWAI_STUDIO_SVC;
-- DROP SECRET IF EXISTS SNOWFLAKE_CREWAI_PAT_SECRET;       -- only if you created one previously
-- DROP SECRET IF EXISTS CREDENTIALS_MASTER_KEY_SECRET;     -- only if you created one previously
-- DROP EXTERNAL ACCESS INTEGRATION IF EXISTS CREWAI_SNOWFLAKE_EAI;  -- only if you created one previously
-- DROP NETWORK RULE IF EXISTS CREWAI_SNOWFLAKE_EGRESS;     -- only if you created one previously
-- DROP COMPUTE POOL IF EXISTS CREWAI_STUDIO_POOL;
-- DROP STAGE IF EXISTS CREWAI_DATA;
-- DROP IMAGE REPOSITORY IF EXISTS CREWAI_STUDIO_REPO;
