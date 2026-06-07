// Embedded CrewStudioSnowflakeTool Python source, interpolated into crew.py.

export const SNOWFLAKE_TOOL_PY = `import json
import os
from typing import Type

from pydantic import BaseModel, Field
from crewai.tools import BaseTool

try:
    import snowflake.connector
except ImportError as exc:  # pragma: no cover - import-time check
    raise RuntimeError(
        "snowflake-connector-python is required for the Snowflake search tool. "
        "Install with: pip install snowflake-connector-python"
    ) from exc


class _CrewStudioSnowflakeArgs(BaseModel):
    query: str = Field(
        ...,
        description="Read-only SQL query to execute against Snowflake.",
    )


class CrewStudioSnowflakeTool(BaseTool):
    """Snowflake query tool that prefers the SPCS-injected OAuth session
    token at /snowflake/session/token (no PAT needed in deployed
    environments) and falls back to a PAT in env for local development.

    Replaces crewai-tools' SnowflakeSearchTool because that wrapper's
    SnowflakeConfig only accepts password / private_key auth and can't
    pass authenticator='oauth' through to the connector.
    """

    name: str = "snowflake_search"
    description: str = (
        "Run a read-only SQL query against Snowflake. Returns the first 100 "
        "rows as a JSON array. Use precise WHERE clauses to keep scans small."
    )
    args_schema: Type[BaseModel] = _CrewStudioSnowflakeArgs

    account: str
    user: str
    warehouse: str = ""
    database: str = ""
    schema_name: str = ""
    role: str = ""
    password_env: str = "SNOWFLAKE_PAT"

    def _connection_kwargs(self) -> dict:
        kwargs: dict = {"account": self.account, "user": self.user}
        if self.warehouse:
            kwargs["warehouse"] = self.warehouse
        if self.database:
            kwargs["database"] = self.database
        if self.schema_name:
            kwargs["schema"] = self.schema_name
        env_role = os.getenv("SNOWFLAKE_ROLE", "").strip()
        if env_role:
            kwargs["role"] = env_role
        elif self.role:
            kwargs["role"] = self.role
        return kwargs

    def _connect(self):
        kwargs = self._connection_kwargs()

        # Preferred path: SPCS-mounted OAuth session token. Present in
        # deployed services, absent in local dev.
        try:
            with open("/snowflake/session/token", "r") as fp:
                token = fp.read().strip()
            if token:
                return snowflake.connector.connect(
                    authenticator="oauth", token=token, **kwargs
                )
        except (FileNotFoundError, OSError):
            pass

        # Local dev fallback: PAT (or password) in env.
        pw = os.getenv(self.password_env, "").strip()
        if not pw:
            raise RuntimeError(
                "No Snowflake credentials available. SPCS session token absent "
                f"and env var '{self.password_env}' is empty."
            )
        if pw.startswith("pat/"):
            pw = pw[len("pat/"):]
        return snowflake.connector.connect(password=pw, **kwargs)

    def _run(self, query: str) -> str:
        try:
            conn = self._connect()
        except Exception as exc:
            return f"Snowflake connection error: {type(exc).__name__}: {exc}"
        try:
            cur = conn.cursor()
            try:
                cur.execute(query)
                cols = [c[0] for c in (cur.description or [])]
                rows = cur.fetchmany(100)
                payload = [dict(zip(cols, row)) for row in rows]
                return json.dumps(payload, default=str)
            except Exception as exc:
                return f"Snowflake query error: {type(exc).__name__}: {exc}"
            finally:
                cur.close()
        finally:
            conn.close()
`;
