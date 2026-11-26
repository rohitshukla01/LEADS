// LEADS Insights - the chart data layer. What to chart (variable, site, depth, window)
// is decided by the pipeline planner (lib/leads/router.ts `buildChartSpec`); this module
// fetches the matching series from the deterministic /api/sensors and /api/forecast
// endpoints. It imports nothing from lib/leads at runtime. Every call is fail-soft: on
// any error or empty result it returns null, and the panel draws only what loaded.

export type SeriesPoint = { t: string; v: number };
export type ForecastPoint = { t: string; mean: number; lower: number; upper: number; p10?: number; p90?: number };

export type VariableMeta = {
  key: string; // canonical VERA/FLARE variable name
  label: string;
  units: string;
  flare: boolean; // FLARE forecast available for this variable
};

/** Canonical variables LEADS can chart (names match VERA + FLARE config). */
export const VARIABLE_META: Record<string, VariableMeta> = {
  DO_mgL_mean: { key: "DO_mgL_mean", label: "Dissolved oxygen", units: "mg/L", flare: true },
  Temp_C_mean: { key: "Temp_C_mean", label: "Water temperature", units: "°C", flare: true },
  Chla_ugL_mean: { key: "Chla_ugL_mean", label: "Chlorophyll-a", units: "µg/L", flare: true },
  fDOM_QSU_mean: { key: "fDOM_QSU_mean", label: "fDOM", units: "QSU", flare: false },
  Turbidity_FNU_mean: { key: "Turbidity_FNU_mean", label: "Turbidity", units: "FNU", flare: false },
};

const RESERVOIR_SITE: Record<string, string> = { fcr: "fcre", bvr: "bvre" };

// Canonical sensor depth (m) per site × zone - mirrors the pipeline's
// DEPTH_ZONE_MAPPING so the chart pins to the same depth the answer uses
// (e.g. FCR epilimnion = 1.6 m, not a stray 1.0 m sensor).
const ZONE_DEPTH: Record<string, Record<string, number>> = {
  fcre: { epilimnion: 1.6, metalimnion: 5, hypolimnion: 9 },
  bvre: { epilimnion: 1.5, metalimnion: 6, hypolimnion: 8 },
};

/** Map a planner reservoir (fcr/bvr) to a VERA/FLARE site (fcre/bvre). */
export function siteForReservoir(reservoir: string | undefined | null): string {
  if (!reservoir) return "fcre";
  return RESERVOIR_SITE[reservoir.toLowerCase()] ?? "fcre";
}

// Display helpers shared by the chart panel and the PDF (display only)

/** Round axis ticks spanning [min, max] with about `target` ticks on a 1/2/5 x 10^k step.
 *  Shared by the forecast chart and the forecast-skill plot (screen and PDF). */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const b = Number.isFinite(min) ? min : 0;
    return [b - 1, b, b + 1];
  }
  const range = max - min;
  const rawStep = range / Math.max(1, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const nMin = Math.floor(min / step) * step;
  const nMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = nMin; v <= nMax + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks.length >= 2 ? ticks : [min, max];
}


/** The single site display table. The data layer keys a site by its VERA/FLARE id ("fcre")
 *  and the profile by its reservoir ("fcr"); printed, both must name the same reservoir.
 *  Unknown ids fall back to upper case, so nothing is ever dropped. */
const SITE_DISPLAY: Record<string, string> = {
  fcre: "FCR", fcr: "FCR", bvre: "BVR", bvr: "BVR", ccre: "CCR", ccr: "CCR",
};
export function siteDisplayName(site: string | null | undefined): string {
  if (!site) return "";
  return SITE_DISPLAY[site.toLowerCase()] ?? site.toUpperCase();
}

/** Depth of what a chart actually draws: every trace for a full-profile chart
 *  ("1.6 / 5 / 9 m"), the single series' depth otherwise ("9 m"), or "" when the chart
 *  resolved no depth. Built from the series, never from the profile dropdown, whose depth
 *  is a cosmetic placeholder ("epilimnion" for every rule except profile_zone). */
export function chartDepthLabel(
  chart: { depthM?: number | null; depthSeries?: { label: string }[] | null } | null | undefined,
): string {
  const labels = (chart?.depthSeries ?? []).map((s) => s.label).filter(Boolean);
  if (labels.length) {
    return labels.every((l) => / m$/.test(l))
      ? `${labels.map((l) => l.replace(/ m$/, "")).join(" / ")} m`
      : labels.join(" / ");
  }
  return chart?.depthM != null ? `${chart.depthM} m` : "";
}

const DAY_MS = 86_400_000;

/** UTC midnight of the calendar day a record names. Sensor rows carry
 *  "YYYY-MM-DD 00:00:00" (no zone, so Date parses it as local midnight); local midnights
 *  either side of a spring-forward night are an hour short of N days apart, which would let
 *  an extra day through the window. The day named in the string is what the window counts. */
function calendarDay(t: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(t).getTime();
}

/** The trailing N-day window, shared by fetchSensorSeries and the chart's render-time
 *  trim. A day is inside when it is strictly after latest − N days, so the window holds
 *  N calendar days, the latest included, as the persistence check, the reproduce snippet
 *  and the answer text do. Both stamps are UTC midnights. */
export function inTrailingWindow(dayMs: number, latestDayMs: number, windowDays: number): boolean {
  return dayMs > latestDayMs - windowDays * DAY_MS;
}

/** Render-time trim of an already-fetched series (points stamped at UTC midnight) to the
 *  N-day window, counted from the series' own latest day, as fetchSensorSeries counts it
 *  (one call per depth, so each full-profile trace has its own latest day). Saved
 *  conversations store the series exactly as fetched and may hold N+1 days; trimming at
 *  draw time makes them match the reproduce snippet, which is rebuilt from the stored
 *  window. Same fallback as the fetch: when fewer than two points would remain, the
 *  series is returned untouched. */
export function trimToTrailingWindow<P extends { t: number }>(
  pts: P[],
  windowDays: number | null | undefined,
): P[] {
  if (!windowDays || windowDays <= 0 || pts.length === 0) return pts;
  const latest = Math.max(...pts.map((p) => p.t));
  if (!Number.isFinite(latest)) return pts;
  const kept = pts.filter((p) => inTrailingWindow(p.t, latest, windowDays));
  return kept.length >= 2 ? kept : pts;
}

/** Date-axis ticks on an even calendar step: counted back from the latest day (always
 *  labelled) every ceil(span / (wanted − 1)) days, rather than sampling data-day indices,
 *  which gives uneven gaps. The inputs are UTC-midnight day stamps, so every tick is an
 *  exact UTC midnight and each label sits on the day it names. */
export function calendarTicks(tMin: number, tMax: number, wanted: number): number[] {
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) return [];
  if (tMax <= tMin || wanted <= 1) return [tMax];
  const spanDays = Math.round((tMax - tMin) / DAY_MS);
  const step = Math.max(1, Math.ceil(spanDays / (wanted - 1))) * DAY_MS;
  const ticks: number[] = [];
  for (let t = tMax; t >= tMin; t -= step) ticks.unshift(t);
  return ticks;
}

export type SensorResult = { points: SeriesPoint[]; depthM: number | null };

/** Sensor depth bucket - matches the pipeline's bucketing exactly:
 *  <2 m surface · 2–6 m mid · ≥6 m deep. */
function depthBucketOf(depthM: number | null): "surface" | "mid" | "deep" | "unknown" {
  if (depthM == null) return "unknown";
  if (depthM < 2) return "surface";
  if (depthM < 6) return "mid";
  return "deep";
}

/** Map a planner depth zone to the sensor depth bucket. */
function targetBucket(depthZone: string | undefined | null): "surface" | "mid" | "deep" | null {
  const d = (depthZone || "").toLowerCase();
  if (d.includes("hypolimnion")) return "deep";
  if (d.includes("metalimnion")) return "mid";
  if (d.includes("epilimnion") || d.includes("surface")) return "surface";
  return null;
}

/** Recent VERA observations for (site, variable), chronological, narrowed to the
 *  last `windowDays` and to a single depth matching the profile's zone. DO/temp
 *  are strongly stratified, so depths are never mixed or averaged together
 *  (that would mask hypolimnetic hypoxia). Returns the chosen depth too. */
export async function fetchSensorSeries(
  site: string,
  variable: string,
  windowDays = 14,
  depthZone?: string | null,
): Promise<SensorResult | null> {
  try {
    const res = await fetch(
      `/api/sensors?site=${encodeURIComponent(site)}&variable=${encodeURIComponent(variable)}&limit=50`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      records?: Array<{ datetime?: string; observation?: number | null; depthM?: number | null }>;
    };
    const recs = (data.records ?? [])
      .filter((r) => r && typeof r.observation === "number" && !!r.datetime)
      .map((r) => ({ t: r.datetime as string, v: r.observation as number, depthM: typeof r.depthM === "number" ? r.depthM : null }))
      .sort((a, b) => a.t.localeCompare(b.t));
    if (!recs.length) return null;

    // Narrow to the last `windowDays` of available data (relative to latest): N calendar
    // days, not N+1 (see inTrailingWindow).
    let inWindow = recs;
    const latest = calendarDay(recs[recs.length - 1].t);
    if (Number.isFinite(latest)) {
      const w = recs.filter((r) => {
        const tm = calendarDay(r.t);
        return !Number.isFinite(tm) || inTrailingWindow(tm, latest, windowDays);
      });
      if (w.length >= 2) inWindow = w;
    }

    // Depth-correct selection: chart a single depth matching the question's zone.
    const bucket = targetBucket(depthZone);
    let candidates = inWindow;
    if (bucket) {
      const allBucket = recs.filter((r) => depthBucketOf(r.depthM) === bucket && r.depthM != null);
      if (allBucket.length === 0) return null; // no observation at the requested depth: show none
      const windowBucket = inWindow.filter((r) => depthBucketOf(r.depthM) === bucket && r.depthM != null);
      candidates = windowBucket.length >= 2 ? windowBucket : allBucket; // widen if the window is sparse at depth
    }

    // Collapse to one depth: the one closest to the zone's canonical depth, else the
    // one with the most readings.
    const byDepth = new Map<number, SeriesPoint[]>();
    for (const r of candidates) {
      if (r.depthM == null) continue;
      const key = Math.round(r.depthM * 10) / 10;
      const arr = byDepth.get(key) ?? [];
      arr.push({ t: r.t, v: r.v });
      byDepth.set(key, arr);
    }
    if (byDepth.size === 0) {
      const pts = candidates.map((r) => ({ t: r.t, v: r.v }));
      return pts.length ? { points: pts, depthM: null } : null;
    }
    const canonical = depthZone ? ZONE_DEPTH[site]?.[depthZone.toLowerCase()] : undefined;
    let bestKey: number | null = null;
    if (canonical != null) {
      // Pin to the depth closest to the canonical zone depth (matches the answer).
      let bestDist = Number.POSITIVE_INFINITY;
      for (const k of byDepth.keys()) {
        const d = Math.abs(k - canonical);
        if (d < bestDist) { bestDist = d; bestKey = k; }
      }
    } else {
      // Fallback: most readings (tiebreak deepest for a deep zone, shallowest for surface).
      let bestCount = -1;
      for (const [k, arr] of byDepth) {
        const tie = arr.length === bestCount && bestKey != null && (bucket === "deep" ? k > bestKey : k < bestKey);
        if (arr.length > bestCount || tie) { bestKey = k; bestCount = arr.length; }
      }
    }
    const pts = (bestKey != null ? byDepth.get(bestKey)! : []).slice().sort((a, b) => a.t.localeCompare(b.t));
    return pts.length ? { points: pts, depthM: bestKey } : null;
  } catch {
    return null;
  }
}

/** FLARE forecast (ensemble mean + 2.5–97.5% band) for (site, variable). */
export type ForecastResult = { points: ForecastPoint[]; depthM: number | null };

export async function fetchForecastSeries(
  site: string,
  variable: string,
  horizon = 7,
  zone?: string | null,
): Promise<ForecastResult | null> {
  try {
    const zoneQ = zone ? `&zone=${encodeURIComponent(zone)}` : "";
    const res = await fetch(
      `/api/forecast?site=${encodeURIComponent(site)}&variable=${encodeURIComponent(variable)}&horizon=${horizon}${zoneQ}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ensembles?: Array<{ targetDate?: string; ensembleMean?: number; lowerBound?: number; upperBound?: number; q10?: number; q90?: number }>;
      depths?: number[];
    };
    const pts = (data.ensembles ?? [])
      .filter((e) => e && typeof e.ensembleMean === "number" && !!e.targetDate)
      .map((e) => ({
        t: e.targetDate as string,
        mean: e.ensembleMean as number,
        lower: typeof e.lowerBound === "number" ? e.lowerBound : (e.ensembleMean as number),
        upper: typeof e.upperBound === "number" ? e.upperBound : (e.ensembleMean as number),
        p10: typeof e.q10 === "number" ? e.q10 : undefined,
        p90: typeof e.q90 === "number" ? e.q90 : undefined,
      }))
      .sort((a, b) => a.t.localeCompare(b.t));
    const depthM = Array.isArray(data.depths) && typeof data.depths[0] === "number" ? data.depths[0] : null;
    return pts.length ? { points: pts, depthM } : null;
  } catch {
    return null;
  }
}

/** Day-of-year climatological normal for (site, variable) at the chart's depth
 *  zone - the seasonal reference the current forecast is read against. Pulled from
 *  /api/sensors `matchedBaselines` (computeBaselineStats: ~13 yr, day-of-year ±14-day
 *  window). Fail-soft: returns null if no matching baseline, so the panel simply
 *  omits the band. It is climatology (historical normal for this time of year), not
 *  a prediction. */
export type ClimatologyBand = { mean: number; min: number; max: number };

export async function fetchClimatology(
  site: string,
  variable: string,
  depthZone?: string | null,
): Promise<ClimatologyBand | null> {
  try {
    const res = await fetch(
      `/api/sensors?site=${encodeURIComponent(site)}&variable=${encodeURIComponent(variable)}&limit=50`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      matchedBaselines?: Array<{ recordDepthM?: number | null; mean?: number; min?: number; max?: number }>;
    };
    const mb = (data.matchedBaselines ?? []).filter((b) => b && typeof b.mean === "number");
    if (!mb.length) return null;
    // Match the baseline to the charted depth zone; else fall back to the most recent.
    const bucket = targetBucket(depthZone);
    const pick = bucket
      ? mb.find((b) => b.recordDepthM != null && depthBucketOf(b.recordDepthM) === bucket)
      : null;
    const b = pick ?? mb[0];
    if (!b || typeof b.mean !== "number") return null;
    return {
      mean: b.mean,
      min: typeof b.min === "number" ? b.min : b.mean,
      max: typeof b.max === "number" ? b.max : b.mean,
    };
  } catch {
    return null;
  }
}

/** Ensemble member trajectories for the chart's optional "Show ensemble members" view.
 *  Display only; fetched on demand when the user asks for it. */
export type MemberSeries = { referenceDate: string; depthM: number; dates: string[]; members: (number | null)[][] };

export async function fetchForecastMembers(
  site: string,
  variable: string,
  depthM: number | null,
  horizon = 7,
): Promise<MemberSeries | null> {
  try {
    const depthQ = depthM != null && Number.isFinite(depthM) ? `&depth=${depthM}` : "";
    const res = await fetch(
      `/api/forecast/members?site=${encodeURIComponent(site)}&variable=${encodeURIComponent(variable)}&horizon=${horizon}${depthQ}`,
      { signal: AbortSignal.timeout(60000) },   // a stalled FLARE download gives up after 60 s ("not available")
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<MemberSeries>;
    if (!Array.isArray(data.dates) || !Array.isArray(data.members) || !data.members.length) return null;
    return { referenceDate: String(data.referenceDate ?? ""), depthM: Number(data.depthM), dates: data.dates, members: data.members };
  } catch {
    return null;
  }
}
