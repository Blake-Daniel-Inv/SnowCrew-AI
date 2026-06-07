-- ============================================================
-- CrewAI Studio - Snowflake role + PAT setup
-- ============================================================
-- Run this as ACCOUNTADMIN.
--
-- Set APP_ROLE to the role your test run should use. This can be
-- an existing role, or a new dedicated role created by this script.
-- The Studio connection Role field can be left blank; generated runs
-- will use the PAT/default role, or SNOWFLAKE_ROLE if you export it.
-- ============================================================

USE ROLE ACCOUNTADMIN;

-- Edit these three before running. APP_ROLE is the role the Studio's
-- runs will execute as (it should already exist, or this script will
-- create it). APP_USER is the Snowflake login that will own the PAT.
-- APP_WAREHOUSE is the warehouse that role will use for SQL tools.
SET APP_ROLE = 'FINOPS_READER';
SET APP_USER = '<YOUR_SNOWFLAKE_USER>';
SET APP_WAREHOUSE = 'COMPUTE_WH';

-- 1. Create the role if it does not already exist.
CREATE ROLE IF NOT EXISTS IDENTIFIER($APP_ROLE)
  COMMENT = 'Role used by CrewAI Studio for Cortex + Snowflake usage analysis';

-- 2. Cortex LLM access.
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE IDENTIFIER($APP_ROLE);

-- 3. Warehouse usage for SQL tools.
GRANT USAGE ON WAREHOUSE IDENTIFIER($APP_WAREHOUSE) TO ROLE IDENTIFIER($APP_ROLE);

-- 4. ACCOUNT_USAGE access for the FinOps template.
GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER TO ROLE IDENTIFIER($APP_ROLE);
GRANT DATABASE ROLE SNOWFLAKE.GOVERNANCE_VIEWER TO ROLE IDENTIFIER($APP_ROLE);
GRANT DATABASE ROLE SNOWFLAKE.OBJECT_VIEWER TO ROLE IDENTIFIER($APP_ROLE);

-- Optional: user/login/role metadata, if your reports need it.
-- GRANT DATABASE ROLE SNOWFLAKE.SECURITY_VIEWER TO ROLE IDENTIFIER($APP_ROLE);

-- Optional broad fallback. Prefer the database roles above when possible.
-- GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE IDENTIFIER($APP_ROLE);

-- 5. Grant the role to your user.
GRANT ROLE IDENTIFIER($APP_ROLE) TO USER IDENTIFIER($APP_USER);

-- Optional: make this the default role for the user/PAT.
-- ALTER USER IDENTIFIER($APP_USER) SET DEFAULT_ROLE = $APP_ROLE;

-- 6. Quick verification.
USE ROLE IDENTIFIER($APP_ROLE);

SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE();

SELECT COUNT(*)
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP());

SELECT COUNT(*)
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP());

SELECT COUNT(*)
FROM SNOWFLAKE.ACCOUNT_USAGE.DATABASE_STORAGE_USAGE_HISTORY
WHERE USAGE_DATE >= DATEADD(day, -7, CURRENT_DATE());

-- ============================================================
-- Generate the Personal Access Token (PAT)
-- ============================================================
-- In Snowsight:
--   1. My profile -> Programmatic access tokens -> Generate new token
--   2. Name: crewai_studio
--   3. Role: use APP_ROLE if you want the token role-restricted
--   4. Copy the token value immediately
--
-- Then locally:
--   export SNOWFLAKE_ACCOUNT_ID=<your-account-locator>
--   export SNOWFLAKE_PAT=<paste token value>
--   export SNOWFLAKE_ROLE=FINOPS_READER  # optional if token/default role is already correct
-- ============================================================
