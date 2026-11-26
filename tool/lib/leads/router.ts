import { evalNowIso, SITE_ALIASES, VARIABLE_ALIASES } from "./config";
import { mentionsTerm, sitesMentioned, variablesMentioned } from "./alias-match";
import { inferHorizon } from "./horizon";
import { DEPTH_ZONE_MAPPING, getGuardrail, getPersonaRule, resolveDepthMeters, resolveScopeDepths, siteIdFor, type DecisionKey, type PersonaRule } from "./guardrails";
import type { LeadsAudience, LeadsChannel, LeadsChartSpec, LeadsDepthZone, LeadsObjective, LeadsOutOfScope, LeadsProfile, LeadsProfileAlignment, LeadsQueryMode, LeadsQueryPlan, LeadsReservoir, LeadsScope } from "./types";

function inferMode(query: string): LeadsQueryMode {
  if (
    /(structured evidence sheet|evidence sheet)/.test(query) ||
    (/a\.\s*sensor evidence/.test(query) &&
      /b\.\s*baseline comparison/.test(query) &&
      /c\.\s*literature claims/.test(query) &&
      /d\.\s*missing evidence/.test(query))
  ) {
    return "evidence";
  }
  if (/(what if|what-if|scenario|hypothetical|if we|suppose we)/.test(query)) return "scenario";
  if (/(threshold|cutoff|limit|risk level|how high|how low)/.test(query)) return "threshold";
  if (/(why|cause|mechanism|mechanistic|because|drive|driven by)/.test(query)) return "causal";
  // Management is checked before predictive: a query can mention "forecast" while
  // still being a decision/management question ("should managers be concerned…").
  if (/(what should|should (?:we|managers?|operators?)|management|intervention|operator|mitigation|action|concerned about|be concerned|managers? (?:be|should)|water quality concern)/.test(query)) return "management";
  if (/(forecast|predict|risk tomorrow|next week|outlook)/.test(query)) return "predictive";
  if (/(compare|difference|versus|vs\.?|across sites|between)/.test(query)) return "comparative";
  if (/(trend|over time|seasonal|historical|baseline|changed)/.test(query)) return "temporal";
  return "general";
}

function inferAudience(query: string): LeadsAudience {
  if (/(scientist|researcher|ecologist|limnologist)/.test(query)) return "scientist";
  if (/(manager|management|planner|policy|official)/.test(query)) return "manager";
  if (/(operator|operations|utility|drinking water|treatment)/.test(query)) return "operator";
  if (/(policy|regulator|governance|public official)/.test(query)) return "policy";
  return "general";
}

function inferObjective(query: string, mode: LeadsQueryMode): LeadsObjective {
  if (mode === "predictive" || mode === "scenario") return "forecast";
  if (mode === "management") return "recommend";
  if (mode === "comparative") return "compare";
  if (/(assess|evaluate|consistent with|concern|risk)/.test(query)) return "assess";
  return "explain";
}

function inferScope(query: string, sites: string[]): LeadsScope {
  if (sites.length > 0 || /(this reservoir|fcre|bvre|ccre|current conditions)/.test(query)) return "site-specific";
  if (/(similar|analogue|comparable|reservoir systems)/.test(query)) return "regional-analogue";
  return "general";
}

// Alias matching lives in alias-match.ts, shared with the forecast channel, the
// literature boost and the Layer-3 audit (whole-word short aliases; "do" only as
// the dissolved-oxygen abbreviation, never the verb).
function inferSites(query: string): string[] {
  return sitesMentioned(query);
}

function inferVariables(originalQuery: string): string[] {
  return variablesMentioned(originalQuery);
}

// Text-depth inference for informational sensor lookups
// ("chl-a at 5 m", "DO at the 9 m depth"). Operational decisions derive their
// depth from the persona rule's depth_scope; informational mode has no profile
// depth, so the only depth signal is the question text.
function inferDepthMeters(query: string): number[] {
  const out: number[] = [];
  // "5 m", "5m", "5 meters", "9-m", "depth of 9 m". Bounded 0–60 m (reservoir
  // depths); the unit token is required so "next 2 weeks"/"20 µg/L" don't match.
  const re = /(?:depth of\s*)?(\d{1,2}(?:\.\d)?)\s*(?:m\b|-m\b|met(?:er|re)s?\b)/gi;
  for (const m of query.matchAll(re)) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v >= 0 && v <= 60 && !out.includes(v)) out.push(v);
  }
  return out;
}

function inferTimeHints(query: string): string[] {
  const hints: string[] = [];
  if (/(today|current|now|latest|recent)/.test(query)) hints.push("current");
  if (/(yesterday|last day|24 hours)/.test(query)) hints.push("recent");
  if (/(seasonal|baseline|historical|climatology)/.test(query)) hints.push("baseline");
  if (/(forecast|next week|tomorrow)/.test(query)) hints.push("forecast");
  return hints;
}

function inferYearHints(query: string): number[] {
  const matches = query.match(/\b(20\d{2})\b/g);
  if (!matches) return [];
  const currentYear = new Date().getFullYear();
  return [...new Set(matches.map(Number))].filter((y) => y >= 2013 && y <= currentYear + 1);
}

const MONTH_MAP: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

// Month numbers of the northern-hemisphere meteorological seasons.
// "summer 2024" expands to monthHints=[6,7,8] so sensor retrieval
// filters to June–August instead of returning all 2024 records.
const SEASON_MAP: Record<string, number[]> = {
  spring:        [3, 4, 5],
  summer:        [6, 7, 8],
  fall:          [9, 10, 11],
  autumn:        [9, 10, 11],
  winter:        [12, 1, 2],
  "early spring":[3, 4],
  "late spring": [5],
  "early summer":[6, 7],
  "late summer": [8],
  "early fall":  [9, 10],
  "late fall":   [11],
  "early winter":[12, 1],
  "late winter": [2, 3],
};

function inferMonthHints(query: string): number[] {
  const lower = query.toLowerCase();
  const found: number[] = [];

  // Season names first (multi-word before single-word to avoid partial matches)
  const seasonKeys = Object.keys(SEASON_MAP).sort((a, b) => b.length - a.length);
  for (const name of seasonKeys) {
    if (new RegExp(`\\b${name.replace(" ", "\\s+")}\\b`).test(lower)) {
      for (const m of SEASON_MAP[name]) {
        if (!found.includes(m)) found.push(m);
      }
    }
  }

  // Named months (whole-word only to avoid "march" matching "marching")
  for (const [name, num] of Object.entries(MONTH_MAP)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      if (!found.includes(num)) found.push(num);
    }
  }

  // ISO date: 2025-05-26 / 2025/05/26 - extract the numeric month. The named-month
  // loop above only matches spelled-out months; without this an ISO query would leave
  // monthHints empty and sensor retrieval would sample across the whole year.
  for (const m of query.matchAll(/\b20\d{2}[-/](0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b/g)) {
    const mo = parseInt(m[1], 10);
    if (mo >= 1 && mo <= 12 && !found.includes(mo)) found.push(mo);
  }
  return found;
}

function inferDayHints(query: string): number[] {
  const found: number[] = [];

  // ISO date: 2025-05-26 or 2025/05/26. Groups: m[1]=month, m[2]=day.
  for (const m of query.matchAll(/\b20\d{2}[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g)) {
    const d = parseInt(m[2], 10);
    if (Number.isFinite(d) && !found.includes(d)) found.push(d);
  }

  // "May 5", "May 26", "5 May", "26 May"
  const monthNames = Object.keys(MONTH_MAP).join("|");
  const namedMonthDay = new RegExp(
    `(?:(?:${monthNames})\\s+(\\d{1,2})|(\\d{1,2})\\s+(?:${monthNames}))`,
    "gi"
  );
  for (const m of query.matchAll(namedMonthDay)) {
    const raw = m[1] ?? m[2];
    if (raw) {
      const d = parseInt(raw, 10);
      if (d >= 1 && d <= 31 && !found.includes(d)) found.push(d);
    }
  }

  // Ordinal: "the 5th", "the 26th", "on the 3rd"
  for (const m of query.matchAll(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi)) {
    const d = parseInt(m[1], 10);
    if (d >= 1 && d <= 31 && !found.includes(d)) found.push(d);
  }

  return found;
}

/**
 * Resolves relative date words ("yesterday", "today") to concrete
 * { year, month, day } objects so that yearHints / monthHints / dayHints
 * can be seeded without the user typing an explicit date.
 */
function resolveRelativeDates(query: string): { year: number; month: number; day: number }[] {
  const lower = query.toLowerCase();
  const resolved: { year: number; month: number; day: number }[] = [];

  const addDate = (d: Date) => {
    resolved.push({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
  };

  // new Date(evalNowIso()) honors the LEADS_AS_OF snapshot freeze: "today"/"yesterday"
  // resolve relative to the frozen date in the paper replay, or the real clock when live.
  if (/\byesterday\b/.test(lower)) {
    const d = new Date(evalNowIso());
    d.setDate(d.getDate() - 1);
    addDate(d);
  }
  if (/\btoday\b|\bright now\b|\bthis morning\b|\bthis evening\b/.test(lower)) {
    addDate(new Date(evalNowIso()));
  }
  if (/\bday before yesterday\b/.test(lower)) {
    const d = new Date(evalNowIso());
    d.setDate(d.getDate() - 2);
    addDate(d);
  }

  return resolved;
}

function inferChannels(query: string, mode: LeadsQueryMode): LeadsChannel[] {
  const channels = new Set<LeadsChannel>(["literature"]);

  if (/(today|current|latest|sensor|observation|reading|measured|vera|ltreb|site|depth|temperature|oxygen|chlorophyll|turbidity|conductivity|phycocyanin|fdom|secchi|clarity|transparency|stability|thermocline|bloom|bluegreen|stratification|mixing|schmidt|pycnocline)/.test(query)) {
    channels.add("sensor");
  }

  // Temporal / historical queries activate sensor because the sensor channel
  // embeds the full day-of-year climatological baseline alongside recent
  // point observations (Dietze et al. 2018; Thomas et al. 2020 FLARE).
  if (mode === "temporal" || mode === "predictive" || /(season|trend|baseline|historical)/.test(query)) {
    channels.add("sensor");
  }

  if (mode === "predictive" || mode === "scenario" || /(forecast|predict|risk|next week|tomorrow|outlook|probability|chance|likelihood)/.test(query)) {
    channels.add("forecast");
    channels.add("sensor"); // pair forecast with current conditions + climatological baseline
  }

  return Array.from(channels);
}

// Plot spec
// The chart the UI draws is decided by the planner, from the same query
// understanding the pipeline retrieves and reasons over. It reuses the
// already-derived channels/variableHints/siteHints/depth so the chart shows
// exactly the variable, site, and depth the agent analyzed. Display concerns
// (which variables are chartable) stay on the frontend via VARIABLE_META; this
// module only emits the agent's intent.

/** Rolling display window (days) parsed from the query, e.g. 7 for "last 7 days",
 *  30 for "this month". Bounded; default 14. */
function inferWindowDays(query: string): number {
  const m = query.match(/(\d+)\s*(day|week|month)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) {
      if (m[2] === "week") return Math.min(n * 7, 90);
      if (m[2] === "month") return Math.min(n * 30, 120);
      return Math.min(n, 120);
    }
  }
  if (/\bfortnight\b/.test(query)) return 14;
  if (/\bweek\b/.test(query)) return 7;
  if (/\bmonth\b/.test(query)) return 30;
  return 14;
}

// showForecast intent. The FLARE forecast layer is drawn only when the question
// is forward-looking. This decouples chart display from retrieval:
// an operational decision force-retrieves the forecast channel for Layer-2
// enforcement, but a purely retrospective question ("DO trend over the last 2
// weeks") should still show observations only - so the chart's tense matches the
// question and the same question renders the same chart regardless of profile.
const FORECAST_INTENT_RE =
  /\b(forecast|forecasts|forecasted|predict(?:ed|ion|ions)?|outlook|next\s+(?:week|day|days|few\s+days)|coming\s+(?:days|week)|this\s+week|tomorrow|upcoming|expected|projection|project(?:ed)?|probability|chance|likelihood|risk\s+of|going\s+to|will\b|days\s+ahead|7[-\s]?day|seven[-\s]?day)\b/;
// Explicitly retrospective intent: observations only (suppresses the forecast,
// and wins over a forward signal when both appear, e.g. "trend this week").
const RETROSPECTIVE_RE =
  /\b(trend|trends|history|historical|over\s+the\s+(?:last|past)|(?:last|past)\s+\d+\s+(?:day|days|week|weeks|month|months)|changed|has\s+been|have\s+been|so\s+far|to\s+date)\b/;
// Operational decisions whose action is inherently about a future risk - these
// warrant the forecast even when the query text is tense-neutral.
const FORWARD_RISK_DECISIONS = new Set<string>([
  "hypoxia_management", "algal_management", "flow_management",
]);

// Chart threshold-line label per operational decision. The value and direction are
// taken from the decision's persona-rule constraint, so the line cannot desync
// from the guardrail number the pipeline actually enforces.
const OPERATIONAL_LINE_LABEL: Record<string, string> = {
  hypoxia_management: "HOx threshold",
  algal_management: "Bloom threshold",
  flow_management: "Flush threshold",
  water_extraction: "Intake DO floor",
};

function buildChartSpec(
  channels: LeadsChannel[],
  variableHints: string[],
  siteHints: string[],
  leadsProfile: LeadsProfile | undefined,
  normalizedQuery: string,
  queryMode: LeadsQueryMode,
  objective: LeadsObjective,
  resolvedZone: LeadsDepthZone | null,
): LeadsChartSpec {
  // Only sensor + forecast are plottable time-series channels (literature is not).
  const plotChannels = channels.filter((c) => c === "sensor" || c === "forecast");
  const forecastChannel = plotChannels.includes("forecast");
  // siteHints already unions the profile site (siteIdFor) with any site named in
  // the query, profile first - so siteHints[0] is the reservoir the answer uses.
  const siteId = siteHints[0] ?? (leadsProfile ? siteIdFor(leadsProfile.reservoir) : null);
  // Chart depth = the zone retrieval actually resolved, not the Depth dropdown.
  // Retrieval resolves the zone from the question ("why is the hypolimnetic
  // oxygenation system operated..." gives 9 m) or, in operational mode, from the rule's
  // depth_scope. Using the same resolution here keeps the chart, the answer's numbers
  // and the threshold gate below on one depth.
  const depthZone: LeadsDepthZone | null = resolvedZone;
  const windowDays = inferWindowDays(normalizedQuery);
  // Forecast horizon the answer reasons over (raw; the chart clamps it to [7,35]).
  // Same inferHorizon the answer path uses, so the chart and the answer use one horizon.
  const forecastHorizon = inferHorizon(normalizedQuery);
  const plot = plotChannels.length > 0 && variableHints.length > 0;

  // Forecast layer gate: forward-looking question (or a forward-risk operational
  // decision), and not explicitly retrospective. Retrospective always wins.
  const decision = leadsProfile?.decision ?? "none";
  const retrospective = queryMode === "temporal" || RETROSPECTIVE_RE.test(normalizedQuery);
  const forwardLooking =
    queryMode === "predictive" ||
    queryMode === "scenario" ||
    objective === "forecast" ||
    FORECAST_INTENT_RE.test(normalizedQuery) ||
    FORWARD_RISK_DECISIONS.has(decision);
  const showForecast = forecastChannel && forwardLooking && !retrospective;

  // Operational threshold line, derived from the active decision's persona-rule
  // constraint so the chart line, the forecast P(exceedance), and the verdict banner
  // all read one guardrail number. Single-zone decisions get the line only at their
  // own zone (DO @ hypolimnion for HOx; Chla @ surface for bloom/flush); water
  // extraction is handled by the full-profile branch below; informational mode gets
  // no line.
  const chartPersonaRule =
    leadsProfile && leadsProfile.decision !== "none"
      ? getPersonaRule(leadsProfile.reservoir, leadsProfile.decision, leadsProfile.persona)
      : null;
  let threshold: LeadsChartSpec["threshold"] = null;
  // Full-profile decisions (water extraction) compare depths against a floor rather than
  // watching one zone cross a trigger, so they plot every zone and also carry a reference
  // line. Kept separate from the single-zone branch because the two constraint kinds mean
  // opposite things: a trigger names the bad side (DO < 2: below is bad), while a
  // qualifying constraint names the good side (DO >= 4: below is the failing side).
  // Reusing the trigger derivation here would colour the wrong half of the chart.
  //
  // Scoped to water extraction, not to full_profile generally. The researcher algal
  // rule is also full_profile, but its constraint (FluoroProbe chl > 20) is an alarm
  // the reader wants tripped-or-not, not a floor to clear - inverting its line would
  // colour the wrong half of that chart. Which side is bad is a property of the
  // decision, not of the depth scope, so it is named explicitly here.
  const fullProfile =
    chartPersonaRule?.depth_scope === "full_profile" && leadsProfile?.decision === "water_extraction";
  const profileZones: LeadsDepthZone[] | null =
    fullProfile ? ["epilimnion", "metalimnion", "hypolimnion"] : null;

  if (chartPersonaRule && leadsProfile) {
    const lineLabel = OPERATIONAL_LINE_LABEL[leadsProfile.decision];
    if (fullProfile) {
      // Only draw the floor when it constrains the variable actually being charted -
      // the researcher rule constrains DOsat/FluoroProbe chl, which no chart renders,
      // and a line from a variable the reader cannot see would be worse than none.
      const c = chartPersonaRule.constraints.find((k) => variableHints.includes(k.variable));
      if (lineLabel && c) {
        threshold = {
          value: c.value,
          label: `${lineLabel} ${c.value} ${c.units}`,
          direction: c.op.startsWith(">") ? "below" : "above",
          variable: c.variable,
        };
      }
    } else {
      const ruleZone: LeadsDepthZone | null =
        chartPersonaRule.depth_scope === "profile_zone"
          ? "hypolimnion"
          : chartPersonaRule.depth_scope === "surface"
            ? "epilimnion"
            : null;
      const c = chartPersonaRule.constraints[0];
      if (lineLabel && ruleZone && depthZone === ruleZone && c) {
        threshold = {
          value: c.value,
          label: `${lineLabel} ${c.value} ${c.units}`,
          direction: c.op.startsWith(">") ? "above" : "below",
          variable: c.variable,
        };
      }
    }
  }

  const reason = plot
    ? `plan-driven chart: ${variableHints[0]} · ${plotChannels.join("+")}` +
      ` · ${showForecast ? "observations + forecast" : "observations only"} · ${siteId ?? "fcre"}`
    : "no plottable channel/variable in the plan — no chart";
  return { plot, variableHints, siteId, channels: plotChannels, depthZone, windowDays, forecastHorizon, showForecast, threshold, profileZones, reason };
}

function queryTermsForVariables(variables: string[]) {
  return variables.flatMap((variable) => VARIABLE_ALIASES[variable] ?? [variable]).slice(0, 6);
}

function buildLiteratureQueries(
  originalQuery: string,
  mode: LeadsQueryMode,
  audience: LeadsAudience,
  objective: LeadsObjective,
  scope: LeadsScope,
  sites: string[],
  variables: string[]
) {
  const sitePhrase = sites[0] ? `${sites[0]} reservoir` : "freshwater reservoir";
  const variableTerms = queryTermsForVariables(variables);
  const variablePhrase = variableTerms.slice(0, 3).join(" ");
  const focusPhrase =
    mode === "causal"
      ? "mechanism internal loading stratification oxygen phytoplankton"
      : mode === "management"
      ? "management intervention monitoring operations water quality"
      : mode === "temporal"
      ? "seasonal baseline historical dynamics water quality"
      : mode === "comparative"
      ? "comparative reservoir case study water quality impacts"
      : "water quality impacts mechanisms evidence";

  const audiencePhrase =
    audience === "operator"
      ? "drinking water operations treatment implications"
      : audience === "manager"
      ? "management guidance monitoring recommendations"
      : audience === "scientist"
      ? "mechanistic evidence limnology"
      : audience === "policy"
      ? "adaptation planning decision support"
      : "scientific evidence";

  const scopePhrase =
    scope === "site-specific"
      ? `${sitePhrase} similar systems`
      : scope === "regional-analogue"
      ? "ecologically similar reservoir systems"
      : "freshwater and drinking water reservoirs";

  const queries = [
    originalQuery,
    [sitePhrase, variablePhrase, focusPhrase].filter(Boolean).join(" "),
    [scopePhrase, variablePhrase, audiencePhrase].filter(Boolean).join(" "),
    [sitePhrase, objective, "peer reviewed literature"].filter(Boolean).join(" "),
  ];

  if (/(drawdown)/.test(originalQuery.toLowerCase())) {
    queries.push("reservoir drawdown effects on water quality phytoplankton iron manganese");
  }
  if (variables.includes("DO_mgL_mean")) {
    queries.push(`${sitePhrase} hypolimnetic oxygen depletion internal loading bloom literature`);
  }
  if (variables.includes("Chla_ugL_mean")) {
    queries.push(`${sitePhrase} chlorophyll bloom risk reservoir literature mechanisms`);
  }
  // Greenhouse-gas topic expansion. Without it, GHG questions fall through to the
  // generic causal phrase (hypoxia/algae vocabulary) and retrieval misses the
  // literature on emission rates and their drivers. These queries are added only for
  // GHG questions.
  if (/(greenhouse gas|\bghg\b|methane|\bch4\b|carbon dioxide|\bco2\b|emission|efflux|ebullition|carbon budget|net source)/i.test(originalQuery)) {
    queries.push(`${sitePhrase} methane carbon dioxide emission drivers ebullition diffusive flux efflux`);
    queries.push(`${sitePhrase} greenhouse gas emission events turnover mixing anoxia sediment methane oxidation`);
    queries.push(`${sitePhrase} annual carbon budget net source sink CO2 CH4 flux magnitude`);
  }

  return Array.from(new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean)));
}

function buildSubQueries(
  originalQuery: string,
  channels: LeadsChannel[],
  sites: string[],
  variables: string[],
  literatureQueries: string[]
): string[] {
  const subQueries = [originalQuery];

  if (channels.includes("sensor")) {
    const sensorScope = [sites[0], variables[0], "current reservoir conditions"].filter(Boolean).join(" ");
    if (sensorScope) subQueries.push(`Sensor evidence for ${sensorScope}`);
  }

  if (channels.includes("literature")) {
    subQueries.push(...literatureQueries.slice(0, 3).map((query) => `Literature evidence for ${query}`));
  }

  return Array.from(new Set(subQueries));
}

// Profile-query alignment
//
// Deterministic, pre-LLM detection of a form-question mismatch. Conservative by
// design: a decision/zone is inferred from the text only when the question
// positively names a different one; a text that is silent on decision/zone is
// treated as aligned (trust the form). Keyword matching only - zero LLM cost.

const DECISION_TEXT_SIGNALS: { decision: DecisionKey; terms: string[] }[] = [
  { decision: "algal_management", terms: ["algaecide", "copper sulfate", "cyanobacter", "microcystis", "algal bloom", "control the bloom", "dose algaecide", "add algaecide"] },
  { decision: "hypoxia_management", terms: ["hox", "hypolimnetic oxygenation", "oxygenation system", "operate the oxygen", "anoxia", "anoxic", "hypoxia", "hypoxic"] },
  { decision: "water_extraction", terms: ["intake depth", "withdrawal depth", "withdraw water", "extraction depth", "drinking-water intake", "treatment burden", "depth to withdraw", "depth should we withdraw"] },
  { decision: "flow_management", terms: ["increase flow", "increase the flow", "flush the bloom", "flow to flush", "flush a", "flushing"] },
];

const ZONE_TEXT_SIGNALS: { zone: LeadsDepthZone; terms: string[] }[] = [
  { zone: "epilimnion", terms: ["surface", "epilimnion", "epilimnetic", "surface mixed layer", "top of the water"] },
  { zone: "metalimnion", terms: ["metalimnion", "metalimnetic", "thermocline", "mid-depth", "mid depth"] },
  { zone: "hypolimnion", terms: ["hypolimnion", "hypolimnetic", "bottom water", "bottom of", "deep water", "near the bottom", "at the bottom"] },
];

function inferDecisionFromText(query: string): DecisionKey | null {
  const matched = DECISION_TEXT_SIGNALS.filter((s) => s.terms.some((t) => query.includes(t)));
  // Only commit to a decision when the text points unambiguously to one (a
  // multi-decision hit is ambiguous and is not flagged, to keep precision high).
  return matched.length === 1 ? matched[0].decision : null;
}

function inferDepthZoneFromText(query: string, reservoir: LeadsReservoir): LeadsDepthZone | null {
  for (const s of ZONE_TEXT_SIGNALS) {
    if (s.terms.some((t) => query.includes(t))) return s.zone;
  }
  // Numeric depth ("at 9 m"): the zone whose mapped meters contain it (±1 m).
  for (const d of inferDepthMeters(query)) {
    const zones = DEPTH_ZONE_MAPPING[reservoir];
    for (const zone of Object.keys(zones) as LeadsDepthZone[]) {
      if (zones[zone].some((m) => Math.abs(m - d) <= 1)) return zone;
    }
  }
  return null;
}

function inferReservoirFromText(query: string): LeadsReservoir | null {
  const sites = inferSites(query); // "fcre" | "bvre"
  if (sites.includes("fcre")) return "fcr";
  if (sites.includes("bvre")) return "bvr";
  return null;
}

/** Zone implied by an operational rule's depth_scope (full_profile has no single
 *  zone, so zone-mismatch is not checked for it). */
function scopeToZone(rule: PersonaRule): LeadsDepthZone | null {
  if (rule.depth_scope === "surface") return "epilimnion";
  if (rule.depth_scope === "profile_zone") return "hypolimnion";
  return null; // full_profile
}

function computeProfileQueryAlignment(
  profile: LeadsProfile,
  query: string,
  personaRule: PersonaRule | null,
): LeadsProfileAlignment {
  const inferredDecision = inferDecisionFromText(query);
  const inferredReservoir = inferReservoirFromText(query);
  const inferredZone = inferDepthZoneFromText(query, profile.reservoir);
  const formReservoir = profile.reservoir;

  // Inverse mismatch: informational profile, but a decision-shaped question, so
  // no guardrail would be enforced. Flag it (soft) and suggest operational mode.
  if (profile.decision === "none") {
    if (inferredDecision) {
      return {
        aligned: false,
        severity: "soft",
        dimensions: ["mode"],
        formDecision: "none",
        inferredDecision,
        formZone: null,
        inferredZone,
        formReservoir,
        inferredReservoir,
        rationale:
          `You're in informational mode, but the question reads like an operational ` +
          `${inferredDecision.replace(/_/g, " ")} decision. No guardrail will be enforced — ` +
          `switch to the matching operational decision for a guarded recommendation.`,
        suggestedDecision: inferredDecision,
      };
    }
    return baseAligned(profile, inferredDecision, inferredZone, inferredReservoir);
  }

  // Operational profile: compare each axis. Silence on an axis = aligned.
  const formZone = personaRule ? scopeToZone(personaRule) : null;
  const dimensions: LeadsProfileAlignment["dimensions"] = [];
  if (inferredDecision && inferredDecision !== profile.decision) dimensions.push("decision");
  if (formZone && inferredZone && inferredZone !== formZone) dimensions.push("zone");
  if (inferredReservoir && inferredReservoir !== formReservoir) dimensions.push("reservoir");

  if (dimensions.length === 0) {
    return baseAligned(profile, inferredDecision, inferredZone, inferredReservoir);
  }

  const severity: LeadsProfileAlignment["severity"] = dimensions.length >= 2 ? "hard" : "soft";
  const label = (d: string) => d.replace(/_/g, " ");
  const parts: string[] = [];
  if (dimensions.includes("decision")) {
    parts.push(`it matches the ${label(inferredDecision!)} decision, not the form's ${label(profile.decision)}`);
  }
  if (dimensions.includes("zone")) {
    parts.push(`it points at the ${inferredZone} (the decision evaluates the ${formZone})`);
  }
  if (dimensions.includes("reservoir")) {
    parts.push(`it mentions ${inferredReservoir!.toUpperCase()} (the form is set to ${formReservoir.toUpperCase()})`);
  }
  return {
    aligned: false,
    severity,
    dimensions,
    formDecision: profile.decision,
    inferredDecision,
    formZone,
    inferredZone,
    formReservoir,
    inferredReservoir,
    rationale:
      `Answering under the form's ${label(profile.decision)} guardrail, but ` +
      `${parts.join("; ")}. Re-select the decision/reservoir if that's what you meant.`,
    suggestedDecision: dimensions.includes("decision") ? inferredDecision ?? undefined : undefined,
  };
}

function baseAligned(
  profile: LeadsProfile,
  inferredDecision: DecisionKey | null,
  inferredZone: LeadsDepthZone | null,
  inferredReservoir: LeadsReservoir | null,
): LeadsProfileAlignment {
  return {
    aligned: true,
    severity: "aligned",
    dimensions: [],
    formDecision: profile.decision,
    inferredDecision,
    formZone: null,
    inferredZone,
    formReservoir: profile.reservoir,
    inferredReservoir,
    rationale: "Question is consistent with (or silent on) the declared profile.",
  };
}

// Out-of-scope water-body guard
// LEADS's sensor/forecast coverage is limited to the reservoirs in SITE_ALIASES
// (FCR + BVR via VERA, plus CCR). If a question positively names a different
// water body ("Lake Tahoe", "Lake Mendota", "Smith Mountain Reservoir"), the
// sensor channel would otherwise serve a covered reservoir's reading under the
// foreign name (false grounding). The named foreign body is detected here -
// deterministically, at zero LLM cost - and the orchestrator refuses before
// retrieval. Conservative by design: a query that is silent on the water body,
// or that names a covered reservoir, is never flagged (those fall back to the
// profile's reservoir).

// Flattened in-scope aliases, derived from SITE_ALIASES so adding a reservoir
// there automatically widens scope here (single source of truth).
const IN_SCOPE_WATERBODY_ALIASES: string[] = Object.values(SITE_ALIASES).flat();

// Tokens that can sit next to "lake"/"reservoir" without naming a foreign body,
// so generic mentions ("the reservoir", "lake oxygen", "in lake X") don't trip.
const NON_PLACE_TOKENS = new Set<string>([
  // articles / determiners / prepositions / conjunctions / copulas
  "the", "this", "that", "a", "an", "our", "your", "my", "his", "her", "its",
  "their", "each", "any", "some", "no", "every", "which", "what", "whatever",
  "another", "other", "either", "neither", "same", "given", "subject",
  "candidate", "single", "one", "focused", "whole", "entire",
  "in", "of", "at", "for", "and", "or", "on", "to", "with", "from", "about",
  "into", "is", "are", "be", "was", "were",
  // generic water-domain words
  "drinking", "water", "source", "study", "target", "freshwater", "deep",
  "surface", "bottom",
  // limnology measurement / topic words (so "lake algae", "lake oxygen" pass)
  "algae", "algal", "oxygen", "chlorophyll", "chla", "chl", "temperature",
  "temp", "nutrient", "nutrients", "phosphorus", "nitrogen", "conditions",
  "condition", "sediment", "level", "levels", "quality", "data", "monitoring",
  "sensor", "forecast", "bloom", "blooms", "cyanobacteria", "turbidity",
  "metals", "iron", "manganese", "ecosystem", "ecology", "management",
  "health", "status",
  // limnological descriptors that modify a generic water body (trophic state,
  // mixing regime, climate, size/type) - "a eutrophic reservoir", "a dimictic
  // lake", "a small temperate reservoir" describe a type of water body, they do
  // not name a specific place. Without these, "a eutrophic reservoir" would be
  // parsed as a foreign body "Eutrophic Reservoir" and refused.
  "eutrophic", "oligotrophic", "mesotrophic", "hypereutrophic", "hypertrophic",
  "dystrophic", "dimictic", "monomictic", "polymictic", "meromictic",
  "temperate", "tropical", "subtropical", "boreal", "alpine", "lowland", "upland",
  "small", "large", "shallow", "stratified", "managed", "natural", "artificial",
  "headwater", "typical", "model", "example", "hypothetical", "generic",
  "representative", "similar", "average", "productive",
]);

function titleCaseWaterBody(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function detectOutOfScopeWaterBody(normalizedQuery: string): LeadsOutOfScope | null {
  const q = normalizedQuery;

  // A covered reservoir named anywhere in the query puts it in scope.
  if (IN_SCOPE_WATERBODY_ALIASES.some((alias) => mentionsTerm(q, alias))) return null;

  const candidates: string[] = [];
  // "<name> lake|reservoir|pond|impoundment" - name precedes the type. Listed
  // first so it wins the display name for multi-word bodies.
  for (const m of q.matchAll(/\b([a-z][a-z'.\-]+)\s+(lake|reservoir|pond|impoundment)\b/g)) {
    if (!NON_PLACE_TOKENS.has(m[1])) candidates.push(`${m[1]} ${m[2]}`);
  }
  // "lake <name>" - e.g. "lake tahoe", "lake mendota".
  for (const m of q.matchAll(/\blake\s+([a-z][a-z'.\-]+)/g)) {
    if (!NON_PLACE_TOKENS.has(m[1])) candidates.push(`lake ${m[1]}`);
  }

  if (candidates.length === 0) return null;

  const display = titleCaseWaterBody(candidates[0]);
  const refusal =
    `LEADS can't answer that. Its sensor and forecast coverage is limited to ` +
    `Falling Creek Reservoir (FCR) and Beaverdam Reservoir (BVR), monitored via ` +
    `the VERA network — it has no observational data for ${display}. Reporting a ` +
    `value here would mean borrowing another reservoir's reading and mislabeling ` +
    `it, so LEADS is declining rather than guessing. Re-ask about FCR or BVR, or ` +
    `consult a monitoring program specific to ${display}.`;

  return { namedWaterBody: display, refusal };
}

export function planLeadsQuery(originalQuery: string, leadsProfile?: LeadsProfile): LeadsQueryPlan {
  const normalized = originalQuery.trim().toLowerCase();
  const queryMode = inferMode(normalized);

  // profile.reservoir takes precedence over query-text inference, so the
  // profile-chosen reservoir is used even when the question does not name it.
  const inferredSites = inferSites(normalized);
  const profileSite = leadsProfile ? [siteIdFor(leadsProfile.reservoir)] : [];
  const siteHints = Array.from(new Set([...profileSite, ...inferredSites]));

  const keywordVariables = inferVariables(originalQuery);

  // Seed variableHints from the operational guardrail so retrieval pulls the
  // variables enforcement will check against, even when the query text doesn't
  // name them (e.g. a managerial HOx query under hypoxia_management needs
  // DO_mgL_mean). When a per-persona rule exists, seed from its constraint
  // variables (persona-specific - researcher hypoxia pulls DOsat_percent_mean,
  // which also triggers the forecast %sat derivation in forecast.ts), falling
  // back to the guardrail's required_sensor_variables otherwise.
  const personaRule =
    leadsProfile && leadsProfile.decision !== "none"
      ? getPersonaRule(leadsProfile.reservoir, leadsProfile.decision, leadsProfile.persona)
      : null;
  const guardrailVariables = personaRule
    ? personaRule.constraints.map((c) => c.variable)
    : leadsProfile && leadsProfile.decision !== "none"
      ? getGuardrail(leadsProfile.reservoir, leadsProfile.decision).required_sensor_variables
      : [];
  const variableHints = Array.from(new Set([...guardrailVariables, ...keywordVariables]));
  const timeHints = inferTimeHints(normalized);
  let yearHints = inferYearHints(originalQuery);
  let monthHints = inferMonthHints(originalQuery);
  let dayHints = inferDayHints(originalQuery);

  // Merge relative-date resolutions ("yesterday", "today") into the hint arrays
  // so sensor retrieval can filter to the exact date without requiring the user
  // to type a full YYYY-MM-DD.
  const relativeDates = resolveRelativeDates(originalQuery);
  for (const rd of relativeDates) {
    if (!yearHints.includes(rd.year)) yearHints = [...yearHints, rd.year];
    if (!monthHints.includes(rd.month)) monthHints = [...monthHints, rd.month];
    if (!dayHints.includes(rd.day)) dayHints = [...dayHints, rd.day];
  }

  const audience = inferAudience(normalized);
  const objective = inferObjective(normalized, queryMode);
  const scope = inferScope(normalized, siteHints);
  let channels = inferChannels(normalized, queryMode);
  // When the user has committed to an operational decision via the profile,
  // force-include sensor + forecast channels even if the query keywords don't
  // name them. Without this, a short managerial query like "Should we be
  // concerned about hypoxia at FCR this week?" routes to literature-only (no
  // "DO" / "sensor" / "forecast" keywords), retrieval pulls no sensor/forecast
  // evidence, and Layer 2's required-variable check refuses. The guardrail
  // variableHints union above is necessary but not sufficient without channels
  // to fetch them.
  if (leadsProfile && leadsProfile.decision !== "none") {
    const decisionChannels: LeadsChannel[] = ["sensor", "forecast", "literature"];
    channels = Array.from(new Set([...channels, ...decisionChannels]));
  }
  const literatureQueries = buildLiteratureQueries(
    originalQuery,
    queryMode,
    audience,
    objective,
    scope,
    siteHints,
    variableHints
  );

  // Depth zone to meter resolution. Sensor and forecast channels both filter by
  // this array; values exist as both VERA sensor depths and exact FLARE GLM-AED
  // layers. For an operational decision the depth is derived from the persona
  // rule's depth_scope (surface / profile_zone / full_profile) and overrides the
  // Depth dropdown; full_profile gives [] (whole column).
  // In informational mode, a depth named in the question ("at 5 m") drives
  // retrieval; only fall back to the profile zone if the text is depth-silent.
  const textDepthsM = inferDepthMeters(originalQuery);
  // Informational mode: a word-based zone in the question ("hypolimnetic DO",
  // "bottom water", "surface chl-a") drives retrieval depth too - not just
  // numeric "at 9 m". Runs only when the text names no numeric depth (numeric is
  // more precise, so it wins) and a profile is present. Operational mode is
  // unaffected - it always derives depth from the rule's depth_scope.
  const textZone =
    !personaRule && leadsProfile && textDepthsM.length === 0
      ? inferDepthZoneFromText(normalized, leadsProfile.reservoir)
      : null;
  // The zone the chart must draw - the same resolution retrieval just performed.
  // Operational: the rule's own depth_scope (full_profile has no single zone, so the
  // dropdown stands in; profileZones drives that chart anyway). Informational: the zone
  // named in the question, by word ("hypolimnetic") or by number ("at 9 m"), falling back
  // to the dropdown only when the text is zone-silent.
  const chartZone: LeadsDepthZone | null = personaRule
    ? scopeToZone(personaRule) ?? leadsProfile?.depth ?? null
    : (leadsProfile ? inferDepthZoneFromText(normalized, leadsProfile.reservoir) : null)
      ?? leadsProfile?.depth
      ?? null;

  const resolvedDepthsM = personaRule
    ? resolveScopeDepths(leadsProfile!.reservoir, leadsProfile!.decision, personaRule.depth_scope)
    : textDepthsM.length > 0
      ? textDepthsM
      : textZone
        ? resolveDepthMeters(leadsProfile!.reservoir, textZone)
        : leadsProfile
          ? resolveDepthMeters(leadsProfile.reservoir, leadsProfile.depth)
          : [];

  return {
    originalQuery,
    queryMode,
    subQueries: buildSubQueries(originalQuery, channels, siteHints, variableHints, literatureQueries),
    literatureQueries,
    channels,
    siteHints,
    queryInferredSites: inferredSites,
    variableHints,
    timeHints,
    yearHints,
    monthHints,
    dayHints,
    audience,
    objective,
    scope,
    resolvedDepthsM,
    // Carry the depth_scope so the sensor channel knows when to retrieve
    // the whole-column profile (full_profile) vs a single zone.
    resolvedDepthScope: personaRule ? personaRule.depth_scope : undefined,
    // Deterministic profile-query alignment (only when a profile
    // was supplied). Non-blocking - does not alter retrieval or guardrail above.
    profileQueryAlignment: leadsProfile
      ? computeProfileQueryAlignment(leadsProfile, normalized, personaRule)
      : undefined,
    // Out-of-scope guard: flag a named foreign water body so the
    // orchestrator refuses pre-retrieval instead of mislabeling covered data.
    outOfScope: detectOutOfScopeWaterBody(normalized) ?? undefined,
    // Plot spec: the planner owns the chart decision, so the UI renders the
    // same variable/site/depth/window the agent retrieved on.
    chart: buildChartSpec(channels, variableHints, siteHints, leadsProfile, normalized, queryMode, objective, chartZone),
  };
}
