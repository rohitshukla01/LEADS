// Reproduce-code generator. Given the data operations a LEADS answer performed (from
// the same plan that drives the chart), emit a self-contained, copy-to-clipboard code
// snippet in Python or R that pulls the same public data (VERA sensor + FLARE
// forecast on the public OSN bucket) and recomputes the numbers on the user's own
// machine. Display-only: it never runs on the server, uses only public URLs, and
// carries no keys or internals.
//
// The primitives are fixed code; the Python and R versions produce identical numbers
// on the public data. Only the parameters vary, and they come from the plan's
// validated allowlist (variable, site, depth, window, threshold), never raw query
// text, so nothing typed can be injected.
//
// FLARE's `DO_mgL_mean` is written in mmol/m^3, not mg/L, so the forecast helper
// multiplies every value by 32/1000, as normalizeFlareValue in lib/leads/flare-reader.ts
// does (a conditional "> 30" test would leave near-anoxic members unconverted). Without
// this the DO forecast is ~30x too high.

export type ReproduceLanguage = "python" | "r";

export interface ReproduceParams {
  /** VERA/FLARE site id, e.g. "fcre" | "bvre". */
  site: string;
  /** Canonical variable key, e.g. "DO_mgL_mean". */
  variable: string;
  /** Depth in metres, or null: the sensor series is then not filtered by depth and the
   *  forecast uses the shallowest FLARE layer. */
  depthM: number | null;
  /** Trailing window (days) for the sensor series. */
  days: number;
  /** FLARE forecast horizon (days), matching the chart's clamped horizon. Default 7. */
  horizon?: number;
  /** Emit the seasonal-normal (climatology) operation. */
  climatology: boolean;
  /** Emit the FLARE forecast operation (only when the plan showed a forecast). */
  forecast: boolean;
  /** Emit the threshold-margin operation, with the guardrail value/direction. */
  threshold: { value: number; direction: "below" | "above" } | null;
}

const PY_HEADER = `# This LEADS answer's data on your machine — public VERA + FLARE data only.
# No API keys, no LEADS internals. Requires: pip install pandas pyarrow requests
import io, datetime as dt, requests, pandas as pd, pyarrow.parquet as pq

VERA_URL = "https://amnh1.osn.mghpcc.org/bio230121-bucket01/vera4cast/targets/project_id=vera4cast/duration=P1D/daily-insitu-targets.csv.gz"
FLARE_BASE = "https://amnh1.osn.mghpcc.org/bio230121-bucket01/flare/forecasts/parquet"
FLARE_MODEL = "glm_aed_flare_v3"

_cache = {}
def _vera():
    if "df" not in _cache:
        _cache["df"] = pd.read_csv(VERA_URL, compression="gzip", parse_dates=["datetime"])
    return _cache["df"]

def fetch_sensor_series(site, variable, depth, days):
    """Recent daily VERA observations for (site, variable) at a depth, last \`days\`."""
    df = _vera()
    m = (df.site_id == site) & (df.variable == variable) & df.observation.notna()
    if depth is not None:
        m &= (df.depth_m - depth).abs() <= 0.1
    s = df[m].sort_values("datetime")
    s = s[s.datetime > s.datetime.max() - pd.Timedelta(days=days)]  # the last \`days\` days, latest day included
    return s[["datetime", "depth_m", "observation"]].reset_index(drop=True)

def compute_climatology(site, variable, depth, day_of_year, window=14):
    """Day-of-year normal (+/- window days, all years) for (site, variable, depth)."""
    df = _vera()
    m = (df.site_id == site) & (df.variable == variable) & df.observation.notna()
    if depth is not None:
        m &= (df.depth_m - depth).abs() <= 0.1
    s = df[m].copy()
    d = (s.datetime.dt.dayofyear - day_of_year).abs()
    s = s[pd.concat([d, 366 - d], axis=1).min(axis=1) <= window]
    if s.empty:
        return None
    o = s.observation
    return {"mean": round(float(o.mean()), 2), "min": round(float(o.min()), 2),
            "max": round(float(o.max()), 2), "n": int(o.size)}

def _flare_url(site, ref):
    for fn in ("part-0.parquet", "0.parquet", "data.parquet"):
        u = f"{FLARE_BASE}/site_id={site}/model_id={FLARE_MODEL}/reference_date={ref}/{fn}"
        if requests.head(u, timeout=15).status_code == 200:
            return u
    return None

def fetch_forecast(site, variable, reference_date=None, horizon=7, depth=None):
    """FLARE 221-member ensemble -> per-day mean + 10/90 band.
    NOTE: FLARE DO_mgL_mean is mmol/m^3 -> multiply every value by 32/1000."""
    if reference_date is None:
        for back in range(1, 22):
            ref = (dt.date.today() - dt.timedelta(days=back)).isoformat()
            url = _flare_url(site, ref)
            if url:
                reference_date = ref
                break
    else:
        url = _flare_url(site, reference_date)
    if not url:
        return None
    df = pq.read_table(io.BytesIO(requests.get(url, timeout=60).content)).to_pandas()
    df = df[(df.variable == variable) & (df.forecast == 1)].copy()
    df = df[(df.depth - depth).abs() <= 0.1] if depth is not None else df[df.depth == df.depth.min()]
    if df.empty:
        return None
    if variable == "DO_mgL_mean":
        df["prediction"] *= 32 / 1000
    df["date"] = pd.to_datetime(df.datetime, utc=True).dt.tz_localize(None).dt.normalize()
    ref = pd.to_datetime(reference_date).normalize()
    mem = df.groupby(["date", "parameter"]).prediction.mean().reset_index()
    out = mem.groupby("date").prediction.agg(
        mean="mean", p10=lambda x: x.quantile(0.10), p90=lambda x: x.quantile(0.90)).reset_index()
    out["horizon"] = (out.date - ref).dt.days
    out = out[(out.horizon >= 1) & (out.horizon <= horizon)].sort_values("horizon")
    out[["mean", "p10", "p90"]] = out[["mean", "p10", "p90"]].round(2)
    return reference_date, out.reset_index(drop=True)

def threshold_margin(values, threshold, direction="below"):
    """Latest value vs threshold. 'below' = breach when value < threshold."""
    v = list(values)
    if not v:
        return None
    latest = v[-1]
    margin = latest - threshold if direction == "below" else threshold - latest
    breached = sum((x < threshold) if direction == "below" else (x > threshold) for x in v)
    return {"latest": round(latest, 2), "margin": round(margin, 2),
            "breaches": margin < 0, "breached_days": int(breached)}
`;

const R_HEADER = `# This LEADS answer's data on your machine — public VERA + FLARE data only.
# No API keys, no LEADS internals. Requires: install.packages(c("data.table", "arrow"))
suppressPackageStartupMessages({library(data.table); library(arrow)})

VERA_URL <- "https://amnh1.osn.mghpcc.org/bio230121-bucket01/vera4cast/targets/project_id=vera4cast/duration=P1D/daily-insitu-targets.csv.gz"
FLARE_BASE <- "https://amnh1.osn.mghpcc.org/bio230121-bucket01/flare/forecasts/parquet"
FLARE_MODEL <- "glm_aed_flare_v3"

.vera <- NULL
vera_data <- function() {
  if (is.null(.vera)) {
    tmp <- tempfile(fileext = ".csv.gz"); download.file(VERA_URL, tmp, quiet = TRUE, mode = "wb")
    d <- as.data.frame(fread(tmp)); d$datetime <- as.Date(d$datetime); .vera <<- d
  }
  .vera
}

fetch_sensor_series <- function(site, variable, depth, days) {
  d <- vera_data()
  d <- d[d$site_id == site & d$variable == variable & !is.na(d$observation), ]
  if (!is.null(depth)) d <- d[abs(d$depth_m - depth) <= 0.1, ]
  d <- d[order(d$datetime), ]
  d <- d[d$datetime > max(d$datetime) - days, ]  # the last \`days\` days, latest day included
  data.frame(datetime = d$datetime, depth_m = d$depth_m, observation = d$observation)
}

compute_climatology <- function(site, variable, depth, day_of_year, window = 14) {
  d <- vera_data()
  d <- d[d$site_id == site & d$variable == variable & !is.na(d$observation), ]
  if (!is.null(depth)) d <- d[abs(d$depth_m - depth) <= 0.1, ]
  doy <- as.integer(format(d$datetime, "%j"))
  dist <- abs(doy - day_of_year); dist <- pmin(dist, 366 - dist)
  o <- d$observation[dist <= window]
  if (length(o) == 0) return(NULL)
  list(mean = round(mean(o), 2), min = round(min(o), 2), max = round(max(o), 2), n = length(o))
}

fetch_forecast <- function(site, variable, reference_date = NULL, horizon = 7, depth = NULL) {
  if (is.null(reference_date)) {
    for (back in 1:21) {
      ref <- as.character(Sys.Date() - back)
      if (!is.null(.flare_read(site, ref))) { reference_date <- ref; break }
    }
  }
  tbl <- .flare_read(site, reference_date)
  if (is.null(tbl)) return(NULL)
  df <- as.data.frame(tbl)
  df <- df[df$variable == variable & df$forecast == 1, ]
  if (!is.null(depth)) df <- df[abs(df$depth - depth) <= 0.1, ] else df <- df[df$depth == min(df$depth), ]
  if (nrow(df) == 0) return(NULL)
  if (variable == "DO_mgL_mean") df$prediction <- df$prediction * 32 / 1000
  df$date <- as.Date(df$datetime, tz = "UTC")
  dt <- as.data.table(df)
  mem <- dt[, .(p = mean(prediction)), by = .(date, parameter)]
  agg <- as.data.frame(mem[, .(mean = round(mean(p), 2),
                               p10 = round(quantile(p, .10, type = 7), 2),
                               p90 = round(quantile(p, .90, type = 7), 2)), by = date])
  agg$horizon <- as.integer(agg$date - as.Date(reference_date))
  agg <- agg[agg$horizon >= 1 & agg$horizon <= horizon, ]
  list(reference_date = reference_date, forecast = agg[order(agg$horizon), ])
}

.flare_read <- function(site, ref) {
  for (fn in c("part-0.parquet", "0.parquet", "data.parquet")) {
    u <- sprintf("%s/site_id=%s/model_id=%s/reference_date=%s/%s", FLARE_BASE, site, FLARE_MODEL, ref, fn)
    tmp <- tempfile(fileext = ".parquet")
    tbl <- tryCatch({ suppressWarnings(download.file(u, tmp, quiet = TRUE, mode = "wb")); read_parquet(tmp) },
                    error = function(e) NULL)
    if (!is.null(tbl)) return(tbl)
  }
  NULL
}

threshold_margin <- function(values, threshold, direction = "below") {
  if (length(values) == 0) return(NULL)
  latest <- tail(values, 1)
  margin <- if (direction == "below") latest - threshold else threshold - latest
  breached <- sum(if (direction == "below") values < threshold else values > threshold)
  list(latest = round(latest, 2), margin = round(margin, 2),
       breaches = margin < 0, breached_days = as.integer(breached))
}
`;

/** JS number/null -> a Python literal ("None") or R literal ("NULL"). */
function litDepth(depthM: number | null, lang: ReproduceLanguage): string {
  if (depthM == null) return lang === "python" ? "None" : "NULL";
  return String(depthM);
}

/** Build the "filled from the plan" call section - only the operations the plan ran. */
function pythonCalls(p: ReproduceParams): string {
  const depth = litDepth(p.depthM, "python");
  const lines: string[] = [
    "# ── filled from this answer's plan — edit any value and re-run ──",
    `SITE, VARIABLE, DEPTH, DAYS = ${JSON.stringify(p.site)}, ${JSON.stringify(p.variable)}, ${depth}, ${p.days}`,
    "",
    "obs = fetch_sensor_series(SITE, VARIABLE, DEPTH, DAYS)",
    "print(obs.tail().to_string(index=False))",
  ];
  if (p.climatology) {
    // Guard the empty-series case (matches the R variant's fail-soft): obs can be empty
    // if the sensor channel was requested but returned no recent rows.
    lines.push('if len(obs):\n    print("seasonal normal:", compute_climatology(SITE, VARIABLE, DEPTH, int(obs.datetime.iloc[-1].dayofyear)))');
  }
  if (p.threshold) {
    lines.push(`print("margin:", threshold_margin(obs.observation.tolist(), ${p.threshold.value}, ${JSON.stringify(p.threshold.direction)}))`);
  }
  if (p.forecast) {
    lines.push(
      `res = fetch_forecast(SITE, VARIABLE, horizon=${p.horizon ?? 7}, depth=DEPTH)`,
      'if res:',
      '    ref, fc = res',
      '    print("FLARE forecast, reference", ref)',
      "    print(fc.to_string(index=False))",
    );
  }
  return lines.join("\n");
}

function rCalls(p: ReproduceParams): string {
  const depth = litDepth(p.depthM, "r");
  const lines: string[] = [
    "# ── filled from this answer's plan — edit any value and re-run ──",
    `SITE <- ${JSON.stringify(p.site)}; VARIABLE <- ${JSON.stringify(p.variable)}; DEPTH <- ${depth}; DAYS <- ${p.days}`,
    "",
    "obs <- fetch_sensor_series(SITE, VARIABLE, DEPTH, DAYS)",
    "print(tail(obs), row.names = FALSE)",
  ];
  if (p.climatology) {
    lines.push('cat("seasonal normal:", unlist(compute_climatology(SITE, VARIABLE, DEPTH, as.integer(format(tail(obs$datetime, 1), "%j")))), "\\n")');
  }
  if (p.threshold) {
    lines.push(`cat("margin:", unlist(threshold_margin(obs$observation, ${p.threshold.value}, ${JSON.stringify(p.threshold.direction)})), "\\n")`);
  }
  if (p.forecast) {
    lines.push(
      `res <- fetch_forecast(SITE, VARIABLE, horizon = ${p.horizon ?? 7}, depth = DEPTH)`,
      "if (!is.null(res)) {",
      '  cat("FLARE forecast, reference", res$reference_date, "\\n")',
      "  print(res$forecast, row.names = FALSE)",
      "}",
    );
  }
  return lines.join("\n");
}

/**
 * Emit the full reproduce snippet (fixed tested primitives + the plan-filled call
 * section) in the requested language. Pure + deterministic.
 */
export function buildReproduceSnippet(p: ReproduceParams, lang: ReproduceLanguage): string {
  const header = lang === "python" ? PY_HEADER : R_HEADER;
  const calls = lang === "python" ? pythonCalls(p) : rCalls(p);
  return `${header}\n${calls}\n`;
}
