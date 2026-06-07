// Materialize a CrewStudio workspace+crew into a temp project directory for the python runner.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCrewStudioExportBundle, sanitizeIdentifier } from '@/lib/crew-studio';
import type { CrewStudioWorkspace } from '@/types';
import { RUNNER_SCRIPT } from './run-py';
import {
  SNOWFLAKE_TOKEN_REFRESH_PY,
  getSnowflakeTokenRefreshFilename,
} from '@/lib/workspace/export/snowflake-token-refresh.py';
import { getSubCrewToolFilename } from '@/lib/workspace/export/subcrew-tool.py';

export function materializeRun(
  runId: string,
  workspace: CrewStudioWorkspace,
  inputs: Record<string, string>
): string {
  // Build a temp project directory with the exports
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `crewai-run-${runId.slice(0, 8)}-`));
  try {
    const bundle = buildCrewStudioExportBundle(workspace);
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'agents.yaml'), bundle.agentsYaml);
    fs.writeFileSync(path.join(configDir, 'tasks.yaml'), bundle.tasksYaml);
    fs.writeFileSync(path.join(tmpDir, 'crew.py'), bundle.crewPython);
    fs.writeFileSync(path.join(tmpDir, 'inputs.json'), JSON.stringify(inputs, null, 2));
    fs.writeFileSync(
      path.join(tmpDir, 'studio-map.json'),
      JSON.stringify(
        {
          tasks: workspace.tasks.map((task) => ({
            id: task.id,
            key: sanitizeIdentifier(task.name, 'task'),
            name: task.name,
            description: task.description,
            agentId: task.agentId,
          })),
          agents: workspace.agents.map((agent) => ({
            id: agent.id,
            key: sanitizeIdentifier(agent.name, 'agent'),
            name: agent.name,
            role: agent.role,
          })),
        },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(tmpDir, 'run.py'), RUNNER_SCRIPT);
    // SPCS session-token refresh daemon. ALWAYS materialized — the helper
    // self-no-ops when /snowflake/session/token is absent (local mode),
    // and crew.py unconditionally imports + calls start_token_refresh_thread().
    fs.writeFileSync(
      path.join(tmpDir, getSnowflakeTokenRefreshFilename()),
      SNOWFLAKE_TOKEN_REFRESH_PY
    );
    // PR γ — sub-crew tool module. Materialized only when the exporter
    // attached subcrewToolPython to the bundle (i.e., the workspace
    // declares at least one SubCrewInvocation). PR α set this on the
    // bundle but the materialize step was left as a TODO; this is the
    // wiring that closes the loop so the generated crew.py's inlined
    // SubCrewTool class has its filesystem twin for download/inspection,
    // matches the exporter's bundle shape, and gives a deterministic
    // on-disk artifact tests can grep against.
    if (bundle.subcrewToolPython) {
      fs.writeFileSync(
        path.join(tmpDir, getSubCrewToolFilename()),
        bundle.subcrewToolPython
      );
    }
    return tmpDir;
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    throw err;
  }
}
