import { z } from 'zod';

/**
 * Zod schemas for workspace-related route bodies + query strings.
 *
 * All object schemas use `.strict()` so unknown keys are rejected at the
 * boundary — the assistant in particular has historically smuggled extra
 * fields through, and we want those to fail loudly rather than silently
 * widen the stored shape.
 *
 * String size caps prevent abusive payloads from reaching the
 * normalizer / store; arrays cap at 200 entries (canvases can grow
 * large but not unboundedly so).
 */

// ---------------------------------------------------------------
// Field caps — generous but bounded. Sourced from the central
// `field-limits` module so the UI hints and Zod schemas share one
// definition; see src/lib/schemas/field-limits.ts.
// ---------------------------------------------------------------
import { FIELD_LIMITS, SUBCREW_LIMITS } from './field-limits';
const { SHORT, MEDIUM, LONG, PROMPT_MAX, ARR, RECIPIENTS_MAX } = FIELD_LIMITS;

// ---------------------------------------------------------------
// Sub-entity schemas — every field optional so they slot into a
// Partial<CrewStudioWorkspace> body without being filled in.
// ---------------------------------------------------------------

const ConnectionSchema = z
  .object({
    id: z.string().min(1).max(SHORT).default(() => crypto.randomUUID()),
    name: z.string().max(SHORT).optional(),
    description: z.string().max(MEDIUM).optional(),
    mode: z.literal('snowflake-api').optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    account: z
      .string()
      .max(SHORT)
      .regex(
        /^$|^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:\.[A-Za-z0-9-]+){0,3}$/,
        'invalid Snowflake account locator'
      )
      .optional(),
    user: z.string().max(SHORT).optional(),
    passwordEnvVar: z
      .string()
      .max(SHORT)
      .regex(/^$|^SNOWFLAKE_[A-Z0-9_]+$/, 'must start with SNOWFLAKE_')
      .optional(),
    warehouse: z.string().max(SHORT).optional(),
    database: z.string().max(SHORT).optional(),
    schema: z.string().max(SHORT).optional(),
    role: z.string().max(SHORT).optional(),
    queryGuide: z.string().max(LONG).optional(),
    toolName: z.string().max(SHORT).optional(),
    allowedTools: z.array(z.string().max(SHORT)).max(ARR).optional(),
    emailNotificationIntegration: z.string().max(SHORT).optional(),
    emailDefaultRecipients: z
      .array(z.string().max(SHORT))
      .max(RECIPIENTS_MAX)
      .optional(),
    notes: z.string().max(LONG).optional(),
  })
  .strict();

const AgentSchema = z
  .object({
    id: z.string().min(1).max(SHORT).default(() => crypto.randomUUID()),
    name: z.string().max(SHORT).optional(),
    role: z.string().max(MEDIUM).optional(),
    goal: z.string().max(MEDIUM).optional(),
    backstory: z.string().max(LONG).optional(),
    llm: z.string().max(SHORT).optional(),
    allowDelegation: z.boolean().optional(),
    verbose: z.boolean().optional(),
    maxIter: z.number().int().min(0).max(1_000).optional(),
    tools: z.array(z.string().max(SHORT)).max(ARR).optional(),
    knowledge: z.array(z.string().max(MEDIUM)).max(ARR).optional(),
    connectionIds: z.array(z.string().max(SHORT)).max(ARR).optional(),
    tags: z.array(z.string().max(SHORT)).max(ARR).optional(),
  })
  .strict();

const TaskSchema = z
  .object({
    id: z.string().min(1).max(SHORT).default(() => crypto.randomUUID()),
    name: z.string().max(SHORT).optional(),
    description: z.string().max(LONG).optional(),
    expectedOutput: z.string().max(LONG).optional(),
    agentId: z.string().max(SHORT).nullable().optional(),
    contextTaskIds: z.array(z.string().max(SHORT)).max(ARR).optional(),
    outputFile: z.string().max(SHORT).optional(),
    humanInput: z.boolean().optional(),
    asyncExecution: z.boolean().optional(),
    markdown: z.boolean().optional(),
  })
  .strict();

const ActionSchema = z
  .object({
    id: z.string().min(1).max(SHORT).default(() => crypto.randomUUID()),
    name: z.string().max(SHORT).optional(),
    type: z.literal('email').optional(),
    enabled: z.boolean().optional(),
    afterTaskId: z.string().max(SHORT).nullable().optional(),
    connectionId: z.string().max(SHORT).nullable().optional(),
    recipients: z.array(z.string().max(SHORT)).max(RECIPIENTS_MAX).optional(),
    subject: z.string().max(SHORT).optional(),
    emailBodyMode: z.enum(['clean', 'raw-html']).optional(),
    notes: z.string().max(LONG).optional(),
  })
  .strict();

const CrewSchema = z
  .object({
    id: z.string().min(1).max(SHORT).default(() => crypto.randomUUID()),
    name: z.string().max(SHORT).optional(),
    description: z.string().max(MEDIUM).optional(),
    process: z.enum(['sequential', 'hierarchical']).optional(),
    agentIds: z.array(z.string().max(SHORT)).max(ARR).optional(),
    taskIds: z.array(z.string().max(SHORT)).max(ARR).optional(),
    managerAgentId: z.string().max(SHORT).nullable().optional(),
    memory: z.boolean().optional(),
    planning: z.boolean().optional(),
    verbose: z.boolean().optional(),
    tags: z.array(z.string().max(SHORT)).max(ARR).optional(),
  })
  .strict();

/**
 * Sub-crew invocation entry (PR 20). Strict-mode so unknown fields are
 * rejected at the API boundary; the normalizer fills any missing field
 * with a sensible default before the workspace hits the store.
 *
 * `maxInvocations` is capped at SUBCREW_LIMITS.MAX_INVOCATIONS_PER_BOX
 * (10). The Python SubCrewTool enforces the cap at runtime; this just
 * prevents nonsense values from reaching the exporter.
 */
const SubCrewInvocationSchema = z
  .object({
    id: z.string().min(1).max(SHORT).default(() => crypto.randomUUID()),
    name: z.string().max(SHORT).optional(),
    description: z.string().max(MEDIUM).optional(),
    targetCrewId: z.string().max(SHORT).optional(),
    maxInvocations: z
      .number()
      .int()
      .min(1)
      .max(SUBCREW_LIMITS.MAX_INVOCATIONS_PER_BOX)
      .optional(),
    inputMapping: z.string().max(LONG).optional(),
    successCriteria: z.string().max(MEDIUM).nullable().optional(),
    contextMode: z.literal('isolated').optional(),
    tags: z.array(z.string().max(SHORT)).max(ARR).optional(),
  })
  .strict();

const CanvasLayoutSchema = z
  .object({
    nodes: z
      .record(
        z.string(),
        z
          .object({ x: z.number(), y: z.number() })
          .strict()
      )
      .optional(),
    zoom: z.number().optional(),
    panX: z.number().optional(),
    panY: z.number().optional(),
  })
  .strict();

/**
 * Shared workspace shape — every field optional, used by:
 *   - POST /api/workspaces        (create)
 *   - PATCH /api/workspaces/[id]  (update)
 *   - POST /api/workspaces/assistant (the inbound workspace blob)
 *
 * NOTE: id / createdAt / updatedAt / ownerId are owned server-side
 * and excluded — clients should not send them.
 */
const WorkspaceShape = {
  repoPath: z.string().max(LONG).nullable().optional(),
  name: z.string().max(SHORT).optional(),
  description: z.string().max(LONG).optional(),
  productBrief: z.string().max(LONG).optional(),
  defaultLlm: z.string().max(SHORT).optional(),
  tags: z.array(z.string().max(SHORT)).max(ARR).optional(),
  agents: z.array(AgentSchema).max(ARR).optional(),
  tasks: z.array(TaskSchema).max(ARR).optional(),
  actions: z.array(ActionSchema).max(ARR).optional(),
  crews: z.array(CrewSchema).max(ARR).optional(),
  connections: z.array(ConnectionSchema).max(ARR).optional(),
  // Sub-crew invocations (PR 20). Optional for backwards compat;
  // the normalizer fills the array (or []) on every save.
  subCrewInvocations: z.array(SubCrewInvocationSchema).max(ARR).optional(),
  canvasLayout: CanvasLayoutSchema.optional(),
} as const;

export const WorkspacePartialSchema = z.object(WorkspaceShape).strict();
export type WorkspacePartial = z.infer<typeof WorkspacePartialSchema>;

// ---------------------------------------------------------------
// Route-specific bodies + queries
// ---------------------------------------------------------------

/** POST /api/workspaces */
export const CreateWorkspaceBody = z
  .object({
    repoPath: z.string().max(LONG).nullable().optional(),
    name: z.string().max(SHORT).optional(),
    description: z.string().max(LONG).optional(),
    templateKey: z.enum(['blank', 'starter', 'snowflake-usage', 'data-analysis', 'coordinator']).optional(),
  })
  .strict();
export type CreateWorkspaceBodyT = z.infer<typeof CreateWorkspaceBody>;

/** PATCH /api/workspaces/[id] — same shape as the Partial workspace. */
export const UpdateWorkspaceBody = WorkspacePartialSchema;
export type UpdateWorkspaceBodyT = z.infer<typeof UpdateWorkspaceBody>;

/** POST /api/workspaces/[id]/clone — all fields optional. */
export const CloneWorkspaceBody = z
  .object({
    /** Optional new workspace name. Defaults to '<source> (copy)'. */
    name: z.string().max(SHORT).optional(),
  })
  .strict();
export type CloneWorkspaceBodyT = z.infer<typeof CloneWorkspaceBody>;

/** GET /api/workspaces query string. */
export const WorkspacesListQuery = z
  .object({
    repoPath: z.string().max(LONG).optional(),
  })
  .strict();
export type WorkspacesListQueryT = z.infer<typeof WorkspacesListQuery>;

/** POST /api/workspaces/assistant */
export const AssistantBody = z
  .object({
    workspace: WorkspacePartialSchema,
    prompt: z.string().min(1).max(PROMPT_MAX),
    selectedEntity: z
      .object({
        kind: z.string().max(SHORT),
        id: z.string().max(SHORT).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    validationIssues: z
      .array(
        z
          .object({
            id: z.string().max(SHORT),
            severity: z.enum(['error', 'warning', 'info']),
            code: z.string().max(SHORT),
            message: z.string().max(MEDIUM),
            target: z
              .object({
                kind: z.enum(['agent', 'task', 'action', 'connection', 'crew']),
                id: z.string().max(SHORT),
              })
              .strict()
              .optional(),
          })
          .strict()
      )
      .max(ARR)
      .optional(),
    assistantMode: z.enum(['auto', 'sonnet', 'opus']).optional(),
  })
  .strict();
export type AssistantBodyT = z.infer<typeof AssistantBody>;
