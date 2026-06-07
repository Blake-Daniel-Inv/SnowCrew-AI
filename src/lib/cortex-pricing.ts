/**
 * Snowflake Cortex token pricing — credits per 1M tokens.
 *
 * Rates below approximate the Snowflake Credit Consumption Table for
 * Cortex LLM functions:
 *   https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf
 *
 * They are *estimates* — Snowflake adjusts published rates and adds new
 * models periodically, and a given account's effective rate depends on
 * edition (Standard/Enterprise/Business Critical/VPS) and region.
 * Treat numbers in the UI as a directional signal, not a billing source
 * of truth. For the authoritative record, query
 * SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY or the
 * CORTEX_FUNCTIONS_USAGE_HISTORY view inside Snowflake.
 *
 * Override at the model level via env vars like:
 *   CORTEX_RATE_claude_opus_4_7=15/75    (input/output credits per 1M)
 *   CORTEX_RATE_claude_sonnet_4_6=3/15
 * Or change the credit→USD conversion via:
 *   SNOWFLAKE_CREDIT_USD=2.50            (default 3.00, Enterprise tier)
 */
export interface CortexRate {
  /** Credits charged per 1M input tokens. */
  inputPerM: number;
  /** Credits charged per 1M output tokens. */
  outputPerM: number;
}

const DEFAULT_RATES: Record<string, CortexRate> = {
  // Claude family — anchored to Snowflake's published Sonnet rate
  // (~2.55 input / ~12.75 output per 1M for Claude 3.5 Sonnet) and
  // scaled by Anthropic's own model-tier ratios for the newer variants.
  'claude-opus-4-7':       { inputPerM: 15,    outputPerM: 75 },
  'claude-opus-4-6':       { inputPerM: 15,    outputPerM: 75 },
  'claude-4-opus':         { inputPerM: 15,    outputPerM: 75 },
  'claude-sonnet-4-6':     { inputPerM: 3,     outputPerM: 15 },
  'claude-4-6-sonnet':     { inputPerM: 3,     outputPerM: 15 },
  'claude-sonnet-4-5':     { inputPerM: 3,     outputPerM: 15 },
  'claude-4-sonnet':       { inputPerM: 3,     outputPerM: 15 },
  'claude-3-7-sonnet':     { inputPerM: 3,     outputPerM: 15 },
  'claude-3-5-sonnet':     { inputPerM: 2.55,  outputPerM: 12.75 },
  'claude-haiku-4-5':      { inputPerM: 0.25,  outputPerM: 1.25 },

  // Mistral / Meta / Snowflake — open weights, much cheaper.
  // Snowflake bills several of these as a flat per-token rate
  // (input == output); replicated here for closer parity.
  'mistral-large2':        { inputPerM: 5.1,   outputPerM: 5.1 },
  'llama4-maverick':       { inputPerM: 1.5,   outputPerM: 1.5 },
  'llama4-scout':          { inputPerM: 0.6,   outputPerM: 0.6 },
  'llama3.3-70b':          { inputPerM: 1.21,  outputPerM: 1.21 },
  'snowflake-llama-3.3-70b': { inputPerM: 1.21, outputPerM: 1.21 },
  'llama3.1-405b':         { inputPerM: 3,     outputPerM: 3 },
  'llama3.1-70b':          { inputPerM: 1.21,  outputPerM: 1.21 },
  'llama3.1-8b':           { inputPerM: 0.19,  outputPerM: 0.19 },
  'snowflake-arctic':      { inputPerM: 0.84,  outputPerM: 0.84 },
  'deepseek-r1':           { inputPerM: 2,     outputPerM: 6 },
  'openai-gpt-5':          { inputPerM: 12,    outputPerM: 60 },
  'openai-gpt-4-1':        { inputPerM: 8,     outputPerM: 32 },
};

const CREDIT_USD_FALLBACK = 3.0;

// Lazy module-level memos: read `process.env` once on first call and
// cache the parsed value thereafter. The cost path runs on every LLM
// call, so re-reading + re-parsing env on each invocation was wasted
// work. Cache is filled on first access and never invalidated — env
// changes after module load won't be picked up, which matches the
// existing behavior for `DEFAULT_RATES` and is fine because the runner
// reads env at boot anyway.
let _creditUsdCache: number | undefined;
const _rateOverrideCache = new Map<string, CortexRate | null>();

function readCreditUsd(): number {
  if (_creditUsdCache !== undefined) return _creditUsdCache;
  const raw = process.env.SNOWFLAKE_CREDIT_USD;
  if (!raw) {
    _creditUsdCache = CREDIT_USD_FALLBACK;
    return _creditUsdCache;
  }
  const parsed = Number(raw);
  _creditUsdCache =
    Number.isFinite(parsed) && parsed > 0 ? parsed : CREDIT_USD_FALLBACK;
  return _creditUsdCache;
}

/**
 * Strip the "snowflake/" provider prefix that LiteLLM uses so callers
 * can match against the bare Cortex model id.
 */
export function normalizeCortexModelId(model: string): string {
  return model.replace(/^snowflake\//, '').trim().toLowerCase();
}

function readRateOverride(modelId: string): CortexRate | null {
  const cached = _rateOverrideCache.get(modelId);
  if (cached !== undefined) return cached;
  // Env vars use _ instead of / and . so they can be exported safely.
  const safe = modelId.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const key = `CORTEX_RATE_${safe}`;
  const raw = process.env[key];
  if (!raw) {
    _rateOverrideCache.set(modelId, null);
    return null;
  }
  const match = raw.match(/^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/);
  if (!match) {
    _rateOverrideCache.set(modelId, null);
    return null;
  }
  const inputPerM = Number(match[1]);
  const outputPerM = Number(match[2]);
  if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM)) {
    _rateOverrideCache.set(modelId, null);
    return null;
  }
  const rate: CortexRate = { inputPerM, outputPerM };
  _rateOverrideCache.set(modelId, rate);
  return rate;
}

export function getCortexRate(model: string): CortexRate | null {
  const id = normalizeCortexModelId(model);
  return readRateOverride(id) || DEFAULT_RATES[id] || null;
}

export interface CostEstimate {
  /** Snowflake credits consumed (estimated). */
  credits: number;
  /** USD-equivalent at the configured credit rate. */
  usd: number;
  /** Whether we had a rate for this model (false → not estimated). */
  estimated: boolean;
}

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): CostEstimate {
  const rate = getCortexRate(model);
  if (!rate) {
    return { credits: 0, usd: 0, estimated: false };
  }

  const credits =
    (promptTokens / 1_000_000) * rate.inputPerM +
    (completionTokens / 1_000_000) * rate.outputPerM;
  const usd = credits * readCreditUsd();
  return { credits, usd, estimated: true };
}

export function creditUsdRate(): number {
  return readCreditUsd();
}

import type {
  RawRunMetrics,
  RawRunMetricsByModel,
  RunMetrics,
  RunMetricsByModel,
} from '@/types';

/**
 * Layer Cortex cost estimates onto the raw token aggregates from the
 * runs DB. Done here (and not inside getRawRunMetrics) so storage stays
 * decoupled from the always-shifting pricing table.
 */
export function enrichRunMetricsWithCost(raw: RawRunMetrics): RunMetrics {
  const byModel: RunMetricsByModel[] = raw.byModel.map((entry: RawRunMetricsByModel) => {
    const cost = estimateCost(entry.model, entry.promptTokens, entry.completionTokens);
    return {
      ...entry,
      credits: cost.credits,
      usd: cost.usd,
      estimated: cost.estimated,
    };
  });

  const totalsCredits = byModel.reduce((sum, entry) => sum + entry.credits, 0);
  const totalsUsd = byModel.reduce((sum, entry) => sum + entry.usd, 0);
  const anyEstimated = byModel.some((entry) => entry.estimated);

  return {
    totals: {
      ...raw.totals,
      credits: totalsCredits,
      usd: totalsUsd,
      estimated: anyEstimated,
    },
    byModel,
    byAgent: raw.byAgent,
  };
}
