'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { isCrewStudioConnectionReady } from '@/lib/crew-studio';
import type {
  CortexModelDiscoveryResult,
  CortexModelOption,
  CrewStudioConnection,
  CrewStudioWorkspace,
} from '@/types';

const STATIC_OPTIONS: CortexModelOption[] = [
  {
    id: 'snowflake/claude-opus-4-7',
    providerModelId: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    group: 'Snowflake Cortex - Claude Opus',
    description: 'Most capable for ambitious work',
    available: true,
  },
  {
    id: 'snowflake/claude-opus-4-6',
    providerModelId: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    group: 'Snowflake Cortex - Claude Opus',
    description: 'High-capability reasoning model',
    available: true,
  },
  {
    id: 'snowflake/claude-sonnet-4-6',
    providerModelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'Most efficient for everyday tasks',
    available: true,
  },
  {
    id: 'snowflake/claude-sonnet-4-5',
    providerModelId: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'Balanced reasoning model',
    available: true,
  },
  {
    id: 'snowflake/claude-4-sonnet',
    providerModelId: 'claude-4-sonnet',
    label: 'Claude 4 Sonnet',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'General purpose reasoning model',
    available: true,
  },
];

const discoveryCache = new Map<string, CortexModelDiscoveryResult>();
const pendingDiscovery = new Map<string, Promise<CortexModelDiscoveryResult>>();

type Status = 'idle' | 'loading' | 'ready' | 'error';

function isDiscoveryResult(value: unknown): value is CortexModelDiscoveryResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'models' in value &&
      'checkedAt' in value &&
      'message' in value
  );
}

function connectionSignature(connection: CrewStudioConnection | null): string {
  if (!connection) return 'none';
  return [
    connection.id,
    connection.account,
    connection.passwordEnvVar,
    connection.role,
    connection.enabled ? 'enabled' : 'disabled',
  ].join('|');
}

function primarySnowflakeConnection(workspace: CrewStudioWorkspace): CrewStudioConnection | null {
  return (
    workspace.connections.find(
      (connection) =>
        connection.mode === 'snowflake-api' &&
        connection.enabled &&
        isCrewStudioConnectionReady(connection)
    ) || null
  );
}

async function fetchCortexModels(
  connection: CrewStudioConnection,
  signal?: AbortSignal
): Promise<CortexModelDiscoveryResult> {
  const key = connectionSignature(connection);
  const cached = discoveryCache.get(key);
  if (cached) return cached;

  const existing = pendingDiscovery.get(key);
  if (existing) return existing;

  const request = fetch('/api/models/cortex', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection }),
  })
    .then(async (response) => {
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const error = payload && typeof payload === 'object' && 'error' in payload
          ? String(payload.error || 'Model discovery failed')
          : 'Model discovery failed';
        throw new Error(error);
      }
      if (!isDiscoveryResult(payload)) {
        throw new Error('Model discovery returned an unexpected response.');
      }
      discoveryCache.set(key, payload);
      return payload;
    })
    .finally(() => {
      pendingDiscovery.delete(key);
    });

  pendingDiscovery.set(key, request);
  return request;
}

function groupedOptions(options: CortexModelOption[]): Array<{ group: string; options: CortexModelOption[] }> {
  const groups = new Map<string, CortexModelOption[]>();
  for (const option of options) {
    const group = option.group || 'Snowflake Cortex';
    groups.set(group, [...(groups.get(group) || []), option]);
  }
  return Array.from(groups.entries()).map(([group, values]) => ({ group, options: values }));
}

function currentOption(value: string): CortexModelOption {
  const providerModelId = value.replace(/^snowflake\//, '');
  return {
    id: value,
    providerModelId,
    label: value || 'Custom model',
    group: 'Current / custom',
    description: 'Custom model ID',
    available: true,
  };
}

export function LlmModelSelect({
  label = 'LLM Model',
  value,
  workspace,
  onChange,
}: {
  label?: string;
  value: string;
  workspace: CrewStudioWorkspace;
  onChange: (value: string) => void;
}) {
  const selectId = useId();
  const customIdInputId = useId();
  const connection = useMemo(() => primarySnowflakeConnection(workspace), [workspace]);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [models, setModels] = useState<CortexModelOption[]>(STATIC_OPTIONS);
  const [customOpen, setCustomOpen] = useState(false);
  const signature = connectionSignature(connection);

  function applyDiscovery(result: CortexModelDiscoveryResult) {
    const available = result.models.filter((model) => model.available);
    setModels(available.length ? available : STATIC_OPTIONS);
    setMessage(result.message);
    setStatus(available.length ? 'ready' : 'error');
  }

  async function refreshModels(ignoreCache = false) {
    if (!connection) {
      setStatus('error');
      setMessage('No ready Snowflake API connection.');
      setModels(STATIC_OPTIONS);
      return;
    }

    if (ignoreCache) {
      discoveryCache.delete(connectionSignature(connection));
    }

    setStatus('loading');
    setMessage('Checking Snowflake Cortex models...');
    try {
      const result = await fetchCortexModels(connection);
      applyDiscovery(result);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Model discovery failed.');
      setModels(STATIC_OPTIONS);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function loadModels() {
      await Promise.resolve();
      if (cancelled) return;

      if (!connection) {
        setStatus('idle');
        setMessage('Using saved model list.');
        setModels(STATIC_OPTIONS);
        return;
      }

      const cached = discoveryCache.get(signature);
      if (cached) {
        applyDiscovery(cached);
        return;
      }

      setStatus('loading');
      setMessage('Checking Snowflake Cortex models...');
      fetchCortexModels(connection, controller.signal)
        .then((result) => {
          if (!cancelled) applyDiscovery(result);
        })
        .catch((error) => {
          if (controller.signal.aborted || cancelled) return;
          setStatus('error');
          setMessage(error instanceof Error ? error.message : 'Model discovery failed.');
          setModels(STATIC_OPTIONS);
        });
    }

    void loadModels();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connection, signature]);

  const options = useMemo(() => {
    const seen = new Set<string>();
    const list: CortexModelOption[] = [];
    for (const option of models) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      list.push(option);
    }
    if (value && !seen.has(value)) {
      list.push(currentOption(value));
    }
    return list;
  }, [models, value]);

  const isKnown = options.some((option) => option.id === value);
  const selectValue = isKnown && !customOpen ? value : '__custom__';
  const statusText =
    status === 'loading'
      ? 'Checking Snowflake...'
      : message || 'Snowflake Cortex model IDs are routed through Snowflake.';

  return (
    <div className="config-field">
      <div className="config-field-label-row">
        <label htmlFor={selectId} className="config-field-label">{label}</label>
        <button
          type="button"
          className="config-inline-btn"
          onClick={() => void refreshModels(true)}
          disabled={status === 'loading'}
        >
          Refresh
        </button>
      </div>
      <select
        id={selectId}
        value={selectValue}
        onChange={(event) => {
          if (event.target.value === '__custom__') {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          onChange(event.target.value);
        }}
        className="config-field-input"
      >
        {groupedOptions(options).map((group) => (
          <optgroup key={group.group} label={group.group}>
            {group.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="__custom__">Custom model ID...</option>
      </select>
      {(!isKnown || customOpen) && (
        <>
          <label htmlFor={customIdInputId} className="config-field-label" style={{ marginTop: 6 }}>Custom model ID</label>
          <input
            id={customIdInputId}
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="config-field-input"
            style={{ marginTop: 6 }}
            placeholder="snowflake/model-id"
          />
        </>
      )}
      <div className={`config-field-hint ${status === 'error' ? 'config-field-hint-error' : ''}`}>
        {statusText}
      </div>
    </div>
  );
}
