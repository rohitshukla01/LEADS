/**
 * FLARE ensemble forecast reader for LEADS.
 *
 * Fetches the raw 221-member GLM-AED ensemble from a single Hive-partitioned
 * parquet file on OSN (Open Storage Network), computes daily ensemble
 * statistics (mean + percentiles), and returns ForecastRecord[] compatible
 * with the LEADS ensemble + risk-assessment engine.
 *
 * One parquet file per (site, reference_date) holds every variable and
 * ensemble member, so a single file serves all variables for a site.
 *
 * FLARE raw parquet path layout on OSN:
 *   <base>/site_id=<site>/model_id=<model>/reference_date=<YYYY-MM-DD>/<file>.parquet
 *
 * Columns written by GLM-AED (partition keys are not embedded in the file):
 *   reference_datetime | datetime | variable | depth | prediction | parameter | forecast
 *   - parameter:  ensemble member ID 1–221
 *   - forecast:   1 = forecast horizon  /  0 = assimilation window  (filter to 1)
 *   - datetime:   hourly target timestamps (aggregated to daily means per member)
 *   - depth:      metres from surface (shallowest layer ≈ 0 m unless target depths are given)
 *
 * Methodological basis:
 *   Carey et al. 2022 - FLARE lake forecasting system (GLM/AED)
 *   Thomas et al. 2023 - Ecological Forecasting Challenge
 *   Gneiting & Raftery 2007 - Strictly proper scoring rules, prediction, and estimation
 */

import { tableFromIPC } from "apache-arrow";

import {
  LEADS_FLARE_BASE_URL,
  LEADS_FLARE_LOOKBACK_DAYS,
  LEADS_FLARE_MODEL_ID,
  LEADS_FLARE_REFERENCE_DATE,
  LEADS_FLARE_SITE,
  LEADS_FLARE_VARIABLES,
  LEADS_FORECAST_CACHE_TTL_MS,
} from "./config";
import { getParquetModule } from "./parquet-reader";
import type { ForecastRecord } from "./types";

// URL helpers

/** Candidate filenames R's arrow::write_dataset / DuckDB may use inside a partition. */
const PARQUET_FILENAMES = ["part-0.parquet", "0.parquet", "data.parquet"];
// Rows per streamed chunk (capped by the parquet's row-group size). Bounds peak memory to a
// few MB/chunk while keeping the wasm-to-IPC round-trip count low. See streamFlareParquet.
const FLARE_STREAM_BATCH_SIZE = 200_000;
// parquet-wasm does not report a failed HTTP range request as an error: its WASM code traps
// ("RuntimeError: unreachable") and the pending read never settles, so the question would hang.
// A time limit on each step turns that into an ordinary error, which the callers' existing catch
// blocks handle (that read returns no forecast; a later attempt can read the file again).
const FLARE_STREAM_IDLE_MS = 60_000;
function withIdleTimeout<T>(p: Promise<T>, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`FLARE parquet ${step}: no data for ${FLARE_STREAM_IDLE_MS / 1000} s`)), FLARE_STREAM_IDLE_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Returns the OSN directory URL for a given site / model / reference_date. */
export function buildFlarePartitionUrl(
  referenceDate: string,
  siteId = LEADS_FLARE_SITE,
  modelId = LEADS_FLARE_MODEL_ID
): string {
  const base = LEADS_FLARE_BASE_URL.replace(/\/+$/, "");
  return `${base}/site_id=${siteId}/model_id=${modelId}/reference_date=${referenceDate}`;
}

// Reference date discovery

/** Per-site cache so bvre and fcre are discovered independently. */
const latestDateByKey = new Map<string, { date: string; fetchedAt: number }>();

/**
 * Probe OSN via HEAD requests to find the most recent available FLARE
 * reference date for a given site/model pair. Tries each day from yesterday back
 * LEADS_FLARE_LOOKBACK_DAYS days (default 21), each checking the known
 * candidate parquet filenames. Result is cached for one forecast TTL
 * interval (default 1 hour).
 *
 * BVRE forecasts typically lag FCRE by 7–11 days and longer publication
 * gaps occur. Staleness is reported through recency annotations in the
 * evidence text rather than by refusing on age.
 */
export async function discoverLatestFlareDate(
  siteId = LEADS_FLARE_SITE,
  modelId = LEADS_FLARE_MODEL_ID
): Promise<string | null> {
  // Snapshot freeze: when pinned, replay a fixed forecast run instead of
  // auto-discovering the newest reference_date (which advances daily).
  if (LEADS_FLARE_REFERENCE_DATE) {
    return LEADS_FLARE_REFERENCE_DATE;
  }

  const cacheKey = `${siteId}:${modelId}`;
  const cached = latestDateByKey.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LEADS_FORECAST_CACHE_TTL_MS) {
    return cached.date;
  }

  const today = new Date();
  for (let daysBack = 1; daysBack <= LEADS_FLARE_LOOKBACK_DAYS; daysBack++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - daysBack);
    const dateStr = d.toISOString().split("T")[0];
    const dirBase = buildFlarePartitionUrl(dateStr, siteId, modelId);

    for (const filename of PARQUET_FILENAMES) {
      try {
        const resp = await fetch(`${dirBase}/${filename}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          latestDateByKey.set(cacheKey, { date: dateStr, fetchedAt: Date.now() });
          return dateStr;
        }
      } catch {
        // continue probing
      }
    }
  }

  return null; // no data found within the look-back window
}

// FLARE unit normalization
//
// FLARE GLM-AED writes dissolved oxygen in mmol O₂/m³ (AED's native OXY_oxy unit)
// even though the variable is named DO_mgL_mean: FLAREr renames the state to the
// VERA target name without converting it (FCRE/BVRE observations_config_aed.csv:
// "OXY_oxy,mmol m-3,…,DO_mgL_mean"). Only FLARE's separate VERA4cast submission is
// converted to mg/L. Multiply by O₂ molecular weight / 1000 to convert.
//
// The conversion is unconditional: raw fcre and bvre files (2024–2026) show one
// continuous mmol/m³ distribution with no break at any value. Left unconverted,
// near-anoxic members (0–30 mmol/m³ = 0–0.96 mg/L) would read as 0–30 mg/L, i.e.
// as well oxygenated. Guarded by scripts/check-flare-do-units.ts.
//
// Other variables (Temp_C_mean in °C, Chla_ugL_mean in µg/L = mg/m³) are
// already in the expected units and need no adjustment.

const DO_MMOL_TO_MGL = 32 / 1000; // O₂ MW = 32 g/mol, so 1 mmol/m³ = 0.032 mg/L

/** Normalise a single FLARE prediction value to the unit implied by the variable name. */
export function normalizeFlareValue(variable: string, value: number): number {
  return variable === "DO_mgL_mean" ? value * DO_MMOL_TO_MGL : value;
}

// Quantile helper

/**
 * Linear-interpolation empirical quantile over a sorted array.
 * Identical to R's quantile(..., type=7) default.
 */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const h = p * (sorted.length - 1);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

// Date helpers

function toDateStr(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") {
    const ms = Number(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString().split("T")[0] : "";
  }
  return typeof value === "string" ? value.split("T")[0] : "";
}

function daysBetween(d1: string, d2: string): number {
  return Math.round(
    (new Date(d2).getTime() - new Date(d1).getTime()) / 86400000
  );
}

// Streaming aggregation (memory-bounded)
// A FLARE parquet is long-format and large: ~4.6M rows; a ~42 MB file expands to ~430 MB as
// one Arrow table. On a ~1 GB serverless function that exceeds memory for the larger
// reservoir (BVR ≈ 2x FCR), and readParquet column projection is a no-op in this build, so
// the file is streamed batch-by-batch and aggregated incrementally. Each aggregation is split
// into a per-batch accumulate step and a finalize step; the resolved-depth filter (min-depth /
// nearest-depth) runs in finalize, since that depth is not known until the stream ends.

/** Stream a FLARE parquet batch-by-batch. Picks the first existing candidate filename via a
 *  HEAD probe, then calls onBatch(table) per Arrow record batch. Returns false if none exist. */
async function streamFlareParquet(
  referenceDate: string,
  siteId: string,
  modelId: string,
  onBatch: (table: import("apache-arrow").Table) => void,
): Promise<boolean> {
  const dirBase = buildFlarePartitionUrl(referenceDate, siteId, modelId);
  let url: string | null = null;
  for (const filename of PARQUET_FILENAMES) {
    try {
      const head = await fetch(`${dirBase}/${filename}`, { method: "HEAD", signal: AbortSignal.timeout(8000) });
      if (head.ok) { url = `${dirBase}/${filename}`; break; }
    } catch { /* try next candidate */ }
  }
  if (!url) return false;

  const pq = await getParquetModule();
  // ParquetFile.stream({batchSize}) reads row-group chunks via HTTP range requests. Larger
  // batches than readParquetStream's small defaults mean fewer wasm-to-IPC round-trips, while
  // peak memory stays at a few MB per chunk. batchSize is capped by the parquet's row-group
  // size, so the file streams in ~142 chunks rather than one ~430 MB table.
  const file = await withIdleTimeout(pq.ParquetFile.fromUrl(url), "open");
  const streamPromise = file.stream({ batchSize: FLARE_STREAM_BATCH_SIZE });
  try {
    const stream = (await withIdleTimeout(streamPromise, "stream")) as ReadableStream<{ intoIPCStream(): Uint8Array }>;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await withIdleTimeout(reader.read(), "read");
        if (done) break;
        onBatch(tableFromIPC(value.intoIPCStream()));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  } finally {
    // Free the file only once file.stream() has settled: after a "stream" time-out its WASM
    // task may not have run yet, and freeing the file before it runs corrupts WASM memory.
    const free = () => { try { file.free(); } catch { /* noop */ } };
    streamPromise.then(free, free);
  }
  return true;
}

interface ForecastAccumState {
  accum: Map<string, { sum: number; count: number }>; // key: variable|date|depth|member
  minDepthPerVar: Map<string, number>;
}

/** Per-batch accumulation for ensemble-stats records. In shallowest-layer mode the minimum
 *  depth is tracked incrementally and its filter is deferred to finalize; the target-depth
 *  filter is applied here because those depths are known up front. */
function accumulateForecastBatch(
  table: import("apache-arrow").Table,
  state: ForecastAccumState,
  targetVariables: readonly string[],
  useTargetDepths: boolean,
  targetSet: Set<number>,
  referenceDate: string,
  maxHorizonDays: number,
): void {
  const n = table.numRows;
  const colDatetime = table.getChild("datetime");
  const colVariable = table.getChild("variable");
  const colDepth = table.getChild("depth");
  const colPrediction = table.getChild("prediction");
  const colParameter = table.getChild("parameter");
  const colForecast = table.getChild("forecast");
  if (!colDatetime || !colVariable || !colPrediction || !colParameter) return;

  for (let i = 0; i < n; i++) {
    const v = String(colVariable.get(i) ?? "");
    if (!(targetVariables as string[]).includes(v)) continue;

    // Shallowest-layer mode: minimum depth over all target-variable rows, before the forecast filter.
    if (!useTargetDepths && colDepth) {
      const d0 = Number(colDepth.get(i));
      if (Number.isFinite(d0)) {
        const prev = state.minDepthPerVar.get(v);
        if (prev === undefined || Math.abs(d0) < Math.abs(prev)) state.minDepthPerVar.set(v, d0);
      }
    }

    if (colForecast && Number(colForecast.get(i)) !== 1) continue;

    let depth = 0;
    if (colDepth) {
      depth = Number(colDepth.get(i));
      if (!Number.isFinite(depth)) continue;
      if (useTargetDepths) {
        const rounded = Math.round(depth * 1000) / 1000;
        if (!targetSet.has(rounded)) continue;
      }
    }

    const targetDate = toDateStr(colDatetime.get(i));
    if (!targetDate) continue;
    const horizon = daysBetween(referenceDate, targetDate);
    if (horizon <= 0 || horizon > maxHorizonDays) continue;

    const rawPrediction = Number(colPrediction.get(i));
    if (!Number.isFinite(rawPrediction)) continue;
    const prediction = normalizeFlareValue(v, rawPrediction);

    const member = String(colParameter.get(i) ?? "");
    const key = `${v}|${targetDate}|${depth}|${member}`;
    const prev = state.accum.get(key);
    if (prev) { prev.sum += prediction; prev.count += 1; }
    else state.accum.set(key, { sum: prediction, count: 1 });
  }
}

/** Finalize the streamed forecast accumulator into daily ensemble statistics. Applies the
 *  deferred shallowest-layer depth filter. */
function finalizeForecastRecords(
  state: ForecastAccumState,
  useTargetDepths: boolean,
  referenceDate: string,
  siteId: string,
  modelId: string,
  maxHorizonDays: number,
): ForecastRecord[] {
  const dayEnsemble = new Map<string, number[]>();
  for (const [key, { sum, count }] of state.accum) {
    const parts = key.split("|");
    const v = parts[0];
    const targetDate = parts[1];
    const depth = parts[2];
    if (!useTargetDepths) {
      const minD = state.minDepthPerVar.get(v) ?? 0;
      if (Math.abs(Number(depth) - minD) > 0.15) continue;
    }
    const dayKey = `${v}|${targetDate}|${depth}`;
    const arr = dayEnsemble.get(dayKey) ?? [];
    arr.push(sum / count);
    dayEnsemble.set(dayKey, arr);
  }

  const records: ForecastRecord[] = [];
  for (const [key, predictions] of dayEnsemble) {
    if (predictions.length < 2) continue;
    const parts = key.split("|");
    const variable = parts[0];
    const targetDate = parts[1];
    const depthM = Number(parts[2]);
    const horizon = daysBetween(referenceDate, targetDate);
    if (horizon <= 0 || horizon > maxHorizonDays) continue;

    const sorted = [...predictions].sort((a, b) => a - b);
    const ensMean = sorted.reduce((s, val) => s + val, 0) / sorted.length;

    records.push({
      modelId, siteId, variable, referenceDate, targetDate, horizon,
      mean: ensMean,
      quantile02_5: quantile(sorted, 0.025),
      quantile10: quantile(sorted, 0.1),
      quantile90: quantile(sorted, 0.9),
      quantile97_5: quantile(sorted, 0.975),
      // Keep the members (sorted) so downstream probability is counted, not fitted.
      members: sorted,
      depthM,
    });
  }
  return records.sort((a, b) => a.horizon - b.horizon);
}

interface MemberAccumState {
  accum: Map<string, { sum: number; count: number }>; // key: member|date|depth
  bestDepth: number | null;
}

/** Per-batch accumulation for member trajectories. The nearest depth is tracked
 *  incrementally; its filter is deferred to finalize. */
function accumulateMemberBatch(
  table: import("apache-arrow").Table,
  state: MemberAccumState,
  variable: string,
  depthM: number,
  referenceDate: string,
  maxHorizonDays: number,
): void {
  const n = table.numRows;
  const colDatetime = table.getChild("datetime");
  const colVariable = table.getChild("variable");
  const colDepth = table.getChild("depth");
  const colPrediction = table.getChild("prediction");
  const colParameter = table.getChild("parameter");
  const colForecast = table.getChild("forecast");
  if (!colDatetime || !colVariable || !colPrediction || !colParameter || !colDepth) return;

  for (let i = 0; i < n; i++) {
    if (colForecast && Number(colForecast.get(i)) !== 1) continue;
    if (String(colVariable.get(i) ?? "") !== variable) continue;
    const d = Number(colDepth.get(i));
    if (!Number.isFinite(d)) continue;
    if (state.bestDepth === null || Math.abs(d - depthM) < Math.abs(state.bestDepth - depthM)) state.bestDepth = d;

    const targetDate = toDateStr(colDatetime.get(i));
    if (!targetDate) continue;
    const horizon = daysBetween(referenceDate, targetDate);
    if (horizon <= 0 || horizon > maxHorizonDays) continue;
    const raw = Number(colPrediction.get(i));
    if (!Number.isFinite(raw)) continue;
    const value = normalizeFlareValue(variable, raw);
    const member = String(colParameter.get(i) ?? "");
    const key = `${member}|${targetDate}|${d}`;
    const prev = state.accum.get(key);
    if (prev) { prev.sum += value; prev.count += 1; }
    else state.accum.set(key, { sum: value, count: 1 });
  }
}

/** Finalize the streamed member accumulator into trajectories, applying the deferred
 *  nearest-depth filter. */
function finalizeMemberTrajectories(state: MemberAccumState, referenceDate: string): number[][] {
  if (state.bestDepth === null) return [];
  const byMember = new Map<string, Array<{ h: number; v: number }>>();
  for (const [key, { sum, count }] of state.accum) {
    const [member, targetDate, depthStr] = key.split("|");
    if (Math.abs(Number(depthStr) - state.bestDepth) > 0.05) continue;
    const h = daysBetween(referenceDate, targetDate);
    const arr = byMember.get(member) ?? [];
    arr.push({ h, v: sum / count });
    byMember.set(member, arr);
  }
  const trajectories: number[][] = [];
  for (const arr of byMember.values()) {
    arr.sort((a, b) => a.h - b.h);
    trajectories.push(arr.map((x) => x.v));
  }
  return trajectories;
}

// In-memory cache

interface FlareCacheEntry {
  fetchedAt: number;
  records: ForecastRecord[];
  referenceDate: string;
}

const flareCache = new Map<string, FlareCacheEntry>();

// Public API

/**
 * Fetch FLARE ensemble forecasts for a single site.
 *
 * Discovers the latest available reference date, downloads the single
 * Hive-partitioned parquet, and returns ForecastRecord[] with 221-member
 * ensemble statistics pre-computed (mean + p2.5/p10/p90/p97.5).
 *
 * Results are cached for LEADS_FORECAST_CACHE_TTL_MS (default 1 hour)
 * so repeated within-request calls are free.
 */
export async function fetchFlareForecasts(options: {
  siteId?: string;
  modelId?: string;
  variables?: readonly string[];
  maxHorizonDays?: number;
  /** Target depth(s) in metres. Each entry must correspond to an actual
   *  FLARE layer (see DEPTH_ZONE_MAPPING). An empty array reads the shallowest layer. */
  targetDepthsM?: number[];
}): Promise<ForecastRecord[]> {
  const siteId = options.siteId ?? LEADS_FLARE_SITE;
  const modelId = options.modelId ?? LEADS_FLARE_MODEL_ID;
  const variables = options.variables ?? LEADS_FLARE_VARIABLES;
  const maxHorizonDays = options.maxHorizonDays ?? 30;
  const targetDepthsM = options.targetDepthsM ?? [];

  // The cache key partitions by target-depth set so a hypolimnion query
  // does not return a surface-only cache entry (or vice versa).
  const depthKey = targetDepthsM.length === 0
    ? "surface"
    : [...targetDepthsM].sort((a, b) => a - b).join(",");
  const cacheKey = `${siteId}:${modelId}:${depthKey}`;
  const cached = flareCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LEADS_FORECAST_CACHE_TTL_MS) {
    return cached.records.filter(
      (r) => (variables as string[]).includes(r.variable) && r.horizon <= maxHorizonDays
    );
  }

  const referenceDate = await discoverLatestFlareDate(siteId, modelId);
  if (!referenceDate) return [];

  // Stream the parquet batch-by-batch and accumulate incrementally (see the
  // streaming-aggregation note above).
  const useTargetDepths = targetDepthsM.length > 0;
  const targetSet = new Set(targetDepthsM.map((d) => Math.round(d * 1000) / 1000));
  const state: ForecastAccumState = { accum: new Map(), minDepthPerVar: new Map() };
  let streamed = false;
  try {
    streamed = await streamFlareParquet(referenceDate, siteId, modelId, (batch) =>
      accumulateForecastBatch(batch, state, LEADS_FLARE_VARIABLES, useTargetDepths, targetSet, referenceDate, 35),
    );
  } catch (err) {
    console.error(`[flare-reader] fetch error for ${siteId}:`, err);
    return [];
  }
  if (!streamed) return [];

  // Cache the full 35-day horizon at the requested depth set; callers filter down as needed
  const records = finalizeForecastRecords(state, useTargetDepths, referenceDate, siteId, modelId, 35);
  flareCache.set(cacheKey, { fetchedAt: Date.now(), records, referenceDate });

  return records.filter(
    (r) => (variables as string[]).includes(r.variable) && r.horizon <= maxHorizonDays
  );
}

/**
 * Fetch FLARE forecasts for multiple sites in parallel.
 * Failures for individual sites are swallowed so one unavailable site
 * never blocks data for the others.
 */
export async function fetchFlareMultiSite(options: {
  siteIds: string[];
  variables?: readonly string[];
  maxHorizonDays?: number;
  /** Forwarded to each per-site fetch. */
  targetDepthsM?: number[];
}): Promise<ForecastRecord[]> {
  const results = await Promise.allSettled(
    options.siteIds.map((siteId) =>
      fetchFlareForecasts({
        siteId,
        variables: options.variables,
        maxHorizonDays: options.maxHorizonDays,
        targetDepthsM: options.targetDepthsM,
      })
    )
  );

  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

// Member-level persistence
//
// The quantile path above collapses the 221 members per day, which loses the
// information needed for a consecutive-run question ("≥7 days in a row"). For
// persistence decisions (flow_management) each member's full trajectory is kept
// and the members whose run on the risk side of the threshold reaches
// `minConsecutiveDays` are counted.

export interface MemberPersistence {
  /** Fraction of ensemble members whose longest risk-side run ≥ minConsecutiveDays. */
  probability: number;
  supportingMembers: number;
  totalMembers: number;
  /** Longest run across all members (context; in days). */
  longestRunMax: number;
  referenceDate: string;
  depthM: number;
}

const persistenceCache = new Map<string, { fetchedAt: number; value: MemberPersistence | null }>();

/**
 * P(≥ minConsecutiveDays consecutive days on the risk side of `threshold`) over
 * the FLARE ensemble, used by the persistence guardrail. Fails open (returns
 * null) so it never blocks the pipeline.
 */
export async function computeMemberPersistence(opts: {
  siteId: string;
  variable: string;
  threshold: number;
  direction: "above" | "below";
  minConsecutiveDays: number;
  depthM: number;
  modelId?: string;
  maxHorizonDays?: number;
}): Promise<MemberPersistence | null> {
  const modelId = opts.modelId ?? LEADS_FLARE_MODEL_ID;
  const maxH = opts.maxHorizonDays ?? 14;
  const key = `${opts.siteId}:${opts.variable}:${opts.depthM}:${opts.threshold}:${opts.direction}:${opts.minConsecutiveDays}:${maxH}`;
  const cached = persistenceCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < LEADS_FORECAST_CACHE_TTL_MS) return cached.value;

  try {
    const referenceDate = await discoverLatestFlareDate(opts.siteId, modelId);
    if (!referenceDate) return null;
    const mSt: MemberAccumState = { accum: new Map(), bestDepth: null };
    const streamed = await streamFlareParquet(referenceDate, opts.siteId, modelId, (batch) =>
      accumulateMemberBatch(batch, mSt, opts.variable, opts.depthM, referenceDate, maxH),
    );
    if (!streamed) return null;

    const trajectories = finalizeMemberTrajectories(mSt, referenceDate);
    if (trajectories.length === 0) return null;

    let supporting = 0;
    let longestRunMax = 0;
    for (const traj of trajectories) {
      let cur = 0;
      let best = 0;
      for (const v of traj) {
        const onRisk = opts.direction === "below" ? v < opts.threshold : v > opts.threshold;
        cur = onRisk ? cur + 1 : 0;
        if (cur > best) best = cur;
      }
      if (best > longestRunMax) longestRunMax = best;
      if (best >= opts.minConsecutiveDays) supporting += 1;
    }
    const value: MemberPersistence = {
      probability: supporting / trajectories.length,
      supportingMembers: supporting,
      totalMembers: trajectories.length,
      longestRunMax,
      referenceDate,
      depthM: opts.depthM,
    };
    persistenceCache.set(key, { fetchedAt: Date.now(), value });
    return value;
  } catch (err) {
    console.error(`[flare-reader] persistence error for ${opts.siteId}/${opts.variable}:`, err);
    return null;
  }
}

// Ensemble member trajectories (chart display only)

/** One trajectory per ensemble member, aligned to `dates` (null where a member has no value
 *  on a date), for one variable at the FLARE layer nearest `depthM`, from the latest run. */
export interface MemberTrajectories {
  referenceDate: string;
  depthM: number;
  dates: string[];
  members: (number | null)[][];
}

const memberTrajCache = new Map<string, { fetchedAt: number; value: MemberTrajectories | null }>();

/**
 * Ensemble member trajectories for the chart's optional "Show ensemble members" view.
 * Display-only: the answer pipeline, the guardrails and the evaluation do not call
 * it. It reuses the streaming member accumulator above (same depth
 * selection and unit normalisation as computeMemberPersistence) but keeps each value's
 * date, so the trajectories line up with the plotted forecast days. Fails open (null).
 */
export async function fetchMemberTrajectories(opts: {
  siteId: string;
  variable: string;
  depthM: number;
  maxHorizonDays?: number;
  modelId?: string;
}): Promise<MemberTrajectories | null> {
  const modelId = opts.modelId ?? LEADS_FLARE_MODEL_ID;
  const maxH = opts.maxHorizonDays ?? 35;
  const key = `${opts.siteId}:${modelId}:${opts.variable}:${opts.depthM}:${maxH}`;
  const cached = memberTrajCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < LEADS_FORECAST_CACHE_TTL_MS) return cached.value;

  try {
    const referenceDate = await discoverLatestFlareDate(opts.siteId, modelId);
    if (!referenceDate) return null;
    const st: MemberAccumState = { accum: new Map(), bestDepth: null };
    const streamed = await streamFlareParquet(referenceDate, opts.siteId, modelId, (batch) =>
      accumulateMemberBatch(batch, st, opts.variable, opts.depthM, referenceDate, maxH),
    );
    if (!streamed || st.bestDepth === null) return null;

    const byMember = new Map<string, Map<string, number>>();
    const dateSet = new Set<string>();
    for (const [k, { sum, count }] of st.accum) {
      const [member, targetDate, depthStr] = k.split("|");
      if (Math.abs(Number(depthStr) - st.bestDepth) > 0.05) continue;
      const row = byMember.get(member) ?? new Map<string, number>();
      row.set(targetDate, sum / count);
      byMember.set(member, row);
      dateSet.add(targetDate);
    }
    const dates = [...dateSet].sort();
    if (!dates.length || !byMember.size) return null;
    const members = [...byMember.values()].map((row) => dates.map((d) => row.get(d) ?? null));
    const value: MemberTrajectories = { referenceDate, depthM: st.bestDepth, dates, members };
    memberTrajCache.set(key, { fetchedAt: Date.now(), value });
    return value;
  } catch (err) {
    console.error(`[flare-reader] member trajectories error for ${opts.siteId}/${opts.variable}:`, err);
    return null;
  }
}
