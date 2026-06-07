import {
  getSnowflakeAuth,
  snowflakeAuthHeaders,
  type SnowflakeAuth,
} from './snowflake-auth';
import type {
  CortexModelDiscoveryResult,
  CortexModelOption,
  CrewStudioConnection,
} from '@/types';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_PARALLEL_PROBES = 4;

type CortexModelCandidate = {
  id: string;
  label: string;
  group: string;
  description: string;
  priority: number;
};

export const CORTEX_MODEL_CANDIDATES: CortexModelCandidate[] = [
  {
    id: 'auto',
    label: 'Auto',
    group: 'Snowflake Cortex',
    description: 'Snowflake selects the best available model',
    priority: 0,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    group: 'Snowflake Cortex - Claude Opus',
    description: 'Most capable for ambitious work',
    priority: 10,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    group: 'Snowflake Cortex - Claude Opus',
    description: 'High-capability reasoning model',
    priority: 11,
  },
  {
    id: 'claude-4-opus',
    label: 'Claude 4 Opus',
    group: 'Snowflake Cortex - Claude Opus',
    description: 'Legacy Opus model identifier',
    priority: 12,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'Most efficient for everyday tasks',
    priority: 20,
  },
  {
    id: 'claude-4-6-sonnet',
    label: 'Claude 4.6 Sonnet',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'Alternate Sonnet 4.6 identifier',
    priority: 21,
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'Balanced reasoning model',
    priority: 22,
  },
  {
    id: 'claude-4-sonnet',
    label: 'Claude 4 Sonnet',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'General purpose reasoning model',
    priority: 23,
  },
  {
    id: 'claude-3-7-sonnet',
    label: 'Claude 3.7 Sonnet',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'Strong general purpose model',
    priority: 24,
  },
  {
    id: 'claude-3-5-sonnet',
    label: 'Claude 3.5 Sonnet',
    group: 'Snowflake Cortex - Claude Sonnet',
    description: 'Reliable general purpose model',
    priority: 25,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    group: 'Snowflake Cortex - Claude Haiku',
    description: 'Fast lower-latency Claude model',
    priority: 30,
  },
  {
    id: 'mistral-large2',
    label: 'Mistral Large 2',
    group: 'Snowflake Cortex - Mistral',
    description: 'Large general purpose model',
    priority: 40,
  },
  {
    id: 'llama4-maverick',
    label: 'Llama 4 Maverick',
    group: 'Snowflake Cortex - Llama',
    description: 'Meta Llama model hosted by Snowflake',
    priority: 50,
  },
  {
    id: 'llama4-scout',
    label: 'Llama 4 Scout',
    group: 'Snowflake Cortex - Llama',
    description: 'Meta Llama model hosted by Snowflake',
    priority: 51,
  },
  {
    id: 'llama3.3-70b',
    label: 'Llama 3.3 70B',
    group: 'Snowflake Cortex - Llama',
    description: 'Open model hosted by Snowflake',
    priority: 52,
  },
  {
    id: 'snowflake-llama-3.3-70b',
    label: 'Snowflake Llama 3.3 70B',
    group: 'Snowflake Cortex - Snowflake',
    description: 'Snowflake-hosted Llama model',
    priority: 53,
  },
  {
    id: 'llama3.1-405b',
    label: 'Llama 3.1 405B',
    group: 'Snowflake Cortex - Llama',
    description: 'Large open model hosted by Snowflake',
    priority: 54,
  },
  {
    id: 'llama3.1-70b',
    label: 'Llama 3.1 70B',
    group: 'Snowflake Cortex - Llama',
    description: 'Open model hosted by Snowflake',
    priority: 55,
  },
  {
    id: 'llama3.1-8b',
    label: 'Llama 3.1 8B',
    group: 'Snowflake Cortex - Llama',
    description: 'Small open model hosted by Snowflake',
    priority: 56,
  },
  {
    id: 'snowflake-arctic',
    label: 'Snowflake Arctic',
    group: 'Snowflake Cortex - Snowflake',
    description: 'Snowflake model',
    priority: 60,
  },
  {
    id: 'deepseek-r1',
    label: 'DeepSeek R1',
    group: 'Snowflake Cortex - DeepSeek',
    description: 'Reasoning model hosted by Snowflake',
    priority: 70,
  },
  {
    id: 'openai-gpt-5',
    label: 'OpenAI GPT-5',
    group: 'Snowflake Cortex - OpenAI models',
    description: 'OpenAI model hosted by Snowflake',
    priority: 80,
  },
  {
    id: 'openai-gpt-4-1',
    label: 'OpenAI GPT-4.1',
    group: 'Snowflake Cortex - OpenAI models',
    description: 'OpenAI model hosted by Snowflake',
    priority: 81,
  },
];

export function normalizeSnowflakeAccount(account: string): string {
  return account
    .replace(/^https?:\/\//, '')
    .replace(/\.snowflakecomputing\.com.*$/, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
}

async function callCortexModel(
  auth: SnowflakeAuth,
  model: string
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://${auth.host}/api/v2/cortex/inference:complete`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: snowflakeAuthHeaders(auth),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      }
    );
    const body = await response.text().catch(() => '');
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function isModelUnavailable(status: number, body: string): boolean {
  // 4xx with a recognizably "model isn't enabled / present / reachable"
  // phrase. We err toward including the phrase set Snowflake has used
  // historically so a wording drift on their side does not flood the
  // discovery `details[]` with noisy entries that the UI surfaces.
  if (
    status === 400 &&
    /unknown model|invalid model|not supported|not enabled|model not found|no access to model|unsupported region/i.test(
      body
    )
  ) {
    return true;
  }

  if (
    status === 403 &&
    /model .*not allowed|not allowed.*model|not authorized.*model|access.*model|not enabled|no access to model|unsupported region/i.test(
      body
    )
  ) {
    return true;
  }

  if (
    status === 404 &&
    /model not found|unknown model|not enabled|unsupported region/i.test(body)
  ) {
    return true;
  }

  return false;
}

function unavailableReason(status: number, body: string): string {
  if (!body) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message || `HTTP ${status}`;
  } catch {
    return body.slice(0, 240);
  }
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => runWorker())
  );
  return results;
}

export async function discoverCortexModels(
  connection: CrewStudioConnection
): Promise<CortexModelDiscoveryResult> {
  const account = normalizeSnowflakeAccount(connection.account);
  const checkedAt = new Date().toISOString();

  if (!connection.account.trim()) {
    return {
      ok: false,
      checkedAt,
      models: [],
      message: 'Snowflake account identifier is missing.',
    };
  }

  const auth = getSnowflakeAuth({
    fallbackAccount: connection.account,
    fallbackEnvVar: connection.passwordEnvVar.trim() || 'SNOWFLAKE_PAT',
  });
  if (!auth) {
    return {
      ok: false,
      checkedAt,
      account,
      models: [],
      message:
        'No Snowflake credentials available. In SPCS the session token mount is missing; locally set SNOWFLAKE_PAT (or SNOWFLAKE_JWT).',
    };
  }

  const details: string[] = [];
  const models = await mapLimit(CORTEX_MODEL_CANDIDATES, MAX_PARALLEL_PROBES, async (candidate) => {
    try {
      const result = await callCortexModel(auth, candidate.id);
      const option: CortexModelOption = {
        id: `snowflake/${candidate.id}`,
        providerModelId: candidate.id,
        label: candidate.label,
        group: candidate.group,
        description: candidate.description,
        available: result.status === 200,
        status: result.status,
        reason: result.status === 200 ? undefined : unavailableReason(result.status, result.body),
      };

      if (result.status !== 200 && !isModelUnavailable(result.status, result.body)) {
        details.push(`${candidate.id}: ${option.reason || `HTTP ${result.status}`}`);
      }

      return { option, priority: candidate.priority };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      details.push(`${candidate.id}: ${reason}`);
      return {
        priority: candidate.priority,
        option: {
          id: `snowflake/${candidate.id}`,
          providerModelId: candidate.id,
          label: candidate.label,
          group: candidate.group,
          description: candidate.description,
          available: false,
          reason,
        } satisfies CortexModelOption,
      };
    }
  });

  const sortedModels = models
    .sort((a, b) => a.priority - b.priority)
    .map((entry) => entry.option);
  const availableCount = sortedModels.filter((model) => model.available).length;

  return {
    ok: availableCount > 0,
    checkedAt,
    account,
    models: sortedModels,
    message:
      availableCount > 0
        ? `Found ${availableCount} callable Snowflake Cortex model${availableCount === 1 ? '' : 's'}.`
        : 'No callable Snowflake Cortex models found from the probe list.',
    details,
  };
}
