export const LEADS_PUBLIC_VERA_URL =
  process.env.LEADS_PUBLIC_VERA_URL ??
  "https://amnh1.osn.mghpcc.org/bio230121-bucket01/vera4cast/targets/project_id=vera4cast/duration=P1D/daily-insitu-targets.csv.gz";

/**
 * Maximum attempts per question: the first attempt plus up to two corrective retries.
 * A retry follows a failed evidence check, as in CRAG (Yan et al., 2024), or a failed
 * claim check, as in MEGA-RAG (Xu et al., 2025); see also Self-RAG (Asai et al., 2024).
 * Set to 3 following Hu et al. (2025).
 */
export const LEADS_DEFAULT_MAX_ITERATIONS = 3;
export const LEADS_FAITHFULNESS_THRESHOLD = 80;
export const LEADS_PUBLIC_SENSOR_TTL_MS = 30 * 60 * 1000;

export const SITE_ALIASES: Record<string, string[]> = {
  fcre: ["fcre", "falling creek", "falling creek reservoir", "fcr", "fcrmet", "fcrcatwalk"],
  bvre: ["bvre", "beaverdam", "beaverdam reservoir", "bvr", "bvrplatform"],
  ccre: ["ccre", "carvins cove", "carvins cove reservoir", "ccr"],
};

export const VARIABLE_ALIASES: Record<string, string[]> = {
  Chla_ugL_mean: ["chla", "chlorophyll", "chlorophyll-a", "bloom", "algal bloom", "chl-a"],
  Temp_C_mean: ["temp", "temperature", "surface temp", "thermal", "stratification", "watertemp"],
  // "hypoxic"/"anoxic": the adjective forms, so questions using them resolve to DO.
  DO_mgL_mean: ["do", "dissolved oxygen", "oxygen", "hypoxia", "anoxia", "hypoxic", "anoxic", "d.o"],
  // Native VERA optical-sensor DO % saturation (all depths, daily). Sensor side
  // reads this directly; forecast side derives %sat from FLARE DO+Temp via
  // García–Benson @1 atm (forecast.ts). Distinct aliases from DO_mgL_mean so a
  // "% saturation" query resolves to saturation, not concentration.
  DOsat_percent_mean: ["do saturation", "do sat", "dosat", "dissolved oxygen saturation", "oxygen saturation", "percent saturation", "% saturation", "%saturation", "do %sat", "do percent sat"],
  // FluoroProbe grab-sample chlorophyll. Distinct, non-colliding aliases vs
  // Chla_ugL_mean (sonde) so the persona split stays clean - manager uses the
  // sonde, researcher the FluoroProbe profile. Variable selection is
  // driven primarily by the persona guardrail constraint (rules_by_persona), not
  // query text, so these aliases are deliberately specific.
  TotalConc_ugL_sample: ["fluoroprobe", "fluoroprobe chlorophyll", "total chlorophyll concentration", "totalconc", "surface fluoroprobe"],
  TotalConcCM_ugL_sample: ["fluoroprobe profile", "chlorophyll profile", "total chlorophyll profile", "totalconccm", "profile chlorophyll"],
  // Soluble Fe/Mn (SFe/SMn) are not sensor variables: the water_extraction
  // guardrail is physics-only (DO), and there is no live metals sensor stream.
  // "iron"/"manganese" are listed in UNSUPPORTED_VARIABLE_TERMS below so a metals
  // query is answered from literature with an explicit "not in the sensor stream"
  // note (same treatment as phosphorus/nitrogen).
  fDOM_QSU_mean: ["fdom", "organic matter", "fluorescence", "dissolved organic"],
  Turbidity_FNU_mean: ["turbidity", "sediment", "suspended solids"],
  SpCond_uScm_mean: ["conductivity", "specific conductivity", "spcond", "ions"],
  phyco_ugL_mean: ["phycocyanin", "cyanobacteria", "blue green algae", "bga", "bgapc"],
  Secchi_m_sample: ["secchi", "secchi depth", "water clarity", "light penetration", "transparency", "light attenuation"],
  ThermoclineDepth_m_mean: ["thermocline", "thermocline depth", "mixing depth", "pycnocline", "stratification depth", "mixed layer depth"],
  SchmidtStability_Jm2_mean: ["schmidt stability", "schmidt", "thermal stability", "lake stability", "stratification stability", "mixing energy"],
  Bloom_binary_mean: ["bloom presence", "bloom detection", "bloom binary", "bloom occurrence"],
  Bluegreens_ugL_sample: ["bluegreens", "blue-greens", "cyanobacteria concentration", "phyco sample"],
};

/**
 * Variables that are commonly asked about but are not measured in the
 * VERA4CAST / LTREB in-situ sensor stream.  When a query contains one of
 * these terms but resolves zero variableHints, the synthesis prompt is
 * annotated so the LLM explicitly tells the user the variable isn't available.
 */
export const UNSUPPORTED_VARIABLE_TERMS: string[] = [
  "ph", "acidity", "alkalinity",
  "nitrogen", "nitrate", "nitrite", "ammonia", "ammonium", "total nitrogen", "tn",
  "phosphorus", "total phosphorus", "tp", "soluble reactive phosphorus", "srp",
  // Soluble Fe/Mn: no live metals sensor stream. "iron"/"manganese" stay on-topic
  // (router in-scope list + the literature corpus), so Fe/Mn management is still
  // answerable from literature; here they are flagged as not-in-the-sensor-stream.
  // Word-boundary matched (\biron\b) so "environment" is not a false hit (see
  // generator.ts).
  "iron", "manganese",
  "sulfate", "sulfur",
  "calcium", "magnesium", "sodium", "potassium", "hardness",
  "bacteria", "e. coli", "ecoli", "coliform", "pathogen",
  "tds", "total dissolved solids",
  "methane", "co2", "carbon dioxide", "greenhouse gas",
  "heavy metal", "lead", "arsenic", "mercury",
  "salinity", "salt",
  "pesticide", "herbicide", "atrazine", "glyphosate",
  "microplastic", "pfas",
  "biochemical oxygen demand", "bod", "chemical oxygen demand", "cod",
  "total organic carbon", "toc",
  "algal toxin", "microcystin", "cyanotoxin",
];

// Forecast configuration
//
// Forecast channel uses FLARE GLM-AED exclusively (see lib/leads/flare-reader.ts).
// LEADS_FORECAST_VARIABLES and LEADS_FORECAST_SITES are used for validation
// in route handlers; LEADS_FLARE_* constants drive the actual fetch.

// Mirrors LEADS_FLARE_VARIABLES exactly: the only variables LEADS fetches and
// forecasts (GLM-AED via FLARE). Bloom_binary_mean (not produced by glm_aed) and
// fDOM_QSU_mean (a sensor-only variable, flare:false) are excluded, so validation
// rejects requests that cannot be served.
export const LEADS_FORECAST_VARIABLES = [
  "Temp_C_mean",
  "DO_mgL_mean",
  "Chla_ugL_mean",
] as const;

export const LEADS_FORECAST_SITES = ["fcre", "bvre"] as const;

export const LEADS_FORECAST_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// FLARE single-parquet ensemble configuration
//
// The FLARE GLM-AED model publishes one raw-ensemble parquet per
// (site, model, reference_date). One fetch returns every variable and all
// 221 ensemble members for the probabilistic quantiles, instead of one
// VERA4cast bundled-summary request per model and variable.
//
// Path layout on OSN:
//   <base>/site_id=<site>/model_id=<model>/reference_date=<YYYY-MM-DD>/part-0.parquet

export const LEADS_FLARE_BASE_URL =
  process.env.LEADS_FLARE_BASE_URL ??
  "https://amnh1.osn.mghpcc.org/bio230121-bucket01/flare/forecasts/parquet";

/** Model identifier for the GLM-AED FLARE ensemble. */
export const LEADS_FLARE_MODEL_ID =
  process.env.LEADS_FLARE_MODEL_ID ?? "glm_aed_flare_v3";

/** Primary site served by the FLARE raw-ensemble files.
 *  Single-string export for code paths (e.g. `/api/forecast` default param)
 *  that fall back to a single site when no profile is supplied. */
export const LEADS_FLARE_SITE =
  process.env.LEADS_FLARE_SITE ?? "fcre";

/** Maximum number of days to look back when probing for the latest
 *  available FLARE reference date for a site. Default 21 covers BVRE's
 *  typical ~10-day lag and gives headroom for longer pauses in the upstream
 *  forecast pipeline. Override via env if needed. LEADS retrieves whatever is
 *  available; freshness is annotated in the evidence text, not refused. */
export const LEADS_FLARE_LOOKBACK_DAYS = (() => {
  const raw = process.env.LEADS_FLARE_LOOKBACK_DAYS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 21;
})();

// Snapshot freeze / deterministic replay (eval reproducibility)
//
// For reproducible scored runs the pipeline replays a fixed data snapshot instead
// of drifting with wall-clock time and newly published VERA/FLARE data. Both
// settings are opt-in and change nothing when unset (like LEADS_EVAL_SEED and
// LEADS_EVAL_TEMPERATURE in lib/openai-client.ts).
//
//   LEADS_AS_OF=2026-06-29                  pin "today" for recency + Layer-2 freshness
//   LEADS_FLARE_REFERENCE_DATE=2026-06-26   pin the FLARE forecast run

/** Pinned "as of" timestamp (ISO), or null = live wall-clock. */
export const LEADS_AS_OF = (() => {
  const raw = process.env.LEADS_AS_OF?.trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
})();

/** Current timestamp for data-semantic ("as of today") reads - recency
 *  annotations and Layer-2/forecast freshness. Honors the LEADS_AS_OF snapshot
 *  pin, else real wall-clock. Do not use for cache-TTL timing (must stay live). */
export function evalNowIso(): string {
  return LEADS_AS_OF ?? new Date().toISOString();
}

/** Pinned FLARE reference_date (YYYY-MM-DD), or null = auto-discover latest. */
export const LEADS_FLARE_REFERENCE_DATE =
  process.env.LEADS_FLARE_REFERENCE_DATE?.trim() || null;

/**
 * FLARE variables to extract from the raw parquet.
 * These must match the `variable` column values written by GLM-AED.
 */
export const LEADS_FLARE_VARIABLES = [
  "Temp_C_mean",
  "DO_mgL_mean",
  "Chla_ugL_mean",
] as const;

export const LEADS_RISK_THRESHOLDS: Record<
  string,
  { threshold: number; direction: "below" | "above"; label: string; source: string }
> = {
  DO_mgL_mean: {
    threshold: 2.0,
    direction: "below",
    label: "hypoxia",
    source: "EPA water quality criteria; Wetzel 2001 Limnology",
  },
  Chla_ugL_mean: {
    threshold: 20.0,
    direction: "above",
    label: "bloom risk",
    source: "WHO recreational water guidelines; Chorus & Bartram 1999",
  },
  Temp_C_mean: {
    threshold: 25.0,
    direction: "above",
    label: "thermal stress",
    source: "Paerl & Huisman 2008; cyanobacteria growth optima",
  },
};

/**
 * How FLARE forecasts are represented in the evidence passed to synthesis.
 *
 *   "summary" - (a) prose summary stats (mean, range, spread) + optional
 *                 threshold-crossing probability. Default.
 *   "quantiles" - (b) per-horizon-day quantile band table (q02.5 / q10 / q90 /
 *                 q97.5) grouped per (variable, site) into one richer item.
 *   "json" - (c) machine-parseable JSON object containing the same
 *                 per-day distribution data as (b), one per (variable, site).
 *
 * Env-overridable so an ablation can switch between modes without code edits:
 * `LEADS_FORECAST_REPRESENTATION={summary|quantiles|json}`.
 */
export type ForecastRepresentation = "summary" | "quantiles" | "json";

export const LEADS_FORECAST_REPRESENTATION: ForecastRepresentation = (() => {
  const raw = (process.env.LEADS_FORECAST_REPRESENTATION ?? "summary").toLowerCase();
  if (raw === "quantiles" || raw === "json") return raw;
  return "summary";
})();
