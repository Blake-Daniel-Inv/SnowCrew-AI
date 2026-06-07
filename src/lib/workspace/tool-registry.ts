/**
 * Single source of truth for "what tools can a Studio agent declare?".
 *
 * Both the UI (NodeConfigPanel checkbox list) and the exporter
 * (crew-py.ts) need to enumerate this set. PR 3 introduced the
 * `EXPORTABLE_TOOL_NAMES` constant inside the exporter, but as PR 4
 * adds the UI side we extract it here so the two surfaces can't drift.
 *
 * Adding a new tool means:
 *   1. Append the key to `KNOWN_AGENT_TOOLS`.
 *   2. Add a label + description in `AGENT_TOOL_LABELS` for the UI.
 *   3. Teach the exporter how to emit its Python helper (crew-py.ts).
 *   4. Teach the runner whether to inject any per-user env vars
 *      (src/lib/runner/manager.ts).
 */

export const KNOWN_AGENT_TOOLS = ['github'] as const;
export type KnownAgentTool = (typeof KNOWN_AGENT_TOOLS)[number];

export interface AgentToolMeta {
  /** Stable string key stored in `agent.tools[]`. */
  key: KnownAgentTool;
  /** Short label for the UI checkbox row. */
  label: string;
  /** One-line tooltip / hint shown next to the label. */
  tooltip: string;
  /** Which OAuth provider, if any, this tool needs the user to connect. */
  requiresProvider: 'github' | null;
}

export const AGENT_TOOL_LABELS: Record<KnownAgentTool, AgentToolMeta> = {
  github: {
    key: 'github',
    label: 'GitHub (private repos)',
    tooltip: 'Requires connecting GitHub in Settings',
    requiresProvider: 'github',
  },
};

export function getToolMeta(key: string): AgentToolMeta | null {
  if ((KNOWN_AGENT_TOOLS as readonly string[]).includes(key)) {
    return AGENT_TOOL_LABELS[key as KnownAgentTool];
  }
  return null;
}
