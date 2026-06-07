'use client';

import { useId, useState } from 'react';
import { isCrewStudioConnectionReady } from '@/lib/crew-studio';
import { AGENT_TOOL_LABELS, KNOWN_AGENT_TOOLS } from '@/lib/workspace/tool-registry';
import { findCredential, useUserCredentials } from './useUserCredentials';
import { LlmModelSelect } from './LlmModelSelect';
import { TaskContextPicker } from './TaskContextPicker';
import { AgentSubCrewToolsPicker } from './AgentSubCrewToolsPicker';
import { SubCrewInvocationEditor } from './SubCrewInvocationEditor';
import { FieldCounter, isPatternInvalid } from './FieldHints';
import { FIELD_LIMITS, FIELD_PATTERNS } from '@/lib/schemas/field-limits';
import type {
  ConnectionTestResult,
  CrewRun,
  CrewStudioAgent,
  CrewStudioAction,
  CrewStudioConnection,
  CrewStudioCrew,
  CrewStudioTask,
  CrewStudioWorkspace,
  SubCrewInvocation,
} from '@/types';

type SelectedEntity =
  | { kind: 'agent'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'action'; id: string }
  | { kind: 'connection'; id: string }
  | { kind: 'crew'; id: string }
  | { kind: 'subcrew'; id: string }
  | { kind: 'trigger' }
  | { kind: 'output' }
  | null;

function Field({
  label,
  value,
  onChange,
  as = 'input',
  type = 'text',
  rows = 3,
  hint,
  maxChars,
  pattern,
  patternHelp,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  as?: 'input' | 'textarea';
  type?: string;
  rows?: number;
  hint?: string;
  /** When set, render a live character counter that transitions
   *  muted → amber (>=75%) → red (>=95% / over). */
  maxChars?: number;
  /** Optional regex to validate against on every change. UI hint only;
   *  the authoritative gate is still the Zod schema at save time. */
  pattern?: RegExp;
  /** Human-readable explanation rendered below the field whenever
   *  `pattern` is supplied. Defaults muted, turns red on invalid. */
  patternHelp?: string;
}) {
  const hintId = useId();
  const patternInvalid = isPatternInvalid(value, pattern);
  const inputClass = `config-field-input${as === 'textarea' ? ' config-field-textarea' : ''}${patternInvalid ? ' config-field-input-invalid' : ''}`;
  const describedBy = [patternHelp ? `${hintId}-pattern` : null, hint ? `${hintId}-hint` : null]
    .filter(Boolean)
    .join(' ') || undefined;
  return (
    <label className="config-field">
      <div className="config-field-label-row">
        <div className="config-field-label">{label}</div>
        {typeof maxChars === 'number' && (
          <FieldCounter current={value.length} max={maxChars} />
        )}
      </div>
      {as === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className={inputClass}
          aria-invalid={patternInvalid || undefined}
          aria-describedby={describedBy}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
          aria-invalid={patternInvalid || undefined}
          aria-describedby={describedBy}
        />
      )}
      {patternHelp && (
        <div
          id={`${hintId}-pattern`}
          className={`config-field-hint${patternInvalid ? ' config-field-hint-error' : ''}`}
        >
          {patternHelp}
        </div>
      )}
      {hint && (
        <div id={`${hintId}-hint`} className="config-field-hint">
          {hint}
        </div>
      )}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="config-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function parseMulti(v: string): string[] {
  return v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * AgentToolsField — checkbox list of tools the agent can call, plus a
 * status chip showing whether the user has connected the credential
 * each tool requires. PR 4 wires the GitHub tool to /settings.
 *
 * We share the credentials fetch with the rest of the page through
 * useUserCredentials, so navigating between agents doesn't fire one
 * request per click. Unknown legacy tool strings already on the agent
 * are preserved (so we don't silently drop entries written before the
 * registry existed) but read-only — the checkboxes only cover the
 * registry-known set.
 */
function AgentToolsField({
  agent,
  onUpdate,
}: {
  agent: CrewStudioAgent;
  onUpdate: (updater: (a: CrewStudioAgent) => CrewStudioAgent) => void;
}) {
  const { credentials } = useUserCredentials();
  const githubConnected = Boolean(findCredential(credentials, 'github'));
  // Legacy / unknown tool strings the user previously typed remain in
  // the array so a checkbox toggle doesn't blow them away. New tools
  // are added/removed via the structured list below.
  const knownSet = new Set<string>(KNOWN_AGENT_TOOLS);
  const legacyTools = agent.tools.filter((t) => !knownSet.has(t));

  function toggleTool(tool: string, on: boolean) {
    onUpdate((a) => {
      const without = a.tools.filter((t) => t !== tool);
      return { ...a, tools: on ? [...without, tool] : without };
    });
  }

  return (
    <div className="config-subsection config-tool-section">
      <div className="config-field-label">Tools</div>
      <div className="config-tool-list">
        {KNOWN_AGENT_TOOLS.map((toolKey) => {
          const meta = AGENT_TOOL_LABELS[toolKey];
          const enabled = agent.tools.includes(toolKey);
          const needsGitHub = meta.requiresProvider === 'github';
          const ready = needsGitHub ? githubConnected : true;
          return (
            <label key={toolKey} className="config-tool-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => toggleTool(toolKey, e.target.checked)}
                aria-describedby={`tool-${toolKey}-hint`}
              />
              <div className="config-tool-row-body">
                <span className="config-tool-row-name">{meta.label}</span>
                <span id={`tool-${toolKey}-hint`} className="config-tool-row-hint">
                  {meta.tooltip}
                </span>
              </div>
              {enabled && needsGitHub && (
                ready ? (
                  <span
                    className="config-tool-row-chip config-tool-row-chip-ok"
                    aria-label="GitHub ready"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    GitHub ready
                  </span>
                ) : (
                  <a
                    href="/settings"
                    className="config-tool-row-chip config-tool-row-chip-warn"
                    aria-label="GitHub not connected — open Settings to connect"
                  >
                    GitHub not connected
                  </a>
                )
              )}
            </label>
          );
        })}
      </div>
      {legacyTools.length > 0 && (
        <div className="config-field-hint">
          Legacy tools on this agent: {legacyTools.join(', ')}. Remove them by
          editing the workspace JSON if they are no longer needed.
        </div>
      )}
    </div>
  );
}

function AgentConfig({
  agent,
  workspace,
  onUpdate,
  onRemove,
}: {
  agent: CrewStudioAgent;
  workspace: CrewStudioWorkspace;
  onUpdate: (updater: (a: CrewStudioAgent) => CrewStudioAgent) => void;
  onRemove: () => void;
}) {
  return (
    <div className="config-scroll">
      <div className="config-section-title">Agent Configuration</div>
      <div className="config-grid-2">
        <Field label="Name" value={agent.name} onChange={(v) => onUpdate((a) => ({ ...a, name: v }))} />
        <LlmModelSelect value={agent.llm} workspace={workspace} onChange={(v) => onUpdate((a) => ({ ...a, llm: v }))} />
      </div>
      <Field label="Role" value={agent.role} onChange={(v) => onUpdate((a) => ({ ...a, role: v }))} maxChars={FIELD_LIMITS.MEDIUM} />
      <Field label="Goal" as="textarea" value={agent.goal} onChange={(v) => onUpdate((a) => ({ ...a, goal: v }))} rows={3} maxChars={FIELD_LIMITS.MEDIUM} />
      <Field label="Backstory" as="textarea" value={agent.backstory} onChange={(v) => onUpdate((a) => ({ ...a, backstory: v }))} rows={4} maxChars={FIELD_LIMITS.LONG} />
      <div className="config-grid-2">
        <Field label="Max iterations" type="number" value={String(agent.maxIter)} onChange={(v) => onUpdate((a) => ({ ...a, maxIter: parseInt(v, 10) || 1 }))} />
        <Field label="Tags" value={agent.tags.join(', ')} onChange={(v) => onUpdate((a) => ({ ...a, tags: parseMulti(v) }))} />
      </div>
      <AgentToolsField agent={agent} onUpdate={onUpdate} />
      <AgentSubCrewToolsPicker
        agent={agent}
        workspace={workspace}
        onChange={(nextToolIds) => onUpdate((a) => ({ ...a, subCrewToolIds: nextToolIds }))}
      />
      <Field label="Knowledge" as="textarea" value={agent.knowledge.join('\n')} onChange={(v) => onUpdate((a) => ({ ...a, knowledge: parseMulti(v) }))} rows={3} hint="One per line" />

      <div className="config-subsection">
        <div className="config-field-label">Connections</div>
        <div className="config-checkbox-list">
          {workspace.connections.map((c) => (
            <label key={c.id} className="config-checkbox-item">
              <input
                type="checkbox"
                checked={agent.connectionIds.includes(c.id)}
                onChange={(e) =>
                  onUpdate((a) => ({
                    ...a,
                    connectionIds: e.target.checked
                      ? [...a.connectionIds, c.id]
                      : a.connectionIds.filter((id) => id !== c.id),
                  }))
                }
              />
              <div>
                <div className="config-checkbox-name">{c.name}</div>
                <div className="config-checkbox-meta">{c.mode} {isCrewStudioConnectionReady(c) ? '- Ready' : '- Needs setup'}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="config-toggle-row">
        <Toggle label="Allow delegation" checked={agent.allowDelegation} onChange={(v) => onUpdate((a) => ({ ...a, allowDelegation: v }))} />
        <Toggle label="Verbose" checked={agent.verbose} onChange={(v) => onUpdate((a) => ({ ...a, verbose: v }))} />
      </div>
      <button type="button" className="config-btn-danger" onClick={onRemove}>Remove agent</button>
    </div>
  );
}

function TaskConfig({
  task,
  workspace,
  onUpdate,
  onRemove,
}: {
  task: CrewStudioTask;
  workspace: CrewStudioWorkspace;
  onUpdate: (updater: (t: CrewStudioTask) => CrewStudioTask) => void;
  onRemove: () => void;
}) {
  return (
    <div className="config-scroll">
      <div className="config-section-title">Task Configuration</div>
      <div className="config-grid-2">
        <Field label="Name" value={task.name} onChange={(v) => onUpdate((t) => ({ ...t, name: v }))} />
        <label className="config-field">
          <div className="config-field-label">Assigned Agent</div>
          <select
            value={task.agentId || ''}
            onChange={(e) => onUpdate((t) => ({ ...t, agentId: e.target.value || null }))}
            className="config-field-input"
          >
            <option value="">Unassigned</option>
            {workspace.agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
      </div>
      <Field label="Description" as="textarea" value={task.description} onChange={(v) => onUpdate((t) => ({ ...t, description: v }))} rows={4} maxChars={FIELD_LIMITS.LONG} />
      <Field label="Expected output" as="textarea" value={task.expectedOutput} onChange={(v) => onUpdate((t) => ({ ...t, expectedOutput: v }))} rows={4} maxChars={FIELD_LIMITS.LONG} />
      <Field label="Output file" value={task.outputFile} onChange={(v) => onUpdate((t) => ({ ...t, outputFile: v }))} />

      <TaskContextPicker
        task={task}
        workspace={workspace}
        onChange={(nextContextIds) => onUpdate((cur) => ({ ...cur, contextTaskIds: nextContextIds }))}
      />

      <div className="config-toggle-row">
        <Toggle label="Human input" checked={task.humanInput} onChange={(v) => onUpdate((t) => ({ ...t, humanInput: v }))} />
        <Toggle label="Async" checked={task.asyncExecution} onChange={(v) => onUpdate((t) => ({ ...t, asyncExecution: v }))} />
        <Toggle label="Markdown" checked={task.markdown} onChange={(v) => onUpdate((t) => ({ ...t, markdown: v }))} />
      </div>
      <button type="button" className="config-btn-danger" onClick={onRemove}>Remove task</button>
    </div>
  );
}

function ConnectionConfig({
  connection,
  onUpdate,
  onRemove,
  onSetDefault,
}: {
  connection: CrewStudioConnection;
  onUpdate: (updater: (c: CrewStudioConnection) => CrewStudioConnection) => void;
  onRemove: () => void;
  onSetDefault: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/connections/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection }),
      });
      const data = (await res.json()) as ConnectionTestResult | { error: string };
      if ('error' in data) {
        setTestResult({ ok: false, latencyMs: 0, message: data.error });
      } else {
        setTestResult(data);
      }
    } catch (error) {
      setTestResult({
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : 'Test failed',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="config-scroll">
      <div className="config-section-title">Connection Configuration</div>
      <div className="config-grid-2">
        <Field label="Name" value={connection.name} onChange={(v) => onUpdate((c) => ({ ...c, name: v }))} />
        <Field label="Tool name" value={connection.toolName} onChange={(v) => onUpdate((c) => ({ ...c, toolName: v }))} />
      </div>
      <Field label="Description" as="textarea" value={connection.description} onChange={(v) => onUpdate((c) => ({ ...c, description: v }))} rows={3} />
      <div className="config-grid-2">
        <Field label="Account" value={connection.account} onChange={(v) => onUpdate((c) => ({ ...c, account: v }))} maxChars={FIELD_LIMITS.SHORT} pattern={FIELD_PATTERNS.snowflakeAccount.regex} patternHelp={FIELD_PATTERNS.snowflakeAccount.help} />
        <Field label="Warehouse" value={connection.warehouse} onChange={(v) => onUpdate((c) => ({ ...c, warehouse: v }))} />
        <Field label="Database" value={connection.database} onChange={(v) => onUpdate((c) => ({ ...c, database: v }))} />
        <Field label="Schema" value={connection.schema} onChange={(v) => onUpdate((c) => ({ ...c, schema: v }))} />
        <Field
          label="Role"
          value={connection.role}
          onChange={(v) => onUpdate((c) => ({ ...c, role: v }))}
          hint="Optional. Leave blank to use the PAT/default role, or set SNOWFLAKE_ROLE for runs."
        />
        <Field label="User" value={connection.user} onChange={(v) => onUpdate((c) => ({ ...c, user: v }))} />
      </div>
      <div className="config-grid-2">
        <Field label="Token env var" value={connection.passwordEnvVar} onChange={(v) => onUpdate((c) => ({ ...c, passwordEnvVar: v }))} hint="e.g. SNOWFLAKE_PAT — set in your shell" maxChars={FIELD_LIMITS.SHORT} pattern={FIELD_PATTERNS.passwordEnvVar.regex} patternHelp={FIELD_PATTERNS.passwordEnvVar.help} />
        <Field
          label="Email integration"
          value={connection.emailNotificationIntegration}
          onChange={(v) => onUpdate((c) => ({ ...c, emailNotificationIntegration: v }))}
          hint="Snowflake email notification integration name for SYSTEM$SEND_EMAIL"
        />
        <Field
          label="Default email recipients"
          as="textarea"
          value={connection.emailDefaultRecipients.join('\n')}
          onChange={(v) => onUpdate((c) => ({ ...c, emailDefaultRecipients: parseMulti(v) }))}
          rows={3}
          hint="Verified Snowflake account-user email addresses"
        />
        <Field label="Allowed tools" as="textarea" value={connection.allowedTools.join('\n')} onChange={(v) => onUpdate((c) => ({ ...c, allowedTools: parseMulti(v) }))} rows={3} />
      </div>

      <Field label="Query guide" as="textarea" value={connection.queryGuide} onChange={(v) => onUpdate((c) => ({ ...c, queryGuide: v }))} rows={3} maxChars={FIELD_LIMITS.LONG} />
      <Field label="Notes" as="textarea" value={connection.notes} onChange={(v) => onUpdate((c) => ({ ...c, notes: v }))} rows={3} maxChars={FIELD_LIMITS.LONG} />

      <div className="config-toggle-row">
        <Toggle label="Enabled" checked={connection.enabled} onChange={(v) => onUpdate((c) => ({ ...c, enabled: v }))} />
        <Toggle label="Default" checked={connection.isDefault} onChange={() => onSetDefault()} />
      </div>

      <div className="config-test-section">
        <button
          type="button"
          className="config-btn-secondary"
          onClick={runTest}
          disabled={testing || !connection.enabled}
        >
          {testing ? 'Testing...' : 'Test connection'}
        </button>
        {testResult && (
          <div className={`config-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
            <div className="config-test-result-head">
              <span className="config-test-badge">
                {testResult.ok ? 'PASS' : 'FAIL'}
              </span>
              <span>{testResult.message}</span>
              {testResult.latencyMs > 0 && <span className="config-test-latency">{testResult.latencyMs}ms</span>}
            </div>
            {testResult.details && testResult.details.length > 0 && (
              <ul className="config-test-details">
                {testResult.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <button type="button" className="config-btn-danger" onClick={onRemove}>Remove connection</button>
    </div>
  );
}

function ActionConfig({
  action,
  workspace,
  activeRun,
  onUpdate,
  onRemove,
}: {
  action: CrewStudioAction;
  workspace: CrewStudioWorkspace;
  activeRun: CrewRun | null;
  onUpdate: (updater: (a: CrewStudioAction) => CrewStudioAction) => void;
  onRemove: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);
  const snowflakeApiConnections = workspace.connections.filter((connection) => connection.mode === 'snowflake-api' && connection.enabled);
  const canSend = Boolean(activeRun?.status === 'completed' && action.enabled);

  async function sendNow() {
    if (!activeRun) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch(`/api/runs/${activeRun.id}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId: action.id }),
      });
      // Branch on gateway statuses before parsing — these come back with
      // empty or non-JSON bodies from the SPCS ingress so the generic
      // fallthrough would surface a useless "Unexpected token" message.
      if (res.status === 502) throw new Error('Email delivery upstream error');
      if (res.status === 504) throw new Error('Email request timed out');
      if (res.status === 401) throw new Error('Session expired. Reload.');
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string }
        | null;
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || data?.message || 'Email action failed');
      }
      setSendResult({ ok: true, message: data?.message || 'Email sent.' });
    } catch (error) {
      setSendResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Email action failed',
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="config-scroll">
      <div className="config-section-title">Action Configuration</div>
      <div className="config-grid-2">
        <Field label="Name" value={action.name} onChange={(v) => onUpdate((a) => ({ ...a, name: v }))} />
        <label className="config-field">
          <div className="config-field-label">Type</div>
          <select value={action.type} className="config-field-input" disabled>
            <option value="email">Email result</option>
          </select>
        </label>
      </div>
      <div className="config-grid-2">
        <label className="config-field">
          <div className="config-field-label">After task</div>
          <select
            value={action.afterTaskId || ''}
            onChange={(e) => onUpdate((a) => ({ ...a, afterTaskId: e.target.value || null }))}
            className="config-field-input"
          >
            <option value="">No task selected</option>
            {workspace.tasks.map((task) => (
              <option key={task.id} value={task.id}>{task.name}</option>
            ))}
          </select>
        </label>
        <label className="config-field">
          <div className="config-field-label">Snowflake connection</div>
          <select
            value={action.connectionId || ''}
            onChange={(e) => onUpdate((a) => ({ ...a, connectionId: e.target.value || null }))}
            className="config-field-input"
          >
            <option value="">Default API connection</option>
            {snowflakeApiConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </select>
        </label>
      </div>
      <Field
        label="Recipients"
        as="textarea"
        value={action.recipients.join('\n')}
        onChange={(v) => onUpdate((a) => ({ ...a, recipients: parseMulti(v) }))}
        rows={3}
        hint="Verified Snowflake account-user email addresses. Falls back to connection defaults if blank."
      />
      <Field
        label="Subject"
        value={action.subject}
        onChange={(v) => onUpdate((a) => ({ ...a, subject: v }))}
        hint="Optional. Defaults to the crew name and run timestamp."
      />
      <label className="config-field">
        <div className="config-field-label">Email body</div>
        <select
          value={action.emailBodyMode}
          onChange={(e) => onUpdate((a) => ({ ...a, emailBodyMode: e.target.value === 'raw-html' ? 'raw-html' : 'clean' }))}
          className="config-field-input"
        >
          <option value="clean">Render clean output</option>
          <option value="raw-html">Use raw HTML from agent</option>
        </select>
        <div className="config-field-hint">Raw HTML sends the final agent output as trusted HTML without Markdown escaping.</div>
      </label>
      <Field label="Notes" as="textarea" value={action.notes} onChange={(v) => onUpdate((a) => ({ ...a, notes: v }))} rows={3} />
      <div className="config-toggle-row">
        <Toggle label="Enabled" checked={action.enabled} onChange={(v) => onUpdate((a) => ({ ...a, enabled: v }))} />
      </div>
      <div className="config-test-section">
        <button
          type="button"
          className="config-btn-secondary"
          onClick={() => void sendNow()}
          disabled={!canSend || sending}
        >
          {sending ? 'Sending...' : 'Send latest result now'}
        </button>
        {sendResult && (
          <div className={`config-test-result ${sendResult.ok ? 'ok' : 'fail'}`}>
            <div className="config-test-result-head">
              <span className="config-test-badge">{sendResult.ok ? 'SENT' : 'FAIL'}</span>
              <span>{sendResult.message}</span>
            </div>
          </div>
        )}
        {!activeRun && <div className="config-field-hint">Enabled email actions send after successful crew runs.</div>}
        {activeRun && activeRun.status !== 'completed' && <div className="config-field-hint">Email sends after the run completes successfully.</div>}
      </div>
      <button type="button" className="config-btn-danger" onClick={onRemove}>Remove action</button>
    </div>
  );
}

function CrewConfig({
  crew,
  workspace,
  onUpdate,
  onRemove,
}: {
  crew: CrewStudioCrew;
  workspace: CrewStudioWorkspace;
  onUpdate: (updater: (c: CrewStudioCrew) => CrewStudioCrew) => void;
  onRemove: () => void;
}) {
  return (
    <div className="config-scroll">
      <div className="config-section-title">Crew / Workflow</div>
      <div className="config-grid-2">
        <Field label="Name" value={crew.name} onChange={(v) => onUpdate((c) => ({ ...c, name: v }))} maxChars={FIELD_LIMITS.SHORT} />
        <label className="config-field">
          <div className="config-field-label">Process</div>
          <select
            value={crew.process}
            onChange={(e) => onUpdate((c) => ({ ...c, process: e.target.value as CrewStudioCrew['process'] }))}
            className="config-field-input"
          >
            <option value="sequential">Sequential</option>
            <option value="hierarchical">Hierarchical</option>
          </select>
        </label>
      </div>
      <Field label="Description" as="textarea" value={crew.description} onChange={(v) => onUpdate((c) => ({ ...c, description: v }))} rows={3} maxChars={FIELD_LIMITS.MEDIUM} />
      <label className="config-field">
        <div className="config-field-label">Manager agent</div>
        <select
          value={crew.managerAgentId || ''}
          onChange={(e) => onUpdate((c) => ({ ...c, managerAgentId: e.target.value || null }))}
          className="config-field-input"
        >
          <option value="">None</option>
          {workspace.agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>

      <div className="config-subsection">
        <div className="config-field-label">Agents in crew</div>
        <div className="config-checkbox-list">
          {workspace.agents.map((a) => (
            <label key={a.id} className="config-checkbox-item">
              <input
                type="checkbox"
                checked={crew.agentIds.includes(a.id)}
                onChange={(e) =>
                  onUpdate((c) => ({
                    ...c,
                    agentIds: e.target.checked
                      ? [...c.agentIds, a.id]
                      : c.agentIds.filter((id) => id !== a.id),
                  }))
                }
              />
              <span>{a.name}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="config-subsection">
        <div className="config-field-label">Tasks in crew</div>
        <div className="config-checkbox-list">
          {workspace.tasks.map((t) => (
            <label key={t.id} className="config-checkbox-item">
              <input
                type="checkbox"
                checked={crew.taskIds.includes(t.id)}
                onChange={(e) =>
                  onUpdate((c) => ({
                    ...c,
                    taskIds: e.target.checked
                      ? [...c.taskIds, t.id]
                      : c.taskIds.filter((id) => id !== t.id),
                  }))
                }
              />
              <span>{t.name}</span>
            </label>
          ))}
        </div>
      </div>

      <Field label="Tags" value={crew.tags.join(', ')} onChange={(v) => onUpdate((c) => ({ ...c, tags: parseMulti(v) }))} />

      <div className="config-toggle-row">
        <Toggle label="Memory" checked={crew.memory} onChange={(v) => onUpdate((c) => ({ ...c, memory: v }))} />
        <Toggle label="Planning" checked={crew.planning} onChange={(v) => onUpdate((c) => ({ ...c, planning: v }))} />
        <Toggle label="Verbose" checked={crew.verbose} onChange={(v) => onUpdate((c) => ({ ...c, verbose: v }))} />
      </div>
      <button type="button" className="config-btn-danger" onClick={onRemove}>Remove crew</button>
    </div>
  );
}

export type { SelectedEntity };

export function NodeConfigPanel({
  selection,
  workspace,
  onUpdateAgent,
  onRemoveAgent,
  onUpdateTask,
  onRemoveTask,
  onUpdateConnection,
  onRemoveConnection,
  onSetDefaultConnection,
  onUpdateAction,
  onRemoveAction,
  onUpdateCrew,
  onRemoveCrew,
  onUpdateSubCrew,
  onRemoveSubCrew,
  activeRun,
  onClose,
  onOpenTargetCrew,
}: {
  selection: SelectedEntity;
  workspace: CrewStudioWorkspace;
  activeRun: CrewRun | null;
  onUpdateAgent: (id: string, updater: (a: CrewStudioAgent) => CrewStudioAgent) => void;
  onRemoveAgent: (id: string) => void;
  onUpdateTask: (id: string, updater: (t: CrewStudioTask) => CrewStudioTask) => void;
  onRemoveTask: (id: string) => void;
  onUpdateConnection: (id: string, updater: (c: CrewStudioConnection) => CrewStudioConnection) => void;
  onRemoveConnection: (id: string) => void;
  onSetDefaultConnection: (id: string) => void;
  onUpdateAction: (id: string, updater: (a: CrewStudioAction) => CrewStudioAction) => void;
  onRemoveAction: (id: string) => void;
  onUpdateCrew: (id: string, updater: (c: CrewStudioCrew) => CrewStudioCrew) => void;
  onRemoveCrew: (id: string) => void;
  onUpdateSubCrew: (id: string, next: SubCrewInvocation) => void;
  onRemoveSubCrew: (id: string) => void;
  onClose: () => void;
  onOpenTargetCrew?: (targetCrewId: string) => void;
}) {
  if (!selection) {
    return (
      <div className="config-panel config-panel-empty">
        <div className="config-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="config-empty-text">Select a node on the canvas to configure it</div>
      </div>
    );
  }

  if (selection.kind === 'trigger') {
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">Trigger Node</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close trigger node panel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="config-scroll">
          <div className="config-info-text">
            The trigger node starts the crew workflow. Connect it to your first task to define the entry point.
          </div>
        </div>
      </div>
    );
  }

  if (selection.kind === 'output') {
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">Output Node</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close output node panel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="config-scroll">
          <div className="config-info-text">
            The output node represents the final crew result. Connect your last task to it to complete the workflow.
          </div>
        </div>
      </div>
    );
  }

  if (selection.kind === 'agent') {
    const agent = workspace.agents.find((a) => a.id === selection.id);
    if (!agent) return null;
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">{agent.name}</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close agent editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <AgentConfig
          agent={agent}
          workspace={workspace}
          onUpdate={(updater) => onUpdateAgent(selection.id, updater)}
          onRemove={() => { onRemoveAgent(selection.id); onClose(); }}
        />
      </div>
    );
  }

  if (selection.kind === 'task') {
    const task = workspace.tasks.find((t) => t.id === selection.id);
    if (!task) return null;
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">{task.name}</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close task editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <TaskConfig
          task={task}
          workspace={workspace}
          onUpdate={(updater) => onUpdateTask(selection.id, updater)}
          onRemove={() => { onRemoveTask(selection.id); onClose(); }}
        />
      </div>
    );
  }

  if (selection.kind === 'connection') {
    const conn = workspace.connections.find((c) => c.id === selection.id);
    if (!conn) return null;
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">{conn.name}</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close connection editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <ConnectionConfig
          connection={conn}
          onUpdate={(updater) => onUpdateConnection(selection.id, updater)}
          onRemove={() => { onRemoveConnection(selection.id); onClose(); }}
          onSetDefault={() => onSetDefaultConnection(selection.id)}
        />
      </div>
    );
  }

  if (selection.kind === 'action') {
    const action = workspace.actions.find((a) => a.id === selection.id);
    if (!action) return null;
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">{action.name}</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close action editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <ActionConfig
          action={action}
          workspace={workspace}
          activeRun={activeRun}
          onUpdate={(updater) => onUpdateAction(selection.id, updater)}
          onRemove={() => { onRemoveAction(selection.id); onClose(); }}
        />
      </div>
    );
  }

  if (selection.kind === 'crew') {
    const crew = workspace.crews.find((c) => c.id === selection.id);
    if (!crew) return null;
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">{crew.name}</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close crew editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <CrewConfig
          crew={crew}
          workspace={workspace}
          onUpdate={(updater) => onUpdateCrew(selection.id, updater)}
          onRemove={() => { onRemoveCrew(selection.id); onClose(); }}
        />
      </div>
    );
  }

  if (selection.kind === 'subcrew') {
    const inv = workspace.subCrewInvocations.find((i) => i.id === selection.id);
    if (!inv) return null;
    return (
      <div className="config-panel">
        <div className="config-header">
          <div className="config-header-title">{inv.name}</div>
          <button type="button" className="config-close-btn" onClick={onClose} aria-label="Close sub-crew editor">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <SubCrewInvocationEditor
          invocation={inv}
          workspace={workspace}
          onChange={(next) => onUpdateSubCrew(selection.id, next)}
          onRemove={() => { onRemoveSubCrew(selection.id); onClose(); }}
          onOpenTargetCrew={onOpenTargetCrew}
        />
      </div>
    );
  }

  return null;
}
