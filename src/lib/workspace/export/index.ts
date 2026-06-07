// CrewStudio export bundle composer — orchestrates per-artifact emitters.

import type { CrewStudioExportBundle, CrewStudioWorkspace } from '@/types';
import { buildAgentsYaml } from './agents-yaml';
import { buildTasksYaml } from './tasks-yaml';
import { buildCrewPython } from './crew-py';
import { buildEnvExample } from './env-example';
import { SNOWFLAKE_TOKEN_REFRESH_PY } from './snowflake-token-refresh.py';
import { SUBCREW_TOOL_PY } from './subcrew-tool.py';

export function buildCrewStudioExportBundle(workspace: CrewStudioWorkspace): CrewStudioExportBundle {
  const agentsYaml = buildAgentsYaml(workspace);
  const tasksYaml = buildTasksYaml(workspace);
  const crewPython = buildCrewPython(workspace);
  const envExample = buildEnvExample(workspace);

  // Sub-crew tool python is included on the bundle only when the
  // workspace actually declares invocations. The runner materializes
  // subcrew_tool.py alongside crew.py iff this property is present —
  // pre-PR-20 workspaces continue to ship the same byte-for-byte
  // bundle as before.
  const hasSubCrewInvocations =
    Array.isArray(workspace.subCrewInvocations) &&
    workspace.subCrewInvocations.length > 0;

  return {
    agentsYaml: agentsYaml || '# Add at least one agent in Crew Studio',
    tasksYaml: tasksYaml || '# Add at least one task in Crew Studio',
    crewPython,
    envExample,
    // ALWAYS surface the SPCS session-token refresh daemon source. It's
    // lightweight (~5KB), self-no-ops when running outside SPCS, and is
    // unconditionally written to disk by materializeRun + unconditionally
    // imported by the generated crew.py. Exposing it in the bundle lets
    // download/preview consumers see exactly what ships into the run.
    tokenRefreshPython: SNOWFLAKE_TOKEN_REFRESH_PY,
    ...(hasSubCrewInvocations
      ? { subcrewToolPython: SUBCREW_TOOL_PY }
      : {}),
  };
}
