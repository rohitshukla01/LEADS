/**
 * OpenAI-compatible chat client.
 *
 * Exposes a `messages.create()` interface used by the
 * modules that call a language model.
 *
 * Models named at call sites:
 *   "gpt-4.1" - quality tier: grounded answer generation
 *   "gpt-4.1-mini" - fast tier: claim checking, literature distillation, reflexion
 *
 * Environment:
 *   OPENAI_API_KEY - required (LEADS_GEN_API_KEY takes its place for chat calls)
 *   OPENAI_MODEL - override the quality-tier model
 *   LEADS_AUX_MODEL - fast-tier model, used only when OPENAI_MODEL is set
 *   LEADS_GEN_BASE_URL / OPENAI_BASE_URL - override the endpoint (default https://api.openai.com/v1)
 */

import { assertWithinBudget } from "./leads/cost-tracker";

type TextBlock = { type: "text"; text: string };
type MessageContent =
  | string
  | Array<
      | string
      | { type: "text"; text: string; cache_control?: unknown }
      | {
          type: "document";
          source?: { type?: string; media_type?: string; data?: string };
        }
    >;

interface CreateParams {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  thinking?: unknown; // ignored
  [key: string]: unknown;
  system?:
    | string
    | Array<{ type?: string; text?: string; cache_control?: unknown }>;
  messages?: Array<{ role: string; content: MessageContent }>;
}

interface CompatResponse {
  content: TextBlock[];
  /** "end_turn" = model finished cleanly; "max_tokens" = hit the limit and was cut off */
  stop_reason?: "end_turn" | "max_tokens" | string;
  usage?: { inputTokens: number; outputTokens: number };
}

interface CompatMessagesApi {
  create(params: CreateParams, _options?: unknown): Promise<CompatResponse>;
}

interface CompatClient {
  messages: CompatMessagesApi;
}

// Helpers

/** The key for chat calls (generation + aux). LEADS_GEN_API_KEY lets generation run on a
 *  different OpenAI-compatible provider (e.g. Groq or Together for an open-weights model)
 *  while embeddings keep OPENAI_API_KEY. Defaults to OPENAI_API_KEY; an empty value counts
 *  as unset. */
function chatApiKey(): string {
  return process.env.LEADS_GEN_API_KEY || process.env.OPENAI_API_KEY || "";
}

/** True when chat calls have a key. Every no-key gate uses this, so the writer, the
 *  literature distiller and the claim checker agree on whether a model is available. */
export function hasChatKey(): boolean {
  return chatApiKey() !== "";
}

function getApiKey() {
  const key = chatApiKey();
  if (!key) throw new Error("OPENAI_API_KEY (or LEADS_GEN_API_KEY) is required");
  return key;
}

function getBaseUrl() {
  // Chat tier endpoint. LEADS_GEN_BASE_URL points generation+aux at an
  // OpenAI-compatible provider (e.g. Groq or Together); embeddings (lib/cohere)
  // stay on OPENAI_BASE_URL. Defaults to OPENAI_BASE_URL.
  return (
    process.env.LEADS_GEN_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  );
}

/**
 * Resolve the model to use.
 * OPENAI_MODEL overrides the quality tier (gpt-4.1). The fast/aux tier stays
 * gpt-4.1-mini by default; when OPENAI_MODEL is set, LEADS_AUX_MODEL lets it
 * follow the generation provider (e.g. a Groq-hosted model) so aux calls don't
 * 404 when LEADS_GEN_BASE_URL points off-OpenAI.
 */
function resolveModel(hint?: string): string {
  const override = process.env.OPENAI_MODEL;
  if (override) {
    if (hint === "gpt-4.1-mini") return process.env.LEADS_AUX_MODEL ?? "gpt-4.1-mini";
    return override;
  }
  return hint ?? "gpt-4.1";
}

// Optional determinism overrides for evaluation runs (opt-in via env).
// LEADS_EVAL_TEMPERATURE / LEADS_EVAL_SEED apply only when no explicit per-call value is
// given, so a temperature set by the caller is respected. With
// neither set, the default temperature is 0.2 and no seed is sent.
function evalTemperature(explicit?: number): number {
  if (typeof explicit === "number") return explicit;
  const env = process.env.LEADS_EVAL_TEMPERATURE;
  if (env != null && env !== "" && !Number.isNaN(Number(env))) return Number(env);
  return 0.2;
}
function evalSeed(explicit?: number): number | undefined {
  if (typeof explicit === "number") return explicit;
  const env = process.env.LEADS_EVAL_SEED;
  if (env != null && env !== "" && !Number.isNaN(Number(env))) return Number(env);
  return undefined;
}

function flattenSystem(system: CreateParams["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function flattenContent(content: MessageContent): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((p) => {
      if (typeof p === "string") return p;
      if (p.type === "text") return p.text;
      if (p.type === "document") return "[embedded document]";
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildOpenAIMessages(params: CreateParams) {
  const system = flattenSystem(params.system);
  const msgs: Array<{ role: string; content: string }> = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const m of params.messages ?? []) {
    msgs.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: flattenContent(m.content),
    });
  }
  return msgs;
}

// Per-call latency ceiling: bound every LLM HTTP call with an AbortSignal so
// a single hung/slow call cannot silently consume the whole serverless request and
// leave the client with an empty, never-completing stream. Default 90s - generous for one
// gpt-4.1 completion (typically <40s) - override via LEADS_LLM_TIMEOUT_MS.
const LLM_TIMEOUT_MS = (() => {
  const env = Number(process.env.LEADS_LLM_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 90_000;
})();

// Retry on 429 and 5xx: wait for the Retry-After header when present, otherwise back
// off exponentially (1.5 s doubling, 30 s cap), up to 6 retries.
async function chatFetchWithRetry(
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<Response> {
  const MAX_RETRIES = 6;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${getBaseUrl()}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(
        e instanceof Error && e.name === "TimeoutError"
          ? `OpenAI request timed out after ${Math.round(LLM_TIMEOUT_MS / 1000)}s`
          : `OpenAI request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (response.ok) return response;
    const retriable = response.status === 429 || response.status >= 500;
    if (retriable && attempt < MAX_RETRIES) {
      const ra = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1500 * 2 ** attempt, 30000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 300)}`);
  }
}

// Client

let _client: CompatClient | null = null;

function createOpenAIClient(): CompatClient {
  return {
    messages: {
      async create(params: CreateParams): Promise<CompatResponse> {
        assertWithinBudget(); // pre-flight: refuse to spend if the request is over budget
        const model = resolveModel(params.model);
        const messages = buildOpenAIMessages(params);

        const body: Record<string, unknown> = {
          model,
          messages,
          max_tokens: params.max_tokens ?? 4096,
          temperature: evalTemperature(params.temperature),
        };
        if (typeof params.top_p === "number") body.top_p = params.top_p;
        const seed = evalSeed((params as { seed?: number }).seed);
        if (typeof seed === "number") body.seed = seed;

        const response = await chatFetchWithRetry(
          {
            Authorization: `Bearer ${getApiKey()}`,
            "Content-Type": "application/json",
          },
          body
        );

        const payload = (await response.json()) as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const text = payload.choices?.[0]?.message?.content ?? "";
        const finish = payload.choices?.[0]?.finish_reason ?? "end_turn";
        const stop_reason = finish === "length" ? "max_tokens" : "end_turn";
        return {
          content: [{ type: "text", text }],
          stop_reason,
          usage: {
            inputTokens: payload.usage?.prompt_tokens ?? 0,
            outputTokens: payload.usage?.completion_tokens ?? 0,
          },
        };
      },
    },
  };
}

export function getOpenAIClient(): CompatClient {
  if (!_client) {
    _client = createOpenAIClient();
  }
  return _client;
}

/**
 * Quality-tier client.
 *
 * The LEADS backbone is GPT-4.1. Override the model at runtime via
 * `OPENAI_MODEL`. Fast-tier callers should use `getOpenAIClient()` directly.
 */
export function getQualityClient(): CompatClient {
  return getOpenAIClient();
}

/**
 * Auxiliary-tier client. Same OpenAI client; call sites pass
 * `model: "gpt-4.1-mini"` for JSON-extraction tasks (claim verification,
 * literature distillation, reflexion). `OPENAI_MODEL` never replaces the
 * fast-tier model; `LEADS_AUX_MODEL` does when `OPENAI_MODEL` is set (see `resolveModel`).
 */
export function getAuxiliaryClient(): CompatClient {
  return getOpenAIClient();
}
