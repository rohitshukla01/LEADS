/**
 * Query response cache for LEADS - stores full LLM answers in Upstash Redis
 * so repeat or near-identical queries are served instantly at zero LLM cost.
 *
 * Redis keys: leads:qcache:{normalizedQueryHash}
 * TTL: 30 minutes for sensor/forecast (data updates frequently)
 *      2 hours for literature-only queries (papers don't change)
 *
 * Normalization: lowercase, collapse whitespace, strip punctuation.
 * Sensor/forecast queries also embed the current UTC date (YYYY-MM-DD) in the
 * cache key so stale sensor data is never served across a day boundary.
 */

const CACHE_KEY_PREFIX = "leads:qcache:";
const SENSOR_FORECAST_TTL = 60 * 30;  // 30 minutes
const LITERATURE_TTL      = 60 * 60 * 2; // 2 hours

/**
 * Cached entries carry the full LeadsAnswer payload (citations, per-claim
 * verification and faithfulness), not just the response text, so a cache hit
 * fills the evidence, claim-verification and pipeline panels exactly as a fresh
 * run does. Each entry is about 30 KB.
 *
 * Entries without recorded citations are treated as a cache miss by the
 * orchestrator's cache-hit guard (orchestrator.ts).
 */
import { citationAlignMode, type CitationAlignMode } from "./citation-align";
import { litVerbatimMode, type LitVerbatimMode } from "./lit-verbatim";
import { raptorMode, type RaptorMode } from "./raptor-mode";
import type { LeadsCitation, LeadsClaimVerification, LeadsFaithfulness } from "./types";

export interface CachedQueryResult {
  response: string;
  cachedAt: string;
  citations?: LeadsCitation[];
  claims?: LeadsClaimVerification[];
  faithfulness?: LeadsFaithfulness;
  /** Cache schema version, stored with each entry and bumped when the shape
   *  changes. */
  schemaVersion?: number;
}

export const CACHE_SCHEMA_VERSION = 2;

function getRedisConfig(): { url: string; token: string } | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function redisCommand(
  url: string,
  token: string,
  command: unknown[]
): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { result?: unknown };
    return payload.result ?? null;
  } catch {
    return null;
  }
}

/** Simple djb2 hash for cache key derivation. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(36);
}

// Part of every cache key. Change it whenever a pipeline change alters the answer to
// the same question, so answers cached before a deploy are never served after it
// (entries live up to the TTL).
const CACHE_PIPELINE_TAG = "v1";

/**
 * Normalizes a query string to a stable cache key.
 * Sensor/forecast queries include the UTC date so stale data is never returned
 * across a day boundary (VERA4cast sensor data updates daily).
 *
 * The summary-node mode (raptor-mode.ts), the verbatim-literature mode
 * (lit-verbatim.ts) and the citation-alignment mode (citation-align.ts) are part of
 * the key, so answers built under different modes are never served for each other.
 * "legacy" summary nodes and the "off" setting of the other two add nothing to the
 * key.
 */
export function buildCacheKey(
  query: string,
  channels: string[],
  mode: RaptorMode = raptorMode(),
  litMode: LitVerbatimMode = litVerbatimMode(),
  alignMode: CitationAlignMode = citationAlignMode()
): string {
  const norm = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hasSensorOrForecast =
    channels.includes("sensor") || channels.includes("forecast");
  const dateSuffix = hasSensorOrForecast
    ? `:${new Date().toISOString().slice(0, 10)}`
    : "";

  const modeTag = mode === "legacy" ? "" : `raptor:${mode}|`;
  const litTag = litMode === "on" ? "lit:on|" : "";
  const alignTag = alignMode === "on" ? "align:on|" : "";

  return `${CACHE_KEY_PREFIX}${hashString(`${CACHE_PIPELINE_TAG}|${modeTag}${litTag}${alignTag}${norm}${dateSuffix}`)}`;
}

/** Retrieve a cached answer. Returns null on miss or any error. */
export async function getCachedAnswer(
  cacheKey: string
): Promise<CachedQueryResult | null> {
  const cfg = getRedisConfig();
  if (!cfg) return null;

  const raw = await redisCommand(cfg.url, cfg.token, ["GET", cacheKey]);
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw) as CachedQueryResult;
  } catch {
    return null;
  }
}

/** Store an answer in the cache with appropriate TTL. */
export async function setCachedAnswer(
  cacheKey: string,
  payload: Omit<CachedQueryResult, "cachedAt" | "schemaVersion">,
  channels: string[]
): Promise<void> {
  const cfg = getRedisConfig();
  if (!cfg) return;

  const hasSensorOrForecast =
    channels.includes("sensor") || channels.includes("forecast");
  const ttl = hasSensorOrForecast ? SENSOR_FORECAST_TTL : LITERATURE_TTL;

  const stored: CachedQueryResult = {
    ...payload,
    cachedAt: new Date().toISOString(),
    schemaVersion: CACHE_SCHEMA_VERSION,
  };

  await redisCommand(cfg.url, cfg.token, [
    "SET",
    cacheKey,
    JSON.stringify(stored),
    "EX",
    ttl,
  ]);
}
