// crew.py emitter for CrewStudio export bundle.

import type { CrewStudioConnection, CrewStudioWorkspace } from '@/types';
import { pyString, resolveCrewClassName, sanitizeIdentifier, toPascalCase } from '../normalize';
import { SNOWFLAKE_TOOL_PY } from './snowflake-tool.py';
import { GITHUB_TOOL_PY } from './github-tool.py';
import { SUBCREW_TOOL_PY } from './subcrew-tool.py';
import { KNOWN_AGENT_TOOLS, type KnownAgentTool } from '../tool-registry';

/**
 * Tool names recognized by the exporter. Re-exported from the shared
 * tool-registry so the UI (NodeConfigPanel checkbox list) and the
 * exporter cannot drift apart — adding a tool is now a one-file change.
 */
export const EXPORTABLE_TOOL_NAMES = KNOWN_AGENT_TOOLS;
export type ExportableToolName = KnownAgentTool;

function agentDeclaresTool(
  agent: { tools?: string[] | null },
  toolName: ExportableToolName
): boolean {
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  return tools.includes(toolName);
}

/** Public helper: does any agent in the workspace declare the github tool? */
export function workspaceUsesGitHubTool(workspace: CrewStudioWorkspace): boolean {
  return workspace.agents.some((agent) => agentDeclaresTool(agent, 'github'));
}

export function buildCrewPython(workspace: CrewStudioWorkspace): string {
  const defaultCrew = workspace.crews[0];
  const defaultProcess = defaultCrew?.process || 'sequential';
  const className = `${toPascalCase(defaultCrew?.name || workspace.name, 'CrewStudio')}Crew`;
  const apiConnections = workspace.connections.filter(
    (connection) => connection.mode === 'snowflake-api' && connection.enabled
  );
  const apiToolMap = workspace.agents
    .map((agent) => {
      const tools = agent.connectionIds
        .map((connectionId) =>
          workspace.connections.find(
            (connection) =>
              connection.id === connectionId &&
              connection.mode === 'snowflake-api' &&
              connection.enabled
          )
        )
        .filter(Boolean) as CrewStudioConnection[];

      return {
        agentKey: sanitizeIdentifier(agent.name, 'agent'),
        tools,
      };
    })
    .filter((entry) => entry.tools.length > 0);
  const githubAgentKeys = new Set(
    workspace.agents
      .filter((agent) => agentDeclaresTool(agent, 'github'))
      .map((agent) => sanitizeIdentifier(agent.name, 'agent'))
  );
  const emitGitHubTool = githubAgentKeys.size > 0;

  // ---- Sub-crew tool wiring (PR 20) -----------------------------------
  // A workspace with zero sub-crew invocations emits byte-identical
  // crew.py to the pre-PR-20 baseline. The whole block below stays
  // dormant when `invocations` is empty.
  const invocations = workspace.subCrewInvocations ?? [];
  const emitSubCrewTool = invocations.length > 0;

  // Map agent.subCrewToolIds entries back to the invocation object,
  // dropping danglers. Builds a per-agent list of invocations so the
  // exporter can emit them with stable ordering.
  type ResolvedInvocation = {
    invocation: (typeof invocations)[number];
    factoryFnName: string;
    targetClassName: string;
  };
  const invocationsById = new Map(invocations.map((inv) => [inv.id, inv] as const));
  const subCrewAgentMap = workspace.agents
    .map((agent) => {
      const resolved: ResolvedInvocation[] = [];
      const toolIds = Array.isArray(agent.subCrewToolIds) ? agent.subCrewToolIds : [];
      for (const id of toolIds) {
        const inv = invocationsById.get(id);
        if (!inv) continue;
        const targetCrew = workspace.crews.find((c) => c.id === inv.targetCrewId);
        if (!targetCrew) continue;
        resolved.push({
          invocation: inv,
          factoryFnName: `_factory_${sanitizeIdentifier(inv.id, 'inv')}`,
          targetClassName: resolveCrewClassName(workspace, targetCrew),
        });
      }
      return {
        agentKey: sanitizeIdentifier(agent.name, 'agent'),
        resolved,
      };
    })
    .filter((entry) => entry.resolved.length > 0);
  const subCrewAgentKeys = new Set(subCrewAgentMap.map((e) => e.agentKey));

  // The set of unique factory functions we need to emit (deduped by id).
  const uniqueFactories: ResolvedInvocation[] = [];
  {
    const seen = new Set<string>();
    for (const entry of subCrewAgentMap) {
      for (const r of entry.resolved) {
        if (seen.has(r.invocation.id)) continue;
        seen.add(r.invocation.id);
        uniqueFactories.push(r);
      }
    }
  }
  const workspaceDefaultLlm = workspace.defaultLlm || 'snowflake/claude-sonnet-4-6';
  const snowflakeModelFallbackLlm =
    workspaceDefaultLlm === 'snowflake/claude-4-opus'
      ? 'snowflake/claude-opus-4-7'
      : ['snowflake/claude-3-7-sonnet', 'snowflake/claude-3-5-sonnet'].includes(workspaceDefaultLlm)
        ? 'snowflake/claude-sonnet-4-6'
        : workspaceDefaultLlm;
  // Prefer the first agent's configured LLM for planning (this matches
  // the original intent: a crew often wants its planner aligned with its
  // primary agent). Fall back to the workspace default, then to a
  // hard-coded safe model. The previous chain put
  // `snowflakeModelFallbackLlm` first, but that value is always non-empty
  // so the agent lookup was dead.
  const planningLlm =
    defaultCrew?.agentIds
      .map((agentId) => workspace.agents.find((agent) => agent.id === agentId)?.llm.trim())
      .find(Boolean) ||
    snowflakeModelFallbackLlm ||
    'snowflake/claude-sonnet-4-6';

  const crewPython = `"""
${workspace.name}

LLM routing: all agents use Snowflake Cortex via LiteLLM. Model strings
look like "snowflake/claude-sonnet-4-6" — CrewAI -> LiteLLM dispatches
these to the Cortex REST API.

Auth uses a Snowflake Personal Access Token (PAT). Required environment variables:

    SNOWFLAKE_ACCOUNT_ID   e.g. ABC12345-XYZ67890
    SNOWFLAKE_PAT          a Personal Access Token from Snowsight
    SNOWFLAKE_ROLE         optional role override for data tools

One-time setup:
    1. Grant Cortex and ACCOUNT_USAGE privileges to the role you will run with
    2. In Snowsight: My Profile -> Programmatic access tokens ->
       Generate, optionally restricted to that same role
    3. export SNOWFLAKE_ACCOUNT_ID=<your-snowflake-account-id>
       export SNOWFLAKE_PAT=<paste token>
       export SNOWFLAKE_ROLE=<role name, if the token is not role-restricted>

Tokens stay valid for up to 365 days; MFA is only required at creation.

See: https://docs.snowflake.com/en/user-guide/snowflake-cortex/llm-functions
"""

import os

from crewai import Agent, Crew, LLM, Process, Task
from crewai.project import CrewBase, agent, crew, task

# SPCS session-token refresh daemon. Imported from snowflake_token_refresh.py
# (materialized alongside crew.py by the runner). The helper is a true
# no-op when /snowflake/session/token is absent (local PAT/JWT mode), so
# this is always-safe to call — there is no harm and zero overhead when
# running outside SPCS. Long crews (>60min) would otherwise silently 401
# when SPCS rotates the mounted session token.
from snowflake_token_refresh import start_token_refresh_thread
start_token_refresh_thread()
${apiConnections.length ? SNOWFLAKE_TOOL_PY : ''}
${emitGitHubTool ? GITHUB_TOOL_PY : ''}
${emitSubCrewTool ? SUBCREW_TOOL_PY : ''}


class SnowflakeCortexLLM(LLM):
    """CrewAI LLM adapter for Cortex models with Snowflake's stricter chat shape."""

    def _format_messages_for_provider(self, messages):
        formatted = super()._format_messages_for_provider(messages)
        if formatted and formatted[-1].get("role") == "assistant":
            return [
                *formatted,
                {"role": "user", "content": "Please continue."},
            ]
        return formatted


@CrewBase
class ${className}:
    """${workspace.name}"""

    agents_config = "config/agents.yaml"
    tasks_config = "config/tasks.yaml"
    snowflake_model_fallback = ${pyString(snowflakeModelFallbackLlm)}
    legacy_snowflake_model_map = {
        "snowflake/claude-4-opus": os.getenv("SNOWFLAKE_OPUS_FALLBACK_MODEL", "snowflake/claude-opus-4-7"),
        "snowflake/claude-3-7-sonnet": os.getenv("SNOWFLAKE_MODEL_FALLBACK", "snowflake/claude-sonnet-4-6"),
        "snowflake/claude-3-5-sonnet": os.getenv("SNOWFLAKE_MODEL_FALLBACK", "snowflake/claude-sonnet-4-6"),
    }

    @staticmethod
    def _read_spcs_session_token():
        """Auto-mounted OAuth session token in SPCS. Absent locally."""
        try:
            with open("/snowflake/session/token", "r", encoding="utf-8") as fp:
                content = fp.read().strip()
                return content or None
        except (FileNotFoundError, OSError, PermissionError):
            return None

    def _snowflake_api_key(self):
        # Prefer the SPCS session token when running inside Snowflake —
        # it's auto-rotated by SPCS and doesn't require a PAT. Falls back
        # to env-based PAT/JWT for local dev.
        spcs_token = self._read_spcs_session_token()
        if spcs_token:
            return spcs_token

        jwt = os.getenv("SNOWFLAKE_JWT")
        if jwt:
            return jwt

        pat = os.getenv("SNOWFLAKE_PAT")
        if pat:
            return pat if pat.startswith("pat/") else f"pat/{pat}"

        return None

    def _resolve_model(self, model: str) -> str:
        if model in self.legacy_snowflake_model_map:
            return self.legacy_snowflake_model_map[model]

        return model

    def _llm_for(self, model: str) -> LLM:
        model = self._resolve_model(model)

        if not model.startswith("snowflake/"):
            return LLM(model=model)

        kwargs = {}
        api_key = self._snowflake_api_key()
        if api_key:
            kwargs["api_key"] = api_key

        # SPCS-mode: route LiteLLM at the internal Snowflake host (no
        # External Access Integration required) AND override the
        # token-type header to OAUTH. LiteLLM's default for tokens that
        # do not start with the pat/ prefix is KEYPAIR_JWT, but Snowflake
        # rejects OAuth session tokens under that header — they must be
        # marked OAUTH. extra_headers merge on top of LiteLLM's defaults.
        spcs_token = self._read_spcs_session_token()
        spcs_host = os.getenv("SNOWFLAKE_HOST", "").strip()
        if spcs_token and spcs_host:
            kwargs["extra_headers"] = {
                "X-Snowflake-Authorization-Token-Type": "OAUTH",
            }
            # LiteLLM constructs URL as https://{account_id}.snowflakecomputing.com.
            # Stripping the suffix off SNOWFLAKE_HOST gives a prefix that
            # produces the internal URL when re-suffixed.
            suffix = ".snowflakecomputing.com"
            if spcs_host.endswith(suffix):
                kwargs["account_id"] = spcs_host[: -len(suffix)]
        else:
            account_id = os.getenv("SNOWFLAKE_ACCOUNT_ID")
            if account_id:
                kwargs["account_id"] = account_id

        return SnowflakeCortexLLM(model=model, **kwargs)

    def _task_config_for(self, task_key: str):
        config = dict(self.tasks_config[task_key])
        allow_human_input = os.getenv("CREWAI_STUDIO_ALLOW_HUMAN_INPUT", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        if not allow_human_input:
            config["human_input"] = False
        return config

${apiToolMap.length ? `    def _api_tools_for(self, agent_key: str):
        tool_map = {
${apiToolMap
  .map(
    (entry) => `            ${pyString(entry.agentKey)}: [
${entry.tools
  .map(
    (connection) => `                CrewStudioSnowflakeTool(
                    account=${pyString(connection.account)},
                    user=${pyString(connection.user)},
                    warehouse=${pyString(connection.warehouse)},
                    database=${pyString(connection.database)},
                    schema_name=${pyString(connection.schema)},
                    role=${pyString(connection.role)},
                    password_env=${pyString(connection.passwordEnvVar || 'SNOWFLAKE_PAT')},
                )`
  )
  .join(',\n')}
            ]`
  )
  .join(',\n')}
        }
        return tool_map.get(agent_key, [])

` : ''}${emitGitHubTool ? `    def _github_tools_for(self, agent_key: str):
        github_agent_keys = {${[...githubAgentKeys].map((k) => pyString(k)).join(', ')}}
        if agent_key in github_agent_keys:
            return [GitHubTool()]
        return []

` : ''}${emitSubCrewTool ? `${uniqueFactories
  .map(
    (r) => `    def ${r.factoryFnName}(self):
        # Sub-crew factory for invocation ${pyString(r.invocation.id)}.
        # Builds a fresh instance of ${r.targetClassName} on every call
        # so each kickoff gets isolated context (contextMode='isolated').
        return ${r.targetClassName}().crew()
`
  )
  .join('\n')}
    def _subcrew_tools_for(self, agent_key: str):
        tool_map = {
${subCrewAgentMap
  .map(
    (entry) => `            ${pyString(entry.agentKey)}: [
${entry.resolved
  .map(
    (r) => `                SubCrewTool(
                    invocation_id=${pyString(r.invocation.id)},
                    display_name=${pyString(r.invocation.name)},
                    description=${pyString(
                      [
                        r.invocation.description || 'Calls a sub-crew.',
                        r.invocation.inputMapping
                          ? `Input mapping: ${r.invocation.inputMapping}`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                    )},
                    target_crew_factory=self.${r.factoryFnName},
                    max_invocations=${r.invocation.maxInvocations},
                    success_criteria=${
                      r.invocation.successCriteria
                        ? pyString(r.invocation.successCriteria)
                        : 'None'
                    },
                )`
  )
  .join(',\n')}
            ]`
  )
  .join(',\n')}
        }
        return tool_map.get(agent_key, [])

` : ''}${workspace.agents
  .map((agent) => {
    const agentKey = sanitizeIdentifier(agent.name, 'agent');
    const hasApiTools = apiToolMap.some((entry) => entry.agentKey === agentKey);
    const hasGitHubTool = githubAgentKeys.has(agentKey);
    const hasSubCrewTools = subCrewAgentKeys.has(agentKey);
    // Concatenate every active tool source. Sub-crew tools are appended
    // last so the LLM still sees existing tools (api / github) first
    // when scanning the toolbox — the relative order matches the order
    // PR α set as the canonical "add new tools at the end" rule.
    const parts: string[] = [];
    if (hasApiTools) parts.push(`self._api_tools_for(${pyString(agentKey)})`);
    if (hasGitHubTool) parts.push(`self._github_tools_for(${pyString(agentKey)})`);
    if (hasSubCrewTools) parts.push(`self._subcrew_tools_for(${pyString(agentKey)})`);
    let toolsArgument = '';
    if (parts.length) {
      toolsArgument = `,\n            tools=${parts.join(' + ')}`;
    }

    return `    @agent
    def ${agentKey}(self) -> Agent:
        return Agent(
            config=self.agents_config[${pyString(agentKey)}],  # type: ignore[index]
            verbose=${agent.verbose ? 'True' : 'False'},
            llm=self._llm_for(${pyString(agent.llm)})${toolsArgument}
        )
`;
  })
  .join('\n')}${workspace.tasks
  .map((task) => {
    const taskKey = sanitizeIdentifier(task.name, 'task');
    const outputArgument = task.outputFile
      ? `,\n            output_file=${pyString(task.outputFile)}`
      : '';

    return `    @task
    def ${taskKey}(self) -> Task:
        return Task(
            config=self._task_config_for(${pyString(taskKey)}),  # type: ignore[index]${outputArgument}
        )
`;
  })
  .join('\n')}    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.${defaultProcess},
            verbose=${defaultCrew?.verbose ? 'True' : 'False'},
            # CrewAI's default memory uses OpenAI embeddings unless a custom
            # embedder is configured, so Snowflake-only exports keep it off.
            memory=False,
            planning=${defaultCrew?.planning ? 'True' : 'False'},
            planning_llm=self._llm_for(${pyString(planningLlm)}),
            manager_llm=self._llm_for(${pyString(planningLlm)}),
            function_calling_llm=self._llm_for(${pyString(planningLlm)}),
        )
`;

  return crewPython;
}
