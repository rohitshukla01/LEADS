/**
 * Per-variable-class freshness policy.
 *
 * Freshness is judged relative to each variable's intrinsic sampling cadence (its
 * `source_class`), not an absolute clock: a single 3/14-day clock suits daily sonde
 * data but would wrongly refuse grab-sample and lab data whose expected cadence is
 * weekly to seasonal.
 *
 * Layer 2 gates on freshness only for operational decisions. A few-days-late sonde
 * reading lands in AGED and proceeds with a caveat, not a refusal; a refusal is added
 * only where omitting one is operationally unsafe (a months-old lab grab cannot ground
 * a live "withdraw now" recommendation). The framing is fitness-for-decision, not
 * data-quality engineering: LEADS never repairs, imputes or QCs the data; it declines
 * to ground an action on observations that cannot represent current conditions.
 *
 * Gate posture (operational decisions):
 *   CURRENT:    proceed
 *   AGED:       proceed with a per-variable age caveat
 *   STALE:      refuse with a handoff (in-season gap or upstream outage)
 *   OFF_SEASON: proceed with a prominent age caveat (the expected winter sampling
 *               pause for lab chemistry is not a fault, so it is not refused)
 * Informational mode (decision === "none") never refuses; everything is
 * age-labelled and usable as context.
 *
 * The windows and season below are defaults, env-overridable so they can be tuned
 * without code edits.
 */

/** Sampling-cadence class. Mirrors the guardrail constraint `source_class`
 *  (continuous | fluoroprobe | lab | forecast); "derived" inherits its inputs'
 *  class and is resolved by the caller (forecast-derived: forecast; sensor-
 *  derived: continuous). */
export type CadenceClass = "continuous" | "fluoroprobe" | "lab" | "forecast";

export type FreshnessStatus = "CURRENT" | "AGED" | "STALE" | "OFF_SEASON";

export interface FreshnessWindow {
  /** At most this many days old: CURRENT. */
  currentMaxDays: number;
  /** At most this many days old (and older than currentMaxDays): AGED; older: STALE or OFF_SEASON. */
  agedMaxDays: number;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Freshness windows (days, current / aged); env-overridable.
 *   A continuous  3 / 14 - daily sonde
 *   B fluoroprobe 14 / 35 - ~weekly–biweekly grab; ~2 cycles current, ~5 wk usable
 *   C lab         14 / 45 - weekly-in-season; longer aged tail + off-season logic
 *   D forecast    2 / 7 - daily FLARE issue (reference_date age, not horizon)
 */
export const FRESHNESS_WINDOWS: Record<CadenceClass, FreshnessWindow> = {
  continuous: {
    currentMaxDays: envNum("LEADS_FRESH_CONTINUOUS_CURRENT", 3),
    agedMaxDays: envNum("LEADS_FRESH_CONTINUOUS_AGED", 14),
  },
  fluoroprobe: {
    currentMaxDays: envNum("LEADS_FRESH_FLUOROPROBE_CURRENT", 14),
    agedMaxDays: envNum("LEADS_FRESH_FLUOROPROBE_AGED", 35),
  },
  lab: {
    currentMaxDays: envNum("LEADS_FRESH_LAB_CURRENT", 14),
    agedMaxDays: envNum("LEADS_FRESH_LAB_AGED", 45),
  },
  forecast: {
    currentMaxDays: envNum("LEADS_FRESH_FORECAST_CURRENT", 2),
    agedMaxDays: envNum("LEADS_FRESH_FORECAST_AGED", 7),
  },
};

/** Sampling season for lab chemistry (class C). A query in the off-season
 *  window whose freshest sample exceeds the STALE threshold is OFF_SEASON
 *  (expected winter pause), not STALE (genuine gap). Apr 1 – Nov 30 follows the
 *  FCR sampling record (weekly April to November, winter pause). Env-overridable. */
export const SAMPLING_SEASON = {
  start_mmdd: process.env.LEADS_SAMPLING_SEASON_START ?? "04-01",
  end_mmdd: process.env.LEADS_SAMPLING_SEASON_END ?? "11-30",
};

export interface FreshnessAssessment {
  status: FreshnessStatus;
  ageDays: number;
  cadenceClass: CadenceClass;
  /** Status reasoning (class + age + window). Callers compose the full,
   *  value-bearing sentence (e.g. "soluble Mn 0.18 mg/L, sampled …"). */
  message: string;
}

/** Map a guardrail constraint `source_class` to a freshness CadenceClass.
 *  `derived` resolves by side: forecast-derived to forecast, sensor-derived to
 *  continuous (the default here, since the only derived sensor value - DO %sat -
 *  comes from native continuous sonde data). */
export function cadenceClassFor(
  sourceClass: "continuous" | "fluoroprobe" | "lab" | "forecast" | "derived",
  side: "sensor" | "forecast" = "sensor",
): CadenceClass {
  if (sourceClass === "derived") return side === "forecast" ? "forecast" : "continuous";
  return sourceClass;
}

/** "MM-DD" lies within the inclusive [start, end] window (no year wrap for the
 *  Apr–Nov season; written generically in case the season is later retuned). */
function mmddInSeason(mmdd: string): boolean {
  const { start_mmdd, end_mmdd } = SAMPLING_SEASON;
  if (start_mmdd <= end_mmdd) return mmdd >= start_mmdd && mmdd <= end_mmdd;
  // Wrap-around season (e.g. Nov–Mar): in-season if outside the (end, start) gap.
  return mmdd >= start_mmdd || mmdd <= end_mmdd;
}

/** Parse a VERA/FLARE datetime to epoch ms. Handles "YYYY-MM-DD",
 *  "YYYY-MM-DD HH:MM:SS" (space-separated, the VERA daily-insitu format), and
 *  full ISO strings. Bare (timezone-less) timestamps are read as UTC so age is
 *  computed consistently against the ISO `asOf`. */
function parseObsMs(s: string): number {
  let v = s.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v += "T00:00:00"; // date only: midnight
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) v += "Z"; // no time zone: UTC
  return Date.parse(v);
}

/**
 * Classify the freshness of one observation against its cadence class.
 *
 * @param cadenceClass which freshness window applies
 * @param obsDateISO   the observation's date/datetime (ISO-ish; "YYYY-MM-DD …" ok)
 * @param queryDateISO the "now"/as-of date the query is asked against
 */
export function assessFreshness(
  cadenceClass: CadenceClass,
  obsDateISO: string,
  queryDateISO: string,
): FreshnessAssessment {
  const obsMs = parseObsMs(obsDateISO);
  const qMs = Date.parse(queryDateISO);
  const win = FRESHNESS_WINDOWS[cadenceClass];

  if (!Number.isFinite(obsMs) || !Number.isFinite(qMs)) {
    return {
      status: "STALE",
      ageDays: Number.NaN,
      cadenceClass,
      message: `Unparseable observation date "${obsDateISO}" — treated as not-current.`,
    };
  }

  // Age is a calendar-day difference, not elapsed time. The observation stamp is a
  // date (midnight) while the query stamp is the current instant, so differencing raw
  // milliseconds would leave a part-day remainder that Math.round pushes up by a day.
  // Flooring both stamps to their UTC day gives the calendar difference.
  const dayFloor = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;
  const ageDays = Math.max(0, Math.round((dayFloor(qMs) - dayFloor(obsMs)) / 86_400_000));

  if (ageDays <= win.currentMaxDays) {
    return {
      status: "CURRENT",
      ageDays,
      cadenceClass,
      message: `${cadenceClass} data current (${ageDays} d old, within the ${win.currentMaxDays} d cadence window).`,
    };
  }
  if (ageDays <= win.agedMaxDays) {
    return {
      status: "AGED",
      ageDays,
      cadenceClass,
      message: `${cadenceClass} data aged: ${ageDays} d old (cadence-usable up to ${win.agedMaxDays} d) — usable with an age caveat.`,
    };
  }

  // Beyond the aged window. For lab chemistry, distinguish the expected
  // off-season pause from a genuine in-season gap.
  if (cadenceClass === "lab") {
    const queryMmdd = new Date(qMs).toISOString().slice(5, 10);
    if (!mmddInSeason(queryMmdd)) {
      return {
        status: "OFF_SEASON",
        ageDays,
        cadenceClass,
        message:
          `Out of sampling season (${SAMPLING_SEASON.start_mmdd}–${SAMPLING_SEASON.end_mmdd}); this is the ` +
          `latest available value (${obsDateISO.slice(0, 10)}, ${ageDays} d ago) — the expected seasonal ` +
          `pause, not a sensor fault. Treat as provisional; it may change once in-season sampling resumes.`,
      };
    }
  }

  return {
    status: "STALE",
    ageDays,
    cadenceClass,
    message:
      `${cadenceClass} data stale: ${ageDays} d old, exceeds the ${win.agedMaxDays} d usable window — ` +
      `not current enough to ground an operational recommendation (likely in-season gap or upstream outage).`,
  };
}
