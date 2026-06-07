import { NextResponse } from 'next/server';
import { normalizeCrewStudioWorkspace } from '@/lib/crew-studio';
import { CORTEX_MODEL_CANDIDATES } from '@/lib/cortex-models';
import { getSnowflakeAuth, snowflakeAuthHeaders } from '@/lib/snowflake-auth';
import {
  ErrorCodes,
  errorResponse,
  requireCaller,
} from '@/lib/schemas/common';
import { AssistantBody } from '@/lib/schemas/workspaces';
import { getCrewStudioWorkspace } from '@/lib/crew-studio-store';
import { evaluatePrecondition } from '@/lib/workspace/if-match';
import { loggerWithContext } from '@/lib/logger';
import type { CrewStudioWorkspace } from '@/types';

export const runtime = 'nodejs';

const log = loggerWithContext({ route: '/api/workspaces/assistant' });

type AssistantMode = 'auto' | 'sonnet' | 'opus';

/** Concrete Cortex model id for each user-facing tier. */
const ASSISTANT_MODELS: Record<'sonnet' | 'opus', string> = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

/**
 * Auto-mode heuristic: route the request to opus when the work looks
 * non-trivial, otherwise stay on sonnet (cheaper + faster).
 *
 * Signals favoring opus:
 *   - Long prompts (more context to reason over)
 *   - Many entities already in the workspace (more graph to keep coherent)
 *   - Multiple open validation issues (multi-step fix)
 *   - Build/redesign/architect verbs in the prompt
 */
function isComplexRequest(
  prompt: string,
  workspace: CrewStudioWorkspace,
  issuesCount: number
): boolean {
  if (prompt.length > 240) return true;
  if (workspace.agents.length > 5) return true;
  if (workspace.tasks.length > 8) return true;
  if (issuesCount > 4) return true;
  return /\b(build|redesign|architect|overhaul|refactor|create a complete|from scratch|rewrite)\b/i.test(prompt);
}

function chooseAssistantModel(
  mode: AssistantMode | undefined,
  prompt: string,
  workspace: CrewStudioWorkspace,
  issuesCount: number
): string {
  if (mode === 'sonnet') return ASSISTANT_MODELS.sonnet;
  if (mode === 'opus') return ASSISTANT_MODELS.opus;
  // 'auto' (default)
  return isComplexRequest(prompt, workspace, issuesCount)
    ? ASSISTANT_MODELS.opus
    : ASSISTANT_MODELS.sonnet;
}

type AssistantResponsePayload = {
  summary?: string;
  changes?: string[];
  workspace?: Partial<CrewStudioWorkspace>;
};

function extractJsonObject(value: string): AssistantResponsePayload {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('Assistant did not return a JSON object.');
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as AssistantResponsePayload;
}

function extractAssistantText(payload: unknown): string {
  const value = payload as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    message?: { content?: unknown };
    output?: unknown;
  };

  const content = value.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
        return '';
      })
      .join('');
  }
  if (typeof value.choices?.[0]?.text === 'string') return value.choices[0].text;
  if (typeof value.message?.content === 'string') return value.message.content;
  if (typeof value.output === 'string') return value.output;
  throw new Error('Assistant response did not include text content.');
}

function ensureCanvasPositions(workspace: CrewStudioWorkspace): CrewStudioWorkspace {
  const nodes = { ...workspace.canvasLayout.nodes };
  const ensure = (id: string, x: number, y: number) => {
    if (!nodes[id]) nodes[id] = { x, y };
  };

  ensure('trigger', 50, 200);
  workspace.tasks.forEach((task, index) => ensure(task.id, 340 + index * 300, 120));
  workspace.actions.forEach((action, index) => {
    const afterTask = action.afterTaskId ? nodes[action.afterTaskId] : null;
    ensure(action.id, (afterTask?.x || 760) + 260, (afterTask?.y || 160) + 120 + index * 40);
  });
  ensure('output', 900 + Math.max(workspace.tasks.length - 1, 0) * 300, 200);
  workspace.agents.forEach((agent, index) => ensure(agent.id, 340 + index * 300, 390));
  workspace.connections.forEach((connection, index) => ensure(connection.id, 50 + index * 280, 570));

  return {
    ...workspace,
    canvasLayout: {
      ...workspace.canvasLayout,
      nodes,
    },
  };
}

/**
 * Lock every agent's llm to the workspace's defaultLlm so the workspace
 * remains a single-model crew (matches the user's preference). Don't
 * overwrite defaultLlm itself — let the assistant change it via the
 * proposal if asked.
 */
function lockAgentModelsToDefault(workspace: CrewStudioWorkspace): CrewStudioWorkspace {
  const fallback = workspace.defaultLlm?.trim() || 'snowflake/claude-sonnet-4-6';
  return {
    ...workspace,
    agents: workspace.agents.map((agent) => ({ ...agent, llm: fallback })),
  };
}

/**
 * Strip everything the assistant doesn't need to make a good proposal.
 * Canvas positions get re-derived by ensureCanvasPositions; timestamps
 * get restored from the original; ids stay because the assistant needs
 * to reference existing entities by id.
 */
function trimWorkspaceForPrompt(workspace: CrewStudioWorkspace) {
  const { canvasLayout: _layout, createdAt: _c, updatedAt: _u, repoPath: _r, ...rest } = workspace;
  void _layout; void _c; void _u; void _r;
  return rest;
}

function buildSystemPrompt(): string {
  return [
    'You are the CrewAI Studio workflow builder assistant.',
    'You design and edit CrewAI workflows represented as JSON.',
    '',
    'Core semantics:',
    '- Agents define role, goal, backstory, llm, tools, knowledge, and connections.',
    '- Tasks define description, expectedOutput, agentId, and contextTaskIds (other task ids that must complete first).',
    '- Crews define ordered taskIds and included agentIds. Sequential is the default.',
    '- Actions are post-task hooks; the only action type is email. afterTaskId pins which task triggers them.',
    '- Connections are Snowflake API connections only. They power both tools (SnowflakeSearchTool) and email delivery (SYSTEM$SEND_EMAIL).',
    '',
    'Model rules:',
    '- The workspace has a `defaultLlm` field; every agent.llm must equal that value. The user controls the model via Workspace Settings, not via your proposals.',
    '- If the user asks to change the model, set `workspace.defaultLlm` to one of the IDs in `availableModels`. Never invent ids.',
    '',
    'Validation:',
    '- If `currentIssues` is non-empty, prioritize fixing those problems. Each issue has an `id` (entity id) and a human-readable `message`.',
    '- Keep existing Snowflake connections unless the user explicitly asks to change them.',
    '- Preserve existing entity ids unless the user is asking for net-new entities.',
    '',
    'Output:',
    '- Return a JSON object with this exact shape:',
    '  {"summary":"<short summary>","changes":["<bullet>","<bullet>"],"workspace":{...complete CrewStudioWorkspace...}}',
    '- The workspace field MUST be the complete updated workspace, not a patch. Include `agents`, `tasks`, `crews`, `actions`, `connections`, `defaultLlm`, `name`, `description`, `productBrief`, `tags`. The Studio reapplies canvas positions, ids, timestamps, and the locked agent llm — you do not need to send those.',
    '',
    'Examples:',
    '',
    'Add a single agent and assign an existing task to it:',
    '  { "agents":[{"id":"a-new","name":"summarizer","role":"Summarizer","goal":"Condense findings","backstory":"...","tools":[],"knowledge":[],"connectionIds":[],"tags":[]}], "tasks":[{"id":"t-existing","name":"summarize","description":"...","expectedOutput":"...","agentId":"a-new","contextTaskIds":[],"outputFile":"","humanInput":false,"asyncExecution":false,"markdown":true}] }',
    '',
    'Chain task B after task A via context dependency:',
    '  task B should have `"contextTaskIds":["A-id"]`',
    '',
    'Add an email action that fires after task X:',
    '  { "actions":[{"id":"act-1","name":"email_summary","type":"email","enabled":true,"afterTaskId":"X-id","connectionId":"<existing-connection-id>","recipients":["alerts@example.com"],"subject":"Daily summary","emailBodyMode":"clean","notes":""}] }',
  ].join('\n');
}

export async function POST(request: Request) {
  // Caller identity is injected by middleware; we read it here for
  // future ownership stamping. Today the assistant does not persist
  // anything, so the value is only used defensively.
  const authResult = requireCaller(request);
  if (!authResult.ok) return authResult.response;
  void authResult.caller;

  try {
    const raw = await request.json().catch(() => null);
    const parsed = AssistantBody.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(
        400,
        ErrorCodes.BAD_REQUEST,
        'Invalid body',
        parsed.error.flatten()
      );
    }
    const body = parsed.data;

    // The zod schema enforces a non-empty prompt, but the assistant has
    // historically also gated on whitespace-only prompts.
    if (!body.prompt.trim()) {
      return errorResponse(
        400,
        ErrorCodes.BAD_REQUEST,
        'Tell the assistant what to build or change.'
      );
    }

    // Cast: zod's parsed shape has deeply-optional fields, but the
    // normalizer accepts Partial<CrewStudioWorkspace> and fills in any
    // missing required entity fields, so a structural cast here is sound.
    const workspace = normalizeCrewStudioWorkspace(
      body.workspace as Partial<CrewStudioWorkspace>
    );
    const connection =
      workspace.connections.find((conn) => conn.enabled && conn.isDefault) ||
      workspace.connections.find((conn) => conn.enabled);

    if (!connection) {
      return errorResponse(
        400,
        ErrorCodes.BAD_REQUEST,
        'Add an enabled Snowflake API connection before using the assistant.'
      );
    }

    // In SPCS this returns the auto-mounted OAuth session token + the
    // internal hostname (no External Access Integration required).
    // Locally it falls back to the connection's passwordEnvVar / PAT.
    const auth = getSnowflakeAuth({
      fallbackAccount: connection.account,
      fallbackEnvVar: connection.passwordEnvVar.trim() || 'SNOWFLAKE_PAT',
    });
    if (!auth) {
      return errorResponse(
        400,
        ErrorCodes.BAD_REQUEST,
        'No Snowflake credentials available. In SPCS the session token mount is missing; locally set SNOWFLAKE_PAT (or SNOWFLAKE_JWT) and SNOWFLAKE_ACCOUNT_ID.'
      );
    }

    // PR 10: Optimistic-concurrency guard for the assistant flow.
    // The assistant doesn't write to the store, but a proposal built
    // from a stale snapshot will fail PATCH later — better to fail
    // fast than burn Cortex tokens on a doomed plan. We accept the
    // workspaceId via query string (since the body strips it) and
    // the same If-Match formats the PATCH route accepts.
    //
    // TODO: Assistant flow may want optimistic retry if the conflict
    // is only on server-owned fields; revisit if users hit this.
    const url = new URL(request.url);
    const workspaceIdParam = url.searchParams.get('workspaceId');
    if (workspaceIdParam) {
      const ifMatchHeader = request.headers.get('if-match');
      if (!ifMatchHeader) {
        return errorResponse(
          428,
          ErrorCodes.PRECONDITION_REQUIRED,
          'Assistant request requires If-Match header with last-known updatedAt.',
          undefined,
          { headers: { Vary: 'If-Match' } }
        );
      }
      const existing = getCrewStudioWorkspace(workspaceIdParam, authResult.caller.user);
      if (existing) {
        const decision = evaluatePrecondition(ifMatchHeader, existing.updatedAt);
        if (decision.kind === 'mismatch') {
          return errorResponse(
            412,
            ErrorCodes.PRECONDITION_FAILED,
            'Workspace was modified in another session.',
            { currentUpdatedAt: decision.currentUpdatedAt },
            { headers: { Vary: 'If-Match' } }
          );
        }
      }
      // If existing is null we don't 404 here — the assistant body
      // carries its own (possibly newly-created) workspace blob, so a
      // missing-on-server case is permissible for the assistant flow.
    }

    const validationIssues = body.validationIssues ?? [];
    const assistantModel = chooseAssistantModel(
      body.assistantMode,
      body.prompt,
      workspace,
      validationIssues.length
    );

    const userPayload = {
      request: body.prompt,
      selectedEntity: body.selectedEntity || null,
      currentIssues: validationIssues.map((issue) => ({
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        target: issue.target,
      })),
      availableModels: CORTEX_MODEL_CANDIDATES.map((m) => `snowflake/${m.id}`),
      workspace: trimWorkspaceForPrompt(workspace),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(`https://${auth.host}/api/v2/cortex/inference:complete`, {
        method: 'POST',
        signal: controller.signal,
        headers: snowflakeAuthHeaders(auth),
        body: JSON.stringify({
          model: assistantModel,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: JSON.stringify(userPayload, null, 2) },
          ],
          max_tokens: 12000,
        }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Wave-1 timeout path — 60s ceiling on the Cortex round-trip.
        return errorResponse(
          504,
          ErrorCodes.TIMEOUT,
          'Assistant request timed out'
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
      log.error(
        { status: response.status, bodyPreview: responseText.slice(0, 500) },
        'Cortex non-2xx response'
      );
      return errorResponse(
        502,
        ErrorCodes.BAD_UPSTREAM,
        `Snowflake assistant call failed with HTTP ${response.status}.`
      );
    }

    const assistantText = extractAssistantText(JSON.parse(responseText));
    const proposal = extractJsonObject(assistantText);
    if (!proposal.workspace) {
      return errorResponse(
        502,
        ErrorCodes.BAD_UPSTREAM,
        'Assistant response did not include a workspace.'
      );
    }

    const proposedWorkspace = ensureCanvasPositions(
      lockAgentModelsToDefault(
        normalizeCrewStudioWorkspace({
          ...workspace,
          ...(proposal.workspace as Partial<CrewStudioWorkspace>),
          id: workspace.id,
          repoPath: workspace.repoPath,
          createdAt: workspace.createdAt,
          updatedAt: new Date().toISOString(),
        })
      )
    );

    return NextResponse.json({
      model: assistantModel,
      summary: proposal.summary || 'Assistant proposed workflow changes.',
      changes: Array.isArray(proposal.changes) ? proposal.changes.filter(Boolean).map(String) : [],
      workspace: proposedWorkspace,
    });
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error), errName: error instanceof Error ? error.name : 'unknown' }, 'unhandled');
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Assistant failed.');
  }
}
