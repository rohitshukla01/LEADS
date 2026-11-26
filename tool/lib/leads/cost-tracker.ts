/**
 * Per-request LLM cost tracker.
 *
 * Uses Node.js AsyncLocalStorage so that concurrent requests each maintain
 * their own accumulator without interference.  Every call site that gets a
 * CompatResponse can call `recordUsage()` to add tokens to the current
 * request's tally.  At the end of the request, `getSnapshot()` returns the
 * aggregated cost.
 *
 * Pricing (OpenAI list prices, which change over time):
 *   gpt-4.1 - $2.00 / 1M input   |   $8.00 / 1M output
 *   gpt-4.1-mini - $0.40 / 1M input   |   $1.60 / 1M output
 *
 * The synthesis backbone is gpt-4.1, so the single pricing constant below
 * tracks the dominant cost. Fast-tier (gpt-4.1-mini) calls are counted at the
 * same rate, which makes the estimate an upper bound on cost per query.
 */

import { AsyncLocalStorage } from "async_hooks";

const INPUT_COST_PER_M  = 2.00;   // USD per 1M input tokens (gpt-4.1)
const OUTPUT_COST_PER_M = 8.00;   // USD per 1M output tokens (gpt-4.1)

/**
 * Token usage accepted by `recordUsage`. Three conventions are handled:
 *   - LEADS CompatResponse:    { inputTokens, outputTokens }      (camelCase)
 *   - OpenAI Chat Completions: { prompt_tokens, completion_tokens }
 *   - OpenAI Responses API:    { input_tokens, output_tokens }
 *
 * `recordUsage` tries the camelCase fields first, then falls back to either
 * snake-case shape, so a call path that passes `usage` through in a raw SDK
 * shape, or an SDK that renames these fields, is still counted.
 */
export interface TokenUsage {
  inputTokens?:      number;
  outputTokens?:     number;
  input_tokens?:     number;
  output_tokens?:    number;
  prompt_tokens?:    number;
  completion_tokens?: number;
}

export interface CostSnapshot {
  inputTokens:       number;
  outputTokens:      number;
  totalTokens:       number;
  estimatedUsdCents: number; // rounded to 3 decimal places
  calls:             number; // number of LLM API calls
}

interface Accumulator {
  inputTokens:  number;
  outputTokens: number;
  calls:        number;
  tripped:      boolean; // set once a budget ceiling is crossed; blocks further spend
}

const _store = new AsyncLocalStorage<Accumulator>();

// Per-request cost circuit-breaker
// The tracker observes spend; this breaker enforces a per-request ceiling so a
// runaway loop or a retry storm cannot drain the account. It trips on whichever
// limit is crossed first (calls / tokens / USD) and is checked both after each
// response (recordUsage) and before each call (assertWithinBudget), so once
// tripped no further LLM call spends anything, even if a post-response throw is
// swallowed by a fail-soft `.catch`.
// Env-tunable; set LEADS_COST_BREAKER=off to disable entirely, or raise a
// specific ceiling. Defaults are about 3-6x the measured worst-case legitimate
// query (~50 calls / ~100k tokens / ~$0.50), so they fire only on a genuine
// runaway, not on normal traffic. A provider-side spend cap remains the only
// limit that code cannot bypass.
const BREAKER_ENABLED = process.env.LEADS_COST_BREAKER !== "off";
function envBudget(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const MAX_CALLS_PER_REQUEST  = envBudget("LEADS_MAX_CALLS_PER_REQUEST", 150);
const MAX_TOKENS_PER_REQUEST = envBudget("LEADS_MAX_TOKENS_PER_REQUEST", 500_000);
const MAX_USD_PER_REQUEST    = envBudget("LEADS_MAX_USD_PER_REQUEST", 3);

/** Thrown when a per-request cost ceiling is crossed; carries the snapshot. */
export class CostBudgetExceededError extends Error {
  readonly snapshot: CostSnapshot;
  readonly limit: string;
  constructor(limit: string, snapshot: CostSnapshot) {
    super(
      `Per-request cost budget exceeded (${limit}): ${snapshot.calls} calls, ` +
        `${snapshot.totalTokens} tokens, ~$${(snapshot.estimatedUsdCents / 100).toFixed(2)}. ` +
        `Pipeline halted to prevent runaway token spend. Tune via ` +
        `LEADS_MAX_CALLS_PER_REQUEST / LEADS_MAX_TOKENS_PER_REQUEST / LEADS_MAX_USD_PER_REQUEST, ` +
        `or set LEADS_COST_BREAKER=off.`,
    );
    this.name = "CostBudgetExceededError";
    this.snapshot = snapshot;
    this.limit = limit;
  }
}

function computeSnapshot(acc: Accumulator): CostSnapshot {
  const usd =
    (acc.inputTokens / 1_000_000) * INPUT_COST_PER_M +
    (acc.outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.inputTokens + acc.outputTokens,
    estimatedUsdCents: Math.round(usd * 100_000) / 1_000, // 3 d.p. in cents
    calls: acc.calls,
  };
}

/** Trip and throw if any ceiling is now crossed. No-op if the breaker is off. */
function enforceBudget(acc: Accumulator): void {
  if (!BREAKER_ENABLED) return;
  const snap = computeSnapshot(acc);
  let limit: string | null = null;
  if (acc.calls > MAX_CALLS_PER_REQUEST) limit = `>${MAX_CALLS_PER_REQUEST} calls`;
  else if (snap.totalTokens > MAX_TOKENS_PER_REQUEST) limit = `>${MAX_TOKENS_PER_REQUEST} tokens`;
  else if (snap.estimatedUsdCents / 100 > MAX_USD_PER_REQUEST) limit = `>$${MAX_USD_PER_REQUEST}`;
  if (limit) {
    acc.tripped = true;
    throw new CostBudgetExceededError(limit, snap);
  }
}

/**
 * Pre-flight budget guard - call before issuing any LLM request. Once the
 * per-request budget is tripped this throws immediately, so no subsequent call
 * spends anything even if an earlier post-response throw was swallowed by a
 * fail-soft `.catch`. No-op outside a tracked context (standalone scripts) or
 * when the breaker is disabled.
 */
export function assertWithinBudget(): void {
  if (!BREAKER_ENABLED) return;
  const acc = _store.getStore();
  if (!acc) return;
  if (acc.tripped) throw new CostBudgetExceededError("already tripped", computeSnapshot(acc));
  enforceBudget(acc);
}

/**
 * Wrap the orchestrator generator in this to isolate cost tracking per request.
 *
 * Uses `enterWith` rather than `_store.run(acc, fn)`. `fn` is an async-generator
 * factory, so `run` would set the context only while `fn()` returns the
 * unstarted generator; the generator body runs later, during iteration in the
 * API route, where `_store.getStore()` would be undefined and every
 * `recordUsage` call would be a no-op. `enterWith` sets the current async
 * context for the remainder of its lifetime, which is safe because each request
 * has its own async context (Next.js sets one up per request). The accumulator
 * is captured by closure, so each request has its own tally.
 */
export async function* runWithCostTracking<T>(
  fn: () => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const acc: Accumulator = { inputTokens: 0, outputTokens: 0, calls: 0, tripped: false };
  _store.enterWith(acc);
  yield* fn();
}

/** Call after every LLM response.  Safe to call outside a tracked context (no-op). */
export function recordUsage(usage: TokenUsage | undefined | null): void {
  if (!usage || typeof usage !== "object") return;
  // Try each naming convention in turn; the first non-zero value wins for each
  // field (see TokenUsage).
  const inputTokens =
    (typeof usage.inputTokens === "number"     ? usage.inputTokens     : 0) ||
    (typeof usage.input_tokens === "number"    ? usage.input_tokens    : 0) ||
    (typeof usage.prompt_tokens === "number"   ? usage.prompt_tokens   : 0);
  const outputTokens =
    (typeof usage.outputTokens === "number"      ? usage.outputTokens      : 0) ||
    (typeof usage.output_tokens === "number"     ? usage.output_tokens     : 0) ||
    (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0);
  if (inputTokens === 0 && outputTokens === 0) return;
  const acc = _store.getStore();
  if (!acc) return;
  acc.inputTokens  += inputTokens;
  acc.outputTokens += outputTokens;
  acc.calls        += 1;
  // Enforce the per-request ceiling. Throws CostBudgetExceededError (halting the
  // pipeline) the moment this response pushes the request over budget - the call
  // whose tokens are already spent is the last one that lands.
  enforceBudget(acc);
}

/** Returns the current accumulated cost.  Returns zeroed snapshot if called outside context. */
export function getSnapshot(): CostSnapshot {
  const acc = _store.getStore() ?? { inputTokens: 0, outputTokens: 0, calls: 0, tripped: false };
  return computeSnapshot(acc);
}
