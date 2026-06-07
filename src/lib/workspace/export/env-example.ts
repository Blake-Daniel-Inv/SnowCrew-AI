// .env.example emitter for CrewStudio export bundle.

import type { CrewStudioWorkspace } from '@/types';
import { sanitizeIdentifier } from '../normalize';

export function buildEnvExample(workspace: CrewStudioWorkspace): string {
  const apiConnections = workspace.connections.filter(
    (connection) => connection.mode === 'snowflake-api' && connection.enabled
  );

  // Cortex LLM auth — the generated crew passes SNOWFLAKE_PAT to LiteLLM
  // as a Snowflake PAT, and the runner also exposes SNOWFLAKE_JWT=pat/<PAT>.
  // Note: account id is always emitted as a placeholder; we never leak the
  // real account value from workspace state into the example env file.
  void apiConnections;
  const cortexEnvHeader = [
    '# --- Snowflake Cortex (LLM routing) ---',
    '# All agents route through Cortex via LiteLLM using a Personal Access Token.',
    '# One-time setup in Snowsight: My Profile -> Programmatic access tokens.',
    'SNOWFLAKE_ACCOUNT_ID=<your-snowflake-account-id>',
    'SNOWFLAKE_PAT=<paste PAT value>',
    'SNOWFLAKE_ROLE=<optional role override for Snowflake data tools>',
    '',
    '# --- Data connections ---',
  ];

  const connectionEnvLines = workspace.connections.flatMap((connection) => {
    const prefix = sanitizeIdentifier(connection.name, 'snowflake').toUpperCase();
    return [
      `${prefix}_ACCOUNT=<your-snowflake-account-id>`,
      `${prefix}_USER=${connection.user}`,
      `${connection.passwordEnvVar || `${prefix}_PASSWORD`}=${connection.passwordEnvVar ? '<set secret>' : ''}`,
    ];
  });

  const envLines = [...cortexEnvHeader, ...connectionEnvLines];

  return envLines.join('\n') || '# No environment variables defined yet';
}
