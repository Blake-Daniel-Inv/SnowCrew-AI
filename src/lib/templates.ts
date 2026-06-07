import { v4 as uuid } from 'uuid';
import type { CrewStudioWorkspace } from '@/types';
import { normalizeCrewStudioWorkspace } from './crew-studio';

/**
 * Pull template defaults from the operator's shell so each user's
 * templates auto-fill with their account/user, instead of inheriting
 * whoever-built-this-app's identifiers. Falls back to empty strings,
 * which surface as "Needs setup" warnings rather than silently using
 * someone else's credentials.
 */
const DEFAULT_SNOWFLAKE_ACCOUNT =
  process.env.SNOWFLAKE_ACCOUNT_ID?.trim() ||
  process.env.SNOWFLAKE_ACCOUNT?.trim() ||
  '';
const DEFAULT_SNOWFLAKE_USER =
  process.env.SNOWFLAKE_USER?.trim() ||
  process.env.SNOWFLAKE_USERNAME?.trim() ||
  '';

export type WorkspaceTemplateKey =
  | 'blank'
  | 'starter'
  | 'snowflake-usage'
  | 'data-analysis'
  | 'coordinator';

export interface WorkspaceTemplateMeta {
  key: WorkspaceTemplateKey;
  title: string;
  description: string;
  tags: string[];
}

export interface WorkspaceTemplate extends WorkspaceTemplateMeta {
  build: (repoPath?: string | null) => CrewStudioWorkspace;
}

function prettyRepoName(repoPath: string | null): string {
  if (!repoPath) return 'CrewAI Workspace';
  const parts = repoPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'CrewAI Workspace';
}

/* ------------------------------------------------------------------ */
/*  Blank (minimal starting point)                                    */
/* ------------------------------------------------------------------ */

function createBlankWorkspace(repoPath?: string | null): CrewStudioWorkspace {
  const now = new Date().toISOString();
  const repoLabel = prettyRepoName(repoPath || null);
  return normalizeCrewStudioWorkspace({
    id: uuid(),
    repoPath: repoPath || null,
    name: `${repoLabel} Workspace`,
    description: 'A blank workspace. Drag components from the left panel to get started.',
    productBrief: '',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: [],
    connections: [],
    agents: [],
    tasks: [],
    crews: [],
    canvasLayout: {
      nodes: { trigger: { x: 100, y: 250 }, output: { x: 900, y: 250 } },
      zoom: 1,
      panX: 0,
      panY: 0,
    },
    createdAt: now,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ */
/*  Starter — default Snowflake ops crew                              */
/* ------------------------------------------------------------------ */

function createStarterWorkspace(repoPath?: string | null): CrewStudioWorkspace {
  const apiConnectionId = uuid();
  const analystId = uuid();
  const reporterId = uuid();
  const auditTaskId = uuid();
  const briefTaskId = uuid();
  const crewId = uuid();
  const repoLabel = prettyRepoName(repoPath || null);
  const now = new Date().toISOString();

  return normalizeCrewStudioWorkspace({
    id: uuid(),
    repoPath: repoPath || null,
    name: `${repoLabel} Snowflake Ops`,
    description:
      'A local CrewAI planning workspace for data-intensive crews, with direct Snowflake API access for tool routing.',
    productBrief:
      'CrewAI markets a control plane for managing crews, integrations, tracing, and rollout confidence. This local studio mirrors that idea for offline planning and export, anchored around Snowflake-ready crews. All LLM traffic is routed through Snowflake Cortex via LiteLLM.',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: ['snowflake', 'crewai', 'ops'],
    connections: [
      {
        id: apiConnectionId,
        name: 'Primary Snowflake API',
        description: 'Direct warehouse access through SnowflakeSearchTool for deterministic SQL and semantic lookup.',
        mode: 'snowflake-api',
        enabled: true,
        isDefault: true,
        account: DEFAULT_SNOWFLAKE_ACCOUNT,
        user: DEFAULT_SNOWFLAKE_USER,
        passwordEnvVar: 'SNOWFLAKE_PAT',
        warehouse: 'COMPUTE_WH',
        database: 'OPERATIONS',
        schema: 'PUBLIC',
        role: '',
        queryGuide: 'Prefer read-only analytical queries, summarize large result sets, and surface upstream table assumptions.',
        toolName: 'snowflake_search',
        allowedTools: ['run_sql', 'semantic_search'],
        emailNotificationIntegration: '',
        emailDefaultRecipients: [],
        notes: 'Best for curated warehouse analysis and scheduled reporting.',
      },
    ],
    agents: [
      {
        id: analystId,
        name: 'warehouse_analyst',
        role: 'Snowflake warehouse analyst',
        goal: 'Inspect warehouse signals, detect anomalies, and ground findings in actual Snowflake assets.',
        backstory: 'Former analytics engineer who now operates as the crew’s fast, skeptical data investigator.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: true,
        verbose: true,
        maxIter: 14,
        tools: ['SnowflakeSearchTool', 'Schema diff notes'],
        knowledge: ['Warehouse naming conventions', 'Metric contract handbook'],
        connectionIds: [apiConnectionId],
        tags: ['data', 'snowflake'],
        subCrewToolIds: [],
      },
      {
        id: reporterId,
        name: 'ops_brief_writer',
        role: 'Operations brief writer',
        goal: 'Translate raw warehouse findings into a brief operators can act on quickly.',
        backstory: 'Synthesizes technical diagnostics into executive-ready briefs without losing the operational nuance.',
        llm: 'snowflake/claude-haiku-4-5',
        allowDelegation: false,
        verbose: true,
        maxIter: 10,
        tools: ['Markdown formatter', 'Decision memo template'],
        knowledge: ['Incident communication style guide'],
        connectionIds: [apiConnectionId],
        tags: ['reporting'],
        subCrewToolIds: [],
      },
    ],
    tasks: [
      {
        id: auditTaskId,
        name: 'audit_daily_snowflake_signals',
        description: 'Audit warehouse freshness, spend anomalies, and row-count drift for the operational marts that feed daily reporting.',
        expectedOutput: 'A concise anomaly list with SQL-backed evidence, suspected causes, and the exact tables involved.',
        agentId: analystId,
        contextTaskIds: [],
        outputFile: 'reports/snowflake-audit.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: briefTaskId,
        name: 'publish_ops_brief',
        description: 'Turn the audit findings into a high-signal operator brief with escalation guidance and next actions.',
        expectedOutput: 'A short markdown brief for operators plus a leadership summary that can be dropped into Slack or email.',
        agentId: reporterId,
        contextTaskIds: [auditTaskId],
        outputFile: 'reports/daily-ops-brief.md',
        humanInput: true,
        asyncExecution: false,
        markdown: true,
      },
    ],
    crews: [
      {
        id: crewId,
        name: 'snowflake_ops_crew',
        description: 'Primary operational crew that inspects Snowflake signals, then composes an operator-ready brief.',
        process: 'sequential',
        agentIds: [analystId, reporterId],
        taskIds: [auditTaskId, briefTaskId],
        managerAgentId: reporterId,
        memory: false,
        planning: true,
        verbose: true,
        tags: ['daily', 'ops'],
      },
    ],
    canvasLayout: {
      nodes: {
        trigger: { x: 50, y: 200 },
        [auditTaskId]: { x: 400, y: 120 },
        [briefTaskId]: { x: 750, y: 120 },
        [analystId]: { x: 400, y: 350 },
        [reporterId]: { x: 750, y: 350 },
        output: { x: 1100, y: 200 },
      },
      zoom: 1,
      panX: 0,
      panY: 0,
    },
    createdAt: now,
    updatedAt: now,
  });
}


/* ------------------------------------------------------------------ */
/*  Snowflake usage / cost review                                     */
/* ------------------------------------------------------------------ */

function createSnowflakeUsageWorkspace(repoPath?: string | null): CrewStudioWorkspace {
  const accountUsageConnId = uuid();
  const usageAnalystId = uuid();
  const optimizerId = uuid();
  const writerId = uuid();
  const metricsTaskId = uuid();
  const opportunitiesTaskId = uuid();
  const summaryTaskId = uuid();
  const crewId = uuid();
  const now = new Date().toISOString();

  return normalizeCrewStudioWorkspace({
    id: uuid(),
    repoPath: repoPath || null,
    name: 'Snowflake Usage & Cost Review',
    description: 'Recurring review of Snowflake consumption, heavy users, and cost-saving opportunities.',
    productBrief:
      'Monthly (or weekly) review that answers: who is using Snowflake the most, where are credits going, and where can we reduce spend without hurting productivity? Output is a FinOps-ready brief with actionable recommendations and estimated savings.',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: ['snowflake', 'cost', 'finops'],
    connections: [
      {
        id: accountUsageConnId,
        name: 'ACCOUNT_USAGE Reader',
        description: 'Read-only access to SNOWFLAKE.ACCOUNT_USAGE — the source of truth for credits, queries, and warehouse behavior.',
        mode: 'snowflake-api',
        enabled: true,
        isDefault: true,
        account: DEFAULT_SNOWFLAKE_ACCOUNT,
        user: DEFAULT_SNOWFLAKE_USER,
        passwordEnvVar: 'SNOWFLAKE_PAT',
        warehouse: 'COMPUTE_WH',
        database: 'SNOWFLAKE',
        schema: 'ACCOUNT_USAGE',
        role: '',
        queryGuide:
          'Key views: WAREHOUSE_METERING_HISTORY (credits per warehouse per hour), QUERY_HISTORY (per-query cost and duration), STORAGE_USAGE (per-database bytes), LOGIN_HISTORY, ACCESS_HISTORY. ACCOUNT_USAGE has up to 45-minute latency — good enough for cost review. Always filter by a time window to keep scans small.',
        toolName: 'account_usage_search',
        allowedTools: ['run_sql'],
        emailNotificationIntegration: '',
        emailDefaultRecipients: [],
        notes: 'Set this to the Snowflake role your PAT/default session should use, or leave blank to use the token/default role. Grant that role the ACCOUNT_USAGE database roles needed for FinOps.',
      },
    ],
    agents: [
      {
        id: usageAnalystId,
        name: 'usage_analyst',
        role: 'Snowflake usage analyst',
        goal: 'Produce a factual picture of who used Snowflake, for what, and how much, over the review window.',
        backstory:
          'Lives in ACCOUNT_USAGE. Knows the difference between what warehouse credits measure vs. storage vs. cloud services overhead, and never conflates them in a report.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: true,
        maxIter: 14,
        tools: ['account_usage_search'],
        knowledge: [
          'SNOWFLAKE.ACCOUNT_USAGE view semantics',
          'Credit vs. storage vs. cloud services billing',
          'How MV/auto-cluster costs show up',
        ],
        connectionIds: [accountUsageConnId],
        tags: ['data', 'finops'],
        subCrewToolIds: [],
      },
      {
        id: optimizerId,
        name: 'cost_optimizer',
        role: 'Cost optimization engineer',
        goal: 'Identify concrete cost-saving opportunities: oversized warehouses, long-running queries, idle resources, and unused features.',
        backstory:
          'Pragmatic FinOps engineer who separates real waste from "might save a few dollars" noise. Every recommendation includes an estimated credit savings and a confidence level.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: true,
        verbose: true,
        maxIter: 14,
        tools: ['account_usage_search'],
        knowledge: [
          'Warehouse auto-suspend / auto-resume tradeoffs',
          'Query result caching and how it shows up in history',
          'Storage lifecycle: time travel, fail-safe, retention policies',
          'Resource monitors and credit quotas',
        ],
        connectionIds: [accountUsageConnId],
        tags: ['finops', 'optimization'],
        subCrewToolIds: [],
      },
      {
        id: writerId,
        name: 'finops_brief_writer',
        role: 'FinOps report writer',
        goal: 'Compose an executive-ready brief from the usage analysis and optimization opportunities.',
        backstory:
          'Writes for finance leaders and engineering leads in the same document: top-line numbers first, per-team breakdown second, recommendations third.',
        llm: 'snowflake/claude-haiku-4-5',
        allowDelegation: false,
        verbose: true,
        maxIter: 8,
        tools: ['Markdown formatter'],
        knowledge: ['Company FinOps communication style', 'Executive summary conventions'],
        connectionIds: [],
        tags: ['reporting'],
        subCrewToolIds: [],
      },
    ],
    tasks: [
      {
        id: metricsTaskId,
        name: 'gather_usage_metrics',
        description:
          'For the last 30 days: total credits consumed, broken down by (1) warehouse, (2) user, (3) role, (4) query type (SELECT / DDL / COPY / etc). Also capture storage bytes by database and top 10 most-expensive queries. Use WAREHOUSE_METERING_HISTORY and QUERY_HISTORY.',
        expectedOutput:
          'A structured metrics section: total credits, per-warehouse breakdown, per-user top-10, per-role top-5, top-10 queries by credit cost, and storage per database.',
        agentId: usageAnalystId,
        contextTaskIds: [],
        outputFile: 'reports/snowflake-usage-metrics.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: opportunitiesTaskId,
        name: 'identify_cost_opportunities',
        description:
          'Using the metrics, identify (1) warehouses that could be downsized (sustained low utilization), (2) queries that should be rewritten or cached, (3) abandoned warehouses or users, (4) time-travel/retention settings that may exceed need, (5) auto-suspend opportunities. For each opportunity, estimate credit savings and rank by impact / effort.',
        expectedOutput:
          'Ranked list of cost opportunities. Each has: finding, evidence (numbers), recommended action, estimated monthly credit savings, and confidence (high/medium/low).',
        agentId: optimizerId,
        contextTaskIds: [metricsTaskId],
        outputFile: 'reports/snowflake-cost-opportunities.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: summaryTaskId,
        name: 'compose_executive_summary',
        description:
          'Combine the metrics and opportunities into a one-page FinOps brief with: headline number (total credits + trend vs. prior period), top 3 findings, top 3 recommended actions with estimated savings, and a per-team credit leaderboard. Keep tone factual, not dramatic.',
        expectedOutput:
          'A single markdown document under 1 page, suitable for Slack or email. Longer appendix with full analysis linked at the bottom.',
        agentId: writerId,
        contextTaskIds: [metricsTaskId, opportunitiesTaskId],
        outputFile: 'reports/snowflake-finops-brief.md',
        humanInput: true,
        asyncExecution: false,
        markdown: true,
      },
    ],
    crews: [
      {
        id: crewId,
        name: 'snowflake_finops_crew',
        description: 'Measure usage → identify opportunities → compose brief.',
        process: 'sequential',
        agentIds: [usageAnalystId, optimizerId, writerId],
        taskIds: [metricsTaskId, opportunitiesTaskId, summaryTaskId],
        managerAgentId: writerId,
        memory: false,
        planning: true,
        verbose: true,
        tags: ['monthly', 'finops'],
      },
    ],
    canvasLayout: {
      nodes: {
        trigger: { x: 50, y: 220 },
        [metricsTaskId]: { x: 380, y: 100 },
        [opportunitiesTaskId]: { x: 740, y: 100 },
        [summaryTaskId]: { x: 1100, y: 100 },
        [usageAnalystId]: { x: 380, y: 360 },
        [optimizerId]: { x: 740, y: 360 },
        [writerId]: { x: 1100, y: 360 },
        [accountUsageConnId]: { x: 560, y: 600 },
        output: { x: 1460, y: 220 },
      },
      zoom: 1,
      panX: 0,
      panY: 0,
    },
    createdAt: now,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ */
/*  Data analysis                                                     */
/* ------------------------------------------------------------------ */

function createDataAnalysisWorkspace(repoPath?: string | null): CrewStudioWorkspace {
  const warehouseConnId = uuid();
  const explorerId = uuid();
  const hypothesizerId = uuid();
  const analystId = uuid();
  const synthesizerId = uuid();
  const exploreTaskId = uuid();
  const hypothesesTaskId = uuid();
  const analyzeTaskId = uuid();
  const synthesizeTaskId = uuid();
  const crewId = uuid();
  const now = new Date().toISOString();

  return normalizeCrewStudioWorkspace({
    id: uuid(),
    repoPath: repoPath || null,
    name: 'Ad-hoc Data Analysis',
    description: 'Structured analysis crew: explore the data, generate hypotheses, test them, write the story.',
    productBrief:
      'Open-ended analysis framework. Point the crew at a dataset and a loose question ("what drives churn?", "why did revenue dip?", "are users onboarding differently?"), and it explores the schema, proposes testable hypotheses, runs the queries, and synthesizes findings into a narrative a stakeholder can read in one sitting.',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: ['analysis', 'data', 'research'],
    connections: [
      {
        id: warehouseConnId,
        name: 'Analytics Warehouse',
        description: 'Read-only access to the warehouse hosting the dataset under analysis.',
        mode: 'snowflake-api',
        enabled: true,
        isDefault: true,
        account: DEFAULT_SNOWFLAKE_ACCOUNT,
        user: DEFAULT_SNOWFLAKE_USER,
        passwordEnvVar: 'SNOWFLAKE_PAT',
        warehouse: 'COMPUTE_WH',
        database: 'ANALYTICS',
        schema: 'MARTS',
        role: '',
        queryGuide:
          'Always LIMIT exploratory queries. Prefer aggregate-first analysis over full scans. Use INFORMATION_SCHEMA for schema discovery. Flag any query scanning > 10 GB so the user can decide to proceed.',
        toolName: 'warehouse_search',
        allowedTools: ['run_sql', 'describe_table', 'sample_rows'],
        emailNotificationIntegration: '',
        emailDefaultRecipients: [],
        notes: 'Point this at whichever database/schema holds the data under analysis.',
      },
    ],
    agents: [
      {
        id: explorerId,
        name: 'schema_explorer',
        role: 'Schema and data explorer',
        goal: 'Map the dataset: what tables exist, what columns matter, what their distributions look like, and how they relate.',
        backstory:
          'Curious, careful, unwilling to skip the profiling step. Will run DESCRIBE and SAMPLE before any aggregation.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: true,
        maxIter: 12,
        tools: ['warehouse_search'],
        knowledge: ['INFORMATION_SCHEMA patterns', 'Data profiling heuristics (null rate, cardinality, outliers)'],
        connectionIds: [warehouseConnId],
        tags: ['exploration'],
        subCrewToolIds: [],
      },
      {
        id: hypothesizerId,
        name: 'hypothesis_generator',
        role: 'Analytical hypothesis generator',
        goal: 'Given the schema picture and the stakeholder question, propose 3-5 testable hypotheses ranked by likely impact.',
        backstory:
          'Thinks in terms of "what would falsify this?" rather than "what would confirm it?". Prefers a handful of sharp hypotheses over a long list of vague ones.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: true,
        maxIter: 8,
        tools: [],
        knowledge: ['Common analysis patterns (cohort, funnel, segmentation, time-series)'],
        connectionIds: [],
        tags: ['research'],
        subCrewToolIds: [],
      },
      {
        id: analystId,
        name: 'data_analyst',
        role: 'Quantitative data analyst',
        goal: 'For each hypothesis, design and run the SQL needed to test it, producing numeric evidence with confidence caveats.',
        backstory:
          'Writes efficient SQL, cross-checks results against a different slice of the data, and always reports effect sizes alongside p-values-equivalent language ("small / moderate / large" changes).',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: true,
        verbose: true,
        maxIter: 16,
        tools: ['warehouse_search'],
        knowledge: [
          'Snowflake SQL patterns (QUALIFY, CTE composition)',
          'Statistical literacy (confidence intervals, base rates)',
        ],
        connectionIds: [warehouseConnId],
        tags: ['analysis'],
        subCrewToolIds: [],
      },
      {
        id: synthesizerId,
        name: 'insight_synthesizer',
        role: 'Insight synthesizer',
        goal: 'Weave the evidence into a narrative: what was asked, what was found, what it means, and what to do next.',
        backstory:
          'Treats the reader as smart-but-time-constrained. Opens with the answer, supports with data, closes with action.',
        llm: 'snowflake/claude-haiku-4-5',
        allowDelegation: false,
        verbose: true,
        maxIter: 8,
        tools: ['Markdown formatter'],
        knowledge: ['Analytical writing conventions (BLUF, pyramid principle)'],
        connectionIds: [],
        tags: ['reporting'],
        subCrewToolIds: [],
      },
    ],
    tasks: [
      {
        id: exploreTaskId,
        name: 'explore_schema',
        description:
          'Discover and document the relevant tables in the target schema: what each contains, key columns, grain, typical row counts, and how they link. Profile 2-3 core columns per important table (distribution, null rate, cardinality).',
        expectedOutput:
          'A schema map: table list with grain, core columns, relationships, and profiling snapshots. No conclusions yet — just the lay of the land.',
        agentId: explorerId,
        contextTaskIds: [],
        outputFile: 'reports/analysis-schema.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: hypothesesTaskId,
        name: 'generate_hypotheses',
        description:
          'Read the stakeholder question (supplied at kickoff) and the schema map. Propose 3-5 testable hypotheses. Each hypothesis states: what the claim is, which tables/columns would test it, what pattern would confirm vs. falsify it, and expected impact if true.',
        expectedOutput:
          'A numbered list of hypotheses, each with confirm/falsify criteria and impact estimate.',
        agentId: hypothesizerId,
        contextTaskIds: [exploreTaskId],
        outputFile: 'reports/analysis-hypotheses.md',
        humanInput: true,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: analyzeTaskId,
        name: 'run_analysis',
        description:
          'Test each hypothesis with SQL. Report numeric evidence, effect size, and any caveats (sample size, time window, data quality issues encountered). If a hypothesis is inconclusive, say so and explain why.',
        expectedOutput:
          'Per-hypothesis findings with query, result summary, effect size, and confidence. Flag any hypotheses that warrant follow-up.',
        agentId: analystId,
        contextTaskIds: [exploreTaskId, hypothesesTaskId],
        outputFile: 'reports/analysis-findings.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: synthesizeTaskId,
        name: 'synthesize_insights',
        description:
          'Write a narrative report for the stakeholder. Lead with the bottom line (BLUF). Support with the strongest 2-3 pieces of evidence. Close with recommended actions and what to investigate next.',
        expectedOutput:
          'One-page narrative + appendix with full per-hypothesis analysis linked.',
        agentId: synthesizerId,
        contextTaskIds: [analyzeTaskId],
        outputFile: 'reports/analysis-report.md',
        humanInput: true,
        asyncExecution: false,
        markdown: true,
      },
    ],
    crews: [
      {
        id: crewId,
        name: 'data_analysis_crew',
        description: 'Structured 4-step analysis: explore → hypothesize → analyze → synthesize.',
        process: 'sequential',
        agentIds: [explorerId, hypothesizerId, analystId, synthesizerId],
        taskIds: [exploreTaskId, hypothesesTaskId, analyzeTaskId, synthesizeTaskId],
        managerAgentId: synthesizerId,
        memory: false,
        planning: true,
        verbose: true,
        tags: ['analysis'],
      },
    ],
    canvasLayout: {
      nodes: {
        trigger: { x: 50, y: 240 },
        [exploreTaskId]: { x: 340, y: 100 },
        [hypothesesTaskId]: { x: 640, y: 100 },
        [analyzeTaskId]: { x: 940, y: 100 },
        [synthesizeTaskId]: { x: 1240, y: 100 },
        [explorerId]: { x: 340, y: 360 },
        [hypothesizerId]: { x: 640, y: 360 },
        [analystId]: { x: 940, y: 360 },
        [synthesizerId]: { x: 1240, y: 360 },
        [warehouseConnId]: { x: 640, y: 600 },
        output: { x: 1580, y: 240 },
      },
      zoom: 1,
      panX: 0,
      panY: 0,
    },
    createdAt: now,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ */
/*  Coordinator — sub-crew orchestration demo (PR 21)                 */
/* ------------------------------------------------------------------ */

/**
 * Coordinator template: a 4-crew workspace where a lead agent in the
 * Coordinator crew calls the three specialist crews (Research, Review,
 * Implementation) via sub-crew invocations. Each invocation is bounded
 * by `maxInvocations` so the lead can re-call with refined inputs but
 * cannot runaway-loop.
 *
 * This is the working canonical example users can spin up to see the
 * sub-crew feature end-to-end (canvas visual + agent-side picker +
 * editor + Python exporter from PR 20).
 */
function createCoordinatorWorkspace(repoPath?: string | null): CrewStudioWorkspace {
  const apiConnectionId = uuid();
  // Agents
  const coordinatorAgentId = uuid();
  const researcherAgentId = uuid();
  const reviewerAgentId = uuid();
  const implementerAgentId = uuid();
  // Tasks
  const coordTaskId = uuid();
  const researchTaskId = uuid();
  const reviewTaskId = uuid();
  const implementTaskId = uuid();
  // Crews
  const coordCrewId = uuid();
  const researchCrewId = uuid();
  const reviewCrewId = uuid();
  const implementCrewId = uuid();
  // Sub-crew invocations
  const invResearchId = uuid();
  const invReviewId = uuid();
  const invImplementId = uuid();

  const repoLabel = prettyRepoName(repoPath || null);
  const now = new Date().toISOString();

  return normalizeCrewStudioWorkspace({
    id: uuid(),
    repoPath: repoPath || null,
    name: `${repoLabel} Coordinator`,
    description:
      'A Coordinator crew whose lead agent calls three specialist crews (Research, Review, Implementation) as tools.',
    productBrief:
      'Demonstrates the Coordinator pattern: a lead agent decomposes a task, calls specialist sub-crews via tools, observes their output, and re-invokes with refined inputs until success criteria are met. Each invocation is bounded by maxInvocations so the lead cannot runaway-loop.',
    defaultLlm: 'snowflake/claude-sonnet-4-6',
    tags: ['coordinator', 'sub-crew', 'demo'],
    connections: [
      {
        id: apiConnectionId,
        name: 'Primary Snowflake API',
        description: 'Shared connection used by the specialist crews when they need warehouse access.',
        mode: 'snowflake-api',
        enabled: true,
        isDefault: true,
        account: DEFAULT_SNOWFLAKE_ACCOUNT,
        user: DEFAULT_SNOWFLAKE_USER,
        passwordEnvVar: 'SNOWFLAKE_PAT',
        warehouse: 'COMPUTE_WH',
        database: 'OPERATIONS',
        schema: 'PUBLIC',
        role: '',
        queryGuide: 'Prefer read-only analytical queries and summarize large result sets.',
        toolName: 'snowflake_search',
        allowedTools: ['run_sql', 'semantic_search'],
        emailNotificationIntegration: '',
        emailDefaultRecipients: [],
        notes: '',
      },
    ],
    agents: [
      {
        id: coordinatorAgentId,
        name: 'project_coordinator',
        role: 'Project coordinator',
        goal: 'Decompose the user request into research, review, and implementation sub-tasks. Invoke the appropriate sub-crew, observe its output, and re-invoke with refined inputs until each phase meets its success criteria.',
        backstory: 'Senior engineering coordinator who treats specialist crews as callable tools rather than human teams. Always checks output quality before moving to the next phase.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: true,
        verbose: true,
        maxIter: 18,
        tools: [],
        knowledge: ['Project decomposition patterns', 'Success-criteria framing'],
        connectionIds: [],
        tags: ['coordinator'],
        // Wired below in `pruneSubCrewToolIdsOnAgents` after the
        // invocations are materialized. We seed all three here so the
        // normalizer can validate they form a valid (non-cyclic) DAG.
        subCrewToolIds: [invResearchId, invReviewId, invImplementId],
      },
      {
        id: researcherAgentId,
        name: 'researcher',
        role: 'Domain researcher',
        goal: 'Gather facts, sources, and context relevant to the coordinator\'s research request.',
        backstory: 'Methodical researcher who cites sources and flags uncertainty rather than fabricating it.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: true,
        maxIter: 12,
        tools: ['snowflake_search'],
        knowledge: [],
        connectionIds: [apiConnectionId],
        tags: ['research'],
        subCrewToolIds: [],
      },
      {
        id: reviewerAgentId,
        name: 'critical_reviewer',
        role: 'Critical reviewer',
        goal: 'Critique the research artifact for completeness, accuracy, and actionability.',
        backstory: 'Skeptical-by-default reviewer who asks "what is missing?" before "what is correct?".',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: true,
        maxIter: 10,
        tools: [],
        knowledge: ['Review rubrics for technical work'],
        connectionIds: [],
        tags: ['review'],
        subCrewToolIds: [],
      },
      {
        id: implementerAgentId,
        name: 'implementer',
        role: 'Implementation engineer',
        goal: 'Turn the reviewed research into a concrete, deliverable artifact (code, plan, or document).',
        backstory: 'Pragmatic engineer who scopes to the smallest thing that works, then iterates.',
        llm: 'snowflake/claude-sonnet-4-6',
        allowDelegation: false,
        verbose: true,
        maxIter: 14,
        tools: ['snowflake_search'],
        knowledge: [],
        connectionIds: [apiConnectionId],
        tags: ['implementation'],
        subCrewToolIds: [],
      },
    ],
    tasks: [
      {
        id: coordTaskId,
        name: 'coordinate_delivery',
        description: 'Receive the user request, decide which sub-crews to invoke and in what order, and assemble the final deliverable from their outputs.',
        expectedOutput: 'A single final artifact that satisfies the user request, with a brief log of which sub-crews were called and why.',
        agentId: coordinatorAgentId,
        contextTaskIds: [],
        outputFile: 'reports/coordinator-output.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: researchTaskId,
        name: 'gather_research',
        description: 'Gather facts and context for the topic the coordinator requested.',
        expectedOutput: 'Structured research notes with cited sources where available.',
        agentId: researcherAgentId,
        contextTaskIds: [],
        outputFile: 'reports/research.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: reviewTaskId,
        name: 'review_artifact',
        description: 'Critically review the input artifact and surface gaps, errors, or weak claims.',
        expectedOutput: 'A review with a verdict (approve / revise) and a concrete list of changes needed.',
        agentId: reviewerAgentId,
        contextTaskIds: [],
        outputFile: 'reports/review.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
      {
        id: implementTaskId,
        name: 'implement_solution',
        description: 'Turn the reviewed plan into a concrete deliverable.',
        expectedOutput: 'A complete implementation artifact (code, document, or plan) ready for hand-off.',
        agentId: implementerAgentId,
        contextTaskIds: [],
        outputFile: 'reports/implementation.md',
        humanInput: false,
        asyncExecution: false,
        markdown: true,
      },
    ],
    crews: [
      {
        id: coordCrewId,
        name: 'coordinator_crew',
        description: 'The orchestrating crew. The coordinator agent invokes the three specialist crews as tools.',
        process: 'sequential',
        agentIds: [coordinatorAgentId],
        taskIds: [coordTaskId],
        managerAgentId: coordinatorAgentId,
        memory: false,
        planning: true,
        verbose: true,
        tags: ['coordinator'],
      },
      {
        id: researchCrewId,
        name: 'research_crew',
        description: 'Specialist crew: gather research on a topic.',
        process: 'sequential',
        agentIds: [researcherAgentId],
        taskIds: [researchTaskId],
        managerAgentId: null,
        memory: false,
        planning: true,
        verbose: true,
        tags: ['research'],
      },
      {
        id: reviewCrewId,
        name: 'review_crew',
        description: 'Specialist crew: review an artifact.',
        process: 'sequential',
        agentIds: [reviewerAgentId],
        taskIds: [reviewTaskId],
        managerAgentId: null,
        memory: false,
        planning: true,
        verbose: true,
        tags: ['review'],
      },
      {
        id: implementCrewId,
        name: 'implementation_crew',
        description: 'Specialist crew: implement a solution.',
        process: 'sequential',
        agentIds: [implementerAgentId],
        taskIds: [implementTaskId],
        managerAgentId: null,
        memory: false,
        planning: true,
        verbose: true,
        tags: ['implementation'],
      },
    ],
    subCrewInvocations: [
      {
        id: invResearchId,
        name: 'call_research_crew',
        description: 'Invoke the Research crew to gather facts and context on a topic. Returns structured research notes.',
        targetCrewId: researchCrewId,
        maxInvocations: 3,
        inputMapping: 'Pass a clear research question and any constraints (recency, sources to prefer, scope). The Research crew returns structured notes.',
        successCriteria: 'Result covers the requested scope with at least 3 distinct findings and cites sources where available.',
        contextMode: 'isolated',
        tags: ['research'],
      },
      {
        id: invReviewId,
        name: 'call_review_crew',
        description: 'Invoke the Review crew to critically review an artifact. Returns a verdict (approve / revise) and a list of changes needed.',
        targetCrewId: reviewCrewId,
        maxInvocations: 2,
        inputMapping: 'Pass the artifact to be reviewed plus the review criteria. The Review crew returns a verdict and a concrete list of changes.',
        successCriteria: 'Result includes a verdict and at least one specific recommendation (or "approve as-is" with justification).',
        contextMode: 'isolated',
        tags: ['review'],
      },
      {
        id: invImplementId,
        name: 'call_implementation_crew',
        description: 'Invoke the Implementation crew to produce a concrete deliverable from a reviewed plan.',
        targetCrewId: implementCrewId,
        maxInvocations: 3,
        inputMapping: 'Pass the reviewed plan plus any constraints (format, scope, deadline). The Implementation crew returns a complete artifact.',
        successCriteria: 'Result is a complete artifact that satisfies the input plan and is ready for hand-off.',
        contextMode: 'isolated',
        tags: ['implementation'],
      },
    ],
    canvasLayout: {
      nodes: {
        trigger: { x: 50, y: 240 },
        [coordTaskId]: { x: 400, y: 100 },
        [coordinatorAgentId]: { x: 400, y: 340 },
        [researchTaskId]: { x: 900, y: 60 },
        [researcherAgentId]: { x: 900, y: 300 },
        [reviewTaskId]: { x: 900, y: 480 },
        [reviewerAgentId]: { x: 900, y: 720 },
        [implementTaskId]: { x: 1300, y: 60 },
        [implementerAgentId]: { x: 1300, y: 300 },
        [`subcrew-${invResearchId}`]: { x: 700, y: 200 },
        [`subcrew-${invReviewId}`]: { x: 700, y: 480 },
        [`subcrew-${invImplementId}`]: { x: 1100, y: 200 },
        [researchCrewId]: { x: 1500, y: 200 },
        [reviewCrewId]: { x: 1500, y: 480 },
        [implementCrewId]: { x: 1500, y: 720 },
        output: { x: 1800, y: 240 },
      },
      zoom: 0.7,
      panX: 0,
      panY: 0,
    },
    createdAt: now,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ */
/*  Registry                                                          */
/* ------------------------------------------------------------------ */

export const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    key: 'starter',
    title: 'Starter — Snowflake Ops',
    description: 'Default audit + brief crew with a Snowflake API connection.',
    tags: ['snowflake', 'starter'],
    build: createStarterWorkspace,
  },
  {
    key: 'snowflake-usage',
    title: 'Snowflake Usage & Cost',
    description: 'Who uses Snowflake, how much, where to save.',
    tags: ['finops', 'snowflake'],
    build: createSnowflakeUsageWorkspace,
  },
  {
    key: 'data-analysis',
    title: 'Ad-hoc Data Analysis',
    description: 'Explore → hypothesize → analyze → synthesize.',
    tags: ['analysis', 'research'],
    build: createDataAnalysisWorkspace,
  },
  {
    key: 'coordinator',
    title: 'Coordinator — Sub-crew demo',
    description: 'A lead agent calls Research, Review, and Implementation crews as tools.',
    tags: ['coordinator', 'sub-crew', 'demo'],
    build: createCoordinatorWorkspace,
  },
  {
    key: 'blank',
    title: 'Blank',
    description: 'Start from scratch.',
    tags: [],
    build: createBlankWorkspace,
  },
];

export function getTemplate(key: WorkspaceTemplateKey): WorkspaceTemplate {
  const tpl = WORKSPACE_TEMPLATES.find((t) => t.key === key);
  if (!tpl) {
    throw new Error(`Unknown workspace template: ${key}`);
  }
  return tpl;
}

export function buildFromTemplate(
  key: WorkspaceTemplateKey,
  repoPath?: string | null
): CrewStudioWorkspace {
  return getTemplate(key).build(repoPath);
}

/** Back-compat helper used by the store's legacy code path. */
export function createStarterCrewStudioWorkspace(
  repoPath?: string | null
): CrewStudioWorkspace {
  return createStarterWorkspace(repoPath);
}
