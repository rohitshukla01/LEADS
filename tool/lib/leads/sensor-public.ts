import { gunzipSync } from "zlib";

import { evalNowIso, LEADS_PUBLIC_SENSOR_TTL_MS, LEADS_PUBLIC_VERA_URL } from "./config";
import type {
  LeadsBaselineStats,
  LeadsEvidence,
  LeadsQueryPlan,
  LeadsSensorRecord,
} from "./types";

interface PublicSensorCache {
  fetchedAt: number;
  records: LeadsSensorRecord[];
}

let cache: PublicSensorCache | null = null;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayOfYear(isoish: string): number {
  const date = new Date(isoish.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return 0;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.max(1, Math.floor((current - start) / 86400000));
}

function seasonForDay(doy: number) {
  if (doy < 80 || doy >= 355) return "winter";
  if (doy < 172) return "spring";
  if (doy < 266) return "summer";
  return "fall";
}

function depthBucket(depthM: number | null) {
  if (depthM == null) return "unknown";
  if (depthM < 2) return "surface";
  if (depthM < 6) return "mid";
  return "deep";
}

export async function fetchPublicSensorRecords(force = false): Promise<LeadsSensorRecord[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < LEADS_PUBLIC_SENSOR_TTL_MS) {
    return cache.records;
  }

  // Bounded fetch: without a timeout an unreachable or slow OSN bucket hangs the whole
  // request. The 30 s cap makes it fail fast so callers degrade instead of hanging.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(LEADS_PUBLIC_VERA_URL, {
      signal: controller.signal,
      next: { revalidate: Math.floor(LEADS_PUBLIC_SENSOR_TTL_MS / 1000) },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Public VERA fetch failed: ${response.status}`);
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  const text = gunzipSync(compressed).toString("utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]);
  const index = Object.fromEntries(header.map((key, i) => [key, i]));

  const records = lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    return {
      projectId: fields[index.project_id] ?? "",
      siteId: (fields[index.site_id] ?? "").toLowerCase(),
      datetime: fields[index.datetime] ?? "",
      duration: fields[index.duration] ?? "",
      depthM: toNumber(fields[index.depth_m] ?? ""),
      variable: fields[index.variable] ?? "",
      observation: toNumber(fields[index.observation] ?? ""),
    } satisfies LeadsSensorRecord;
  });

  cache = { fetchedAt: Date.now(), records };
  return records;
}

function matchesHints(record: LeadsSensorRecord, plan: LeadsQueryPlan) {
  const siteMatch = plan.siteHints.length === 0 || plan.siteHints.includes(record.siteId);
  const variableMatch =
    plan.variableHints.length === 0 || plan.variableHints.includes(record.variable);
  // Depth-zone filter: when the profile resolved to specific depth(s), drop
  // records at other depths so the LLM does not see surface DO mixed with
  // hypolimnetic DO. Tolerance ±0.05 m (sensor depths are integers or
  // one-decimal values).
  const depthMatch =
    !plan.resolvedDepthsM ||
    plan.resolvedDepthsM.length === 0 ||
    record.depthM == null ||
    plan.resolvedDepthsM.some((d) => Math.abs((record.depthM as number) - d) <= 0.05);
  return siteMatch && variableMatch && depthMatch;
}

export function computeBaselineStats(records: LeadsSensorRecord[], window = 14): LeadsBaselineStats[] {
  const buckets = new Map<string, number[]>();

  for (const record of records) {
    if (record.observation == null) continue;
    const doy = dayOfYear(record.datetime);
    if (!doy) continue;
    const bucket = depthBucket(record.depthM);

    for (let offset = -window; offset <= window; offset += 1) {
      let target = doy + offset;
      if (target < 1) target += 366;
      if (target > 366) target -= 366;
      const key = [record.siteId, record.variable, bucket, target].join("|");
      const arr = buckets.get(key) ?? [];
      arr.push(record.observation);
      buckets.set(key, arr);
    }
  }

  return Array.from(buckets.entries()).map(([key, values]) => {
    const [siteId, variable, depthGroup, day] = key.split("|");
    const count = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(count, 1);
    return {
      siteId,
      variable,
      depthBucket: depthGroup,
      dayOfYear: Number(day),
      count,
      mean,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  });
}

/**
 * All-time stats per (site, variable, depthBucket) across all records, with
 * no day-of-year windowing. Used for "lowest/highest ever observed" aggregate
 * queries and the climatology range banner.
 *
 * Distinct from `computeBaselineStats`, which is DOY±14-windowed for per-record
 * seasonal anomaly comparison; a windowed bucket's min/max misses any extreme
 * that falls outside the current day-of-year window.
 */
export function computeAllTimeStats(records: LeadsSensorRecord[]): LeadsBaselineStats[] {
  const buckets = new Map<string, number[]>();
  for (const record of records) {
    if (record.observation == null) continue;
    const key = [record.siteId, record.variable, depthBucket(record.depthM)].join("|");
    const arr = buckets.get(key) ?? [];
    arr.push(record.observation);
    buckets.set(key, arr);
  }
  return Array.from(buckets.entries()).map(([key, values]) => {
    const [siteId, variable, depthGroup] = key.split("|");
    const count = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(count, 1);
    return {
      siteId,
      variable,
      depthBucket: depthGroup,
      dayOfYear: 0, // sentinel: 0 = not DOY-scoped (all-time aggregate)
      count,
      mean,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  });
}

export function baselineForRecord(record: LeadsSensorRecord, baselines: LeadsBaselineStats[]) {
  const doy = dayOfYear(record.datetime);
  const bucket = depthBucket(record.depthM);
  return (
    baselines.find(
      (baseline) =>
        baseline.siteId === record.siteId &&
        baseline.variable === record.variable &&
        baseline.depthBucket === bucket &&
        baseline.dayOfYear === doy
    ) ?? null
  );
}

function comparisonText(record: LeadsSensorRecord, baseline: LeadsBaselineStats | null) {
  if (!baseline || record.observation == null) {
    return "No matched seasonal baseline comparison is available for this record.";
  }

  const obs = record.observation;
  if (obs > baseline.max) {
    return "This observation is above the matched historical window.";
  }
  if (obs < baseline.min) {
    return "This observation is below the matched historical window.";
  }
  if (obs === baseline.max) {
    return "This observation matches the upper bound of the matched historical window.";
  }
  if (obs === baseline.min) {
    return "This observation matches the lower bound of the matched historical window.";
  }

  const ratio = baseline.mean === 0 ? null : obs / baseline.mean;
  if (ratio != null && ratio >= 1.5) {
    return "This observation is above the matched seasonal mean but still within the historical window.";
  }
  if (ratio != null && ratio <= 0.5) {
    return "This observation is below the matched seasonal mean but still within the historical window.";
  }

  return "This observation falls within the matched historical window.";
}

/**
 * Classify a record's age vs an "as of" date so the LLM can never silently
 * treat a year-old trend sample as a current observation.
 * Thresholds match the continuous-sensor windows in freshness-policy.ts:
 *   up to 3 days:  "current"
 *   up to 14 days: "recent"
 *   older:         "historical sample" (trend context only, not a live reading)
 */
function recencyAnnotation(recordDatetime: string, asOfIso: string) {
  const recordMs = Date.parse(recordDatetime.replace(" ", "T") + "Z");
  const asOfMs = Date.parse(asOfIso);
  if (!Number.isFinite(recordMs) || !Number.isFinite(asOfMs)) {
    return { ageDays: null, status: "unknown-age" as const, label: "record age unknown" };
  }
  // Calendar-day difference, not elapsed time (as in lib/leads/freshness-policy.ts).
  // The record stamp is a date (midnight) and asOf is the current instant, so rounding
  // raw milliseconds would overstate the age by a day.
  const dayFloor = (ms: number) => Math.floor(ms / 86400000) * 86400000;
  const ageDays = Math.max(0, Math.round((dayFloor(asOfMs) - dayFloor(recordMs)) / 86400000));
  let status: "current" | "recent" | "historical-sample";
  if (ageDays <= 3) status = "current";
  else if (ageDays <= 14) status = "recent";
  else status = "historical-sample";
  const label =
    status === "historical-sample"
      ? `record age: ${ageDays} days old as of ${asOfIso.slice(0, 10)} — ⚠ HISTORICAL TREND SAMPLE, NOT a current observation`
      : status === "recent"
      ? `record age: ${ageDays} days old as of ${asOfIso.slice(0, 10)} — recent`
      : `record age: ${ageDays} days old as of ${asOfIso.slice(0, 10)} — current`;
  return { ageDays, status, label };
}

function evidenceText(
  record: LeadsSensorRecord,
  baseline: LeadsBaselineStats | null,
  asOfIso: string,
) {
  const doy = dayOfYear(record.datetime);
  const season = seasonForDay(doy);
  const obs = record.observation == null ? "missing" : record.observation.toFixed(2);
  const baselineText =
    baseline && record.observation != null
      ? `Seasonal baseline for this time of year (day-of-year ±14-day window aggregated across all years — a SEASONAL range, NOT the all-time min/max and NOT a specific dated observation): seasonal mean ${baseline.mean.toFixed(2)}, seasonal-window min ${baseline.min.toFixed(2)}, seasonal-window max ${baseline.max.toFixed(2)} across ${baseline.count} observations.`
      : "No seasonal baseline available for this record.";
  const relationText = comparisonText(record, baseline);
  const recency = recencyAnnotation(record.datetime, asOfIso);

  return `Sensor observation at ${record.siteId.toUpperCase()} on ${record.datetime} for ${record.variable} at ${record.depthM ?? "unknown"} m depth is ${obs} (${recency.label}). Season label: ${season}. ${baselineText} ${relationText}`;
}

export async function retrievePublicSensorEvidence(plan: LeadsQueryPlan): Promise<LeadsEvidence[]> {
  let records: LeadsSensorRecord[];
  try {
    records = await fetchPublicSensorRecords();
  } catch {
    // Feed-down guard: if the live VERA feed is unreachable, degrade gracefully with
    // an explicit, high-priority notice instead of throwing (which would fail the whole
    // query) or silently implying the data simply doesn't exist for this question.
    return [
      {
        id: "sensor:feed-unavailable",
        channel: "sensor",
        title: "Sensor feed unavailable",
        text:
          "⚠ SENSOR FEED UNAVAILABLE — the VERA in-situ sensor feed could not be reached, so " +
          "current sensor observations are temporarily unavailable. Do NOT state specific sensor values " +
          "as current; tell the user plainly that the sensor feed is unavailable right now, and base " +
          "any answer on the forecast and literature with appropriate caution.",
        score: 0.99,
        provenance: {
          type: "sensor",
          label: "sensor feed status",
          sourceUrl: LEADS_PUBLIC_VERA_URL,
          method: "feed-unavailable-guard",
          score: 0.99,
        },
      },
    ];
  }
  // Reproducibility freeze: when LEADS_AS_OF is pinned (evaluation/snapshot runs), ignore
  // any record dated after the as-of so the "latest reading", seasonal baselines, and
  // Layer-2 freshness are all computed against the frozen data. When LEADS_AS_OF is unset,
  // evalNowIso() is the current time and this filter keeps every record.
  const asOfDate = evalNowIso().slice(0, 10);
  records = records.filter((record) => record.datetime.slice(0, 10) <= asOfDate);

  const baselines = computeBaselineStats(records);

  const matched = records.filter((record) => matchesHints(record, plan) && record.observation != null);
  const sorted = matched.sort((left, right) => right.datetime.localeCompare(left.datetime));

  let sliced: typeof sorted;
  const hasYear = plan.yearHints && plan.yearHints.length > 0;
  const hasMonth = plan.monthHints && plan.monthHints.length > 0;
  const hasDay = plan.dayHints && plan.dayHints.length > 0;

  if (hasYear && hasMonth && hasDay) {
    // Exact date (e.g. "May 26 2025" or "2025-05-26"): filter to precise YYYY-MM-DD strings.
    const exactDates = plan.yearHints.flatMap((y) =>
      plan.monthHints.flatMap((mo) =>
        plan.dayHints.map(
          (d) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
        )
      )
    );
    sliced = sorted
      .filter((r) => exactDates.some((date) => r.datetime.startsWith(date)))
      .slice(0, 30);
    if (sliced.length < 5) {
      // Pad with the surrounding week in that month so the LLM has context
      const yearMonthPrefixes = plan.yearHints.flatMap((y) =>
        plan.monthHints.map((mo) => `${y}-${String(mo).padStart(2, "0")}`)
      );
      const monthFallback = sorted
        .filter((r) => yearMonthPrefixes.some((p) => r.datetime.startsWith(p)))
        .filter((r) => !sliced.includes(r));
      sliced = [...sliced, ...monthFallback].slice(0, 30);
    }
  } else if (hasYear && hasMonth) {
    // Specific month+year (e.g. "May 2025"): filter to exact YYYY-MM prefixes so
    // newest-first sort doesn't skip the target month by exhausting the 30-record cap
    // with records from later months of the same year.
    const yearMonthPrefixes = plan.yearHints.flatMap((y) =>
      plan.monthHints.map((m) => `${y}-${String(m).padStart(2, "0")}`)
    );
    sliced = sorted
      .filter((r) => yearMonthPrefixes.some((prefix) => r.datetime.startsWith(prefix)))
      .slice(0, 30);
    if (sliced.length < 5) {
      // Pad with any records from those years so the LLM has broader context
      const yearFallback = sorted
        .filter((r) => plan.yearHints.includes(Number(r.datetime.slice(0, 4))))
        .filter((r) => !sliced.includes(r));
      sliced = [...sliced, ...yearFallback].slice(0, 30);
    }
  } else if (hasYear) {
    // Year-only query: sample up to 3 records per calendar month, oldest month first.
    const yearFiltered = sorted.filter((r) =>
      plan.yearHints.includes(Number(r.datetime.slice(0, 4)))
    );
    const byMonth = new Map<string, typeof sorted>();
    for (const r of yearFiltered) {
      const ym = r.datetime.slice(0, 7); // "YYYY-MM"
      const bucket = byMonth.get(ym) ?? [];
      bucket.push(r);
      byMonth.set(ym, bucket);
    }
    // Take up to 3 records per month (newest within that month), sorted by date
    sliced = [...byMonth.values()]
      .flatMap((recs) => recs.slice(0, 3))
      .sort((a, b) => a.datetime.localeCompare(b.datetime))
      .slice(0, 30);
    if (sliced.length < 5) {
      const recent = sorted.slice(0, 10);
      sliced = [...sliced, ...recent.filter((r) => !sliced.includes(r))].slice(0, 30);
    }
  } else {
    // Temporal / trend queries ("how has X changed over time", "historical",
    // "trend", "seasonal") are not limited to the last 7 days: sample 2 records
    // per month across the past 3 years, oldest first.
    const isTrendQuery =
      plan.queryMode === "temporal" ||
      plan.timeHints.includes("baseline") ||
      /(trend|over time|historically|inter.?annual|year.?to.?year|long.?term|multi.?year|seasonal pattern|across years)/i.test(
        plan.originalQuery
      );

    if (isTrendQuery) {
      const threeYearsAgo = new Date(evalNowIso());
      threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
      const cutoffStr = threeYearsAgo.toISOString().slice(0, 10);
      const trendRecords = sorted.filter((r) => r.datetime.slice(0, 10) >= cutoffStr);
      const byMonthTrend = new Map<string, typeof sorted>();
      for (const r of trendRecords) {
        const ym = r.datetime.slice(0, 7);
        const bucket = byMonthTrend.get(ym) ?? [];
        bucket.push(r);
        byMonthTrend.set(ym, bucket);
      }
      // 2 records per month, oldest first, capped at 30; only the first few reach the answer (sensor cap in orchestrator.ts).
      sliced = [...byMonthTrend.values()]
        .flatMap((recs) => recs.slice(0, 2))
        .sort((a, b) => a.datetime.localeCompare(b.datetime))
        .slice(0, 30);
    } else {
      // Default: newest-first 7-day trailing window, capped at 24 items
      const latestDate = sorted[0]?.datetime.slice(0, 10) ?? "";
      const cutoff = latestDate
        ? new Date(new Date(latestDate).getTime() - 6 * 86400000).toISOString().slice(0, 10)
        : "";
      const recent = cutoff ? sorted.filter((r) => r.datetime.slice(0, 10) >= cutoff) : sorted;
      sliced = recent.slice(0, 24);
    }
  }

  // Cadence-aware retrieval guarantee. The slices above are tuned for daily
  // continuous data (e.g. a 7-day trailing window). When a query mixes cadences
  // (a current continuous variable and a weekly/seasonal sample variable such as
  // FluoroProbe or soluble Fe/Mn), the older sample records fall outside the
  // continuous window and get dropped, so Layer 2 would see them as MISSING
  // rather than judge their true age (STALE vs OFF_SEASON). Each requested
  // variable's freshest matched observation is therefore kept so the freshness
  // policy can assess every required variable at its real observation date.
  //
  // For a full_profile decision (water extraction), the qualifying-depth search
  // needs the whole vertical profile, so every record on each variable's
  // freshest sample date (all depths) is included, not just the first one.
  const fullProfile = plan.resolvedDepthScope === "full_profile";
  const freshestDateByVar = new Map<string, string>();
  for (const r of sorted) {
    if (!freshestDateByVar.has(r.variable)) {
      freshestDateByVar.set(r.variable, r.datetime.slice(0, 10)); // sorted newest-first
    }
  }
  for (const [variable, date] of freshestDateByVar) {
    const onFreshestDate = sorted.filter(
      (r) => r.variable === variable && r.datetime.slice(0, 10) === date,
    );
    const toAdd = fullProfile ? onFreshestDate : onFreshestDate.slice(0, 1);
    for (const r of toAdd) {
      if (!sliced.includes(r)) sliced.push(r);
    }
  }

  // If year hints were given but produced no records, check whether the
  // requested years pre-date the VERA4cast data start (2018-07-06) and inject
  // an explanatory evidence item so the LLM can tell the user why data is
  // absent rather than returning a generic empty/unsupported answer.
  const dataStartDate = records.length > 0
    ? records.map((r) => r.datetime.slice(0, 10)).sort()[0]
    : "2018-07-06";

  if (sliced.length === 0 && plan.yearHints && plan.yearHints.length > 0) {
    const requestedYears = plan.yearHints;
    const dataStartYear = Number(dataStartDate.slice(0, 4));
    const allPreData = requestedYears.every((y) => y < dataStartYear);
    const somePreData = requestedYears.some((y) => y < dataStartYear);

    const sites = plan.siteHints.length > 0 ? plan.siteHints.map((s) => s.toUpperCase()).join(", ") : "this site";
    const vars = plan.variableHints.length > 0 ? plan.variableHints.join(", ") : "the requested variable";

    const availNote = allPreData
      ? `No sensor data is available for ${vars} at ${sites} for ${requestedYears.join(", ")}. ` +
        `The VERA4CAST / LTREB continuous monitoring record begins on ${dataStartDate}. ` +
        `Data from before this date does not exist in the system. ` +
        `For historical context prior to ${dataStartYear}, consult published LTREB or EDI data packages.`
      : somePreData
      ? `Partial data gap: some requested years (${requestedYears.filter((y) => y < dataStartYear).join(", ")}) ` +
        `pre-date the monitoring start (${dataStartDate}) for ${vars} at ${sites}. ` +
        `Records exist from ${dataStartDate} onward only.`
      : `No matching sensor records found for ${vars} at ${sites} for the requested period. ` +
        `The monitoring record runs from ${dataStartDate} to present.`;

    return [{
      id: `sensor:data-availability:${requestedYears.join("-")}`,
      channel: "sensor" as const,
      title: `Data availability note — ${sites}`,
      text: availNote,
      score: 0.5,
      provenance: {
        type: "sensor" as const,
        label: "VERA4CAST data availability",
        sourceUrl: LEADS_PUBLIC_VERA_URL,
      },
    }];
  }

  const asOfIso = evalNowIso();
  const sensorItems: LeadsEvidence[] = sliced.map((record, index) => {
    const baseline = baselineForRecord(record, baselines);
    const score = Math.max(0.2, 1 - index * 0.05);
    const doy = dayOfYear(record.datetime);
    return {
      id: `sensor:${record.siteId}:${record.variable}:${record.datetime}:${record.depthM ?? "na"}`,
      channel: "sensor" as const,
      title: `${record.siteId.toUpperCase()} ${record.variable}`,
      text: evidenceText(record, baseline, asOfIso),
      score,
      provenance: {
        type: "sensor" as const,
        label: `${record.siteId.toUpperCase()} ${record.variable}`,
        sourceUrl: LEADS_PUBLIC_VERA_URL,
        siteId: record.siteId,
        variable: record.variable,
        depthM: record.depthM,
        observation: record.observation, // value for deterministic constraint evaluation
        timestamp: record.datetime,
        season: seasonForDay(doy),
        baselineWindow: baseline ? `DOY ${baseline.dayOfYear} +/- 14 days` : undefined,
        score,
        method: "public-vera-daily",
      },
    };
  });

  // Append one aggregated summary of the full observed range (all-time min, max
  // and mean per site and variable, across all depths), independent of how many
  // recent point observations matched the query hints.
  const currentDoy = dayOfYear(evalNowIso().slice(0, 10));
  const currentSeason = seasonForDay(currentDoy);
  const targetSites = plan.siteHints.length > 0 ? plan.siteHints : ["fcre", "bvre", "ccre"];
  const targetVariables =
    plan.variableHints.length > 0
      ? plan.variableHints
      : ["Temp_C_mean", "Chla_ugL_mean", "DO_mgL_mean"];

  // All-time extremes (no day-of-year windowing) so "lowest/highest ever
  // observed" aggregate queries get the real min/max. The DOY-windowed
  // `baselines` are for per-record seasonal anomaly comparison only.
  const allTimeStats = computeAllTimeStats(records);
  const climatologySummaries = targetSites.flatMap((siteId) =>
    targetVariables.flatMap((variable) => {
      const buckets = allTimeStats.filter((b) => b.siteId === siteId && b.variable === variable);
      if (buckets.length === 0) return [];
      const count = buckets.reduce((sum, b) => sum + b.count, 0);
      const min = Math.min(...buckets.map((b) => b.min));
      const max = Math.max(...buckets.map((b) => b.max));
      const mean = buckets.reduce((sum, b) => sum + b.mean * b.count, 0) / Math.max(count, 1);
      return [
        `${siteId.toUpperCase()} ${variable}: all-time observed min ${min.toFixed(2)}, ` +
          `all-time observed max ${max.toFixed(2)}, all-time mean ${mean.toFixed(2)} ` +
          `(TRUE extremes across ${count} observations spanning the full record at all depths — ` +
          `use THIS for "lowest/highest ever observed" questions, NOT the seasonal baseline)`,
      ];
    })
  );

  // Data-recency banner: synthesize one high-priority evidence item that
  // states the freshest VERA record per (site, variable) of interest along
  // with its age in days. This prevents the LLM from confabulating a
  // historical trend sample as "the most recent observation" when the trend
  // branch pulls multi-year samples (e.g. a 2023 record interleaved with
  // 2026 records). The banner is anchored to absolute dates so a manager
  // reading the answer can always see how current the data really is.
  const recencyTargetSites =
    plan.siteHints.length > 0 ? plan.siteHints : ["fcre", "bvre"];
  const recencyTargetVariables =
    plan.variableHints.length > 0
      ? plan.variableHints
      : ["Temp_C_mean", "DO_mgL_mean", "Chla_ugL_mean"];
  const recencyLines: string[] = [];
  const depthGapLines: string[] = [];
  for (const siteId of recencyTargetSites) {
    for (const variable of recencyTargetVariables) {
      const matching = records.filter(
        (r) => r.siteId === siteId && r.variable === variable && r.observation != null,
      );
      if (matching.length === 0) {
        recencyLines.push(
          `${siteId.toUpperCase()} ${variable}: no records available in the VERA daily-insitu file.`,
        );
        continue;
      }
      // Report the latest record per depth, not just the single most recent record
      // across all depths. Stratified variables (DO, temperature) differ sharply by
      // depth, so a deep (9 m hypolimnion) reading must not be dropped when a
      // shallower depth shares the same freshest date.
      const latestByDepth = new Map<string, LeadsSensorRecord>();
      for (const r of matching) {
        const key = r.depthM == null ? "unknown" : String(r.depthM);
        const prev = latestByDepth.get(key);
        if (!prev || r.datetime.localeCompare(prev.datetime) > 0) latestByDepth.set(key, r);
      }
      const perDepth = [...latestByDepth.values()]
        .sort((a, b) => (a.depthM ?? Number.POSITIVE_INFINITY) - (b.depthM ?? Number.POSITIVE_INFINITY))
        .map((latest) => {
          const rec = recencyAnnotation(latest.datetime, asOfIso);
          const flag =
            rec.status === "current"
              ? "current"
              : rec.status === "recent"
              ? "recent"
              : "⚠ not-current (upstream push lag)";
          return `${latest.depthM ?? "unknown"} m: ${latest.datetime.slice(0, 10)} = ${latest.observation!.toFixed(2)} (${rec.ageDays}d old, ${flag})`;
        });
      recencyLines.push(`${siteId.toUpperCase()} ${variable} — latest per depth → ${perDepth.join("; ")}`);

      // Explicit "requested depth not measured" notice: if the query named a
      // specific depth (numeric "at 9 m" or a zone resolved to meters) and this
      // query-relevant variable has no record there (though it is measured at
      // other depths), say so deterministically instead of leaving the absence
      // implicit. Applies in both operational and informational modes.
      const reqDepths = plan.resolvedDepthsM ?? [];
      const variableRequested = (plan.variableHints ?? []).includes(variable);
      if (reqDepths.length > 0 && variableRequested) {
        const hasAtRequested = matching.some(
          (r) => r.depthM != null && reqDepths.some((d) => Math.abs((r.depthM as number) - d) <= 0.05),
        );
        if (!hasAtRequested) {
          // Report only depths with current/recent data (stale depths are covered
          // by the recency snapshot), and lead with the deepest usable depth - the
          // actionable fact when someone asks about a deeper, unmeasured layer.
          const fresh = [...latestByDepth.values()]
            .filter((latest) => {
              const st = recencyAnnotation(latest.datetime, asOfIso).status;
              return latest.depthM != null && (st === "current" || st === "recent");
            })
            .map((latest) => latest.depthM as number)
            .sort((a, b) => a - b);
          let coverage: string;
          if (fresh.length === 0) {
            coverage = "no other depth has current data either (all readings are stale — see the recency snapshot)";
          } else {
            const list =
              fresh.length <= 6
                ? fresh.map((d) => `${d} m`).join(", ")
                : `${fresh.length} depths from ${fresh[0]} m to ${fresh[fresh.length - 1]} m`;
            coverage = `current data exists at ${list} (deepest current depth: ${fresh[fresh.length - 1]} m)`;
          }
          depthGapLines.push(
            `${siteId.toUpperCase()} ${variable}: NO sensor at the requested ${reqDepths.join("/")} m depth — ${coverage}.`,
          );
        }
      }
    }
  }
  if (recencyLines.length > 0) {
    sensorItems.unshift({
      id: `sensor:recency-banner:${recencyTargetSites.join(",")}:${recencyTargetVariables.join(",")}`,
      channel: "sensor",
      title: `VERA data recency snapshot (as of ${asOfIso.slice(0, 10)})`,
      text:
        `DATA RECENCY ANCHOR — use this to determine what counts as "current" sensor data. ` +
        `Any record older than 3 days is NOT a current observation; any record older than 14 days ` +
        `is a historical trend sample for context only and MUST NOT be presented as the latest reading. ` +
        recencyLines.join(" | "),
      score: 0.95,
      provenance: {
        type: "sensor",
        label: "VERA recency snapshot",
        sourceUrl: LEADS_PUBLIC_VERA_URL,
        method: "public-vera-recency-banner",
        score: 0.95,
      },
    });
  }

  if (depthGapLines.length > 0) {
    sensorItems.unshift({
      id: `sensor:depth-unavailable:${recencyTargetSites.join(",")}:${recencyTargetVariables.join(",")}`,
      channel: "sensor",
      title: "Requested depth not measured",
      text:
        `DEPTH AVAILABILITY — the question asks about a depth that has no sensor for the requested ` +
        `variable. State this plainly to the user: there is NO observation at that depth; do NOT ` +
        `substitute another depth's value as if it were the requested one; if useful, point to the ` +
        `depths that ARE measured. ` +
        depthGapLines.join(" | "),
      score: 0.96,
      provenance: {
        type: "sensor",
        label: "depth availability",
        sourceUrl: LEADS_PUBLIC_VERA_URL,
        method: "depth-availability-guard",
        score: 0.96,
      },
    });
  }

  if (climatologySummaries.length > 0) {
    sensorItems.push({
      id: `sensor:baseline:${targetSites.join(",")}:${targetVariables.join(",")}`,
      channel: "sensor",
      title: `${currentSeason} seasonal baseline`,
      text:
        `Seasonal climatological baseline for query "${plan.originalQuery}": ` +
        `${climatologySummaries.join("; ")}.`,
      score: 0.72,
      provenance: {
        type: "sensor",
        label: `${currentSeason} climatological baseline`,
        sourceUrl: LEADS_PUBLIC_VERA_URL,
        season: currentSeason,
        baselineWindow: "day-of-year \u00b114-day climatology",
        method: "public-baseline-climatology",
        score: 0.72,
      },
    });
  }

  return sensorItems;
}
