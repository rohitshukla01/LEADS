/**
 * Verbatim literature gate (LEADS_LIT_VERBATIM, lib/leads/lit-verbatim.ts).
 *
 *   npx tsx scripts/check-verbatim-excerpts.ts
 *
 * Offline. The fixtures below are verbatim chunks copied from the indexed corpus
 * (Qdrant payload display_text, raptor_level 0); nothing is read from outside the repo.
 * The LLM transport is replaced in-process: globalThis.fetch answers chat-completion
 * requests to an unroutable mock origin with canned text and records each request, and
 * any other request fails the run, so nothing leaves the process.
 *
 * Asserts:
 *  1. Quotes: the printed quotation is a substring of the chunk made of whole sentences:
 *     it starts at a sentence start and ends at a sentence end (or is a whole "Key Points"
 *     item), is at most LITERATURE_QUOTE_CHAR_CAP chars, and never starts with a running
 *     header, a publisher stamp or a figure/table caption when other sentences exist. It is
 *     the sentence that supports the citing answer sentence; a chunk with no quotable
 *     sentence yields null.
 *  2. Budget: under a worst-case packet every non-literature record (constraint
 *     evaluation, forecast cards with window summary and peak line, skill record,
 *     freshness caveat, sensor readings) is placed whole and only literature passages are
 *     shortened, at sentence ends; when the records alone exceed the limit they are still
 *     whole. A typical packet carries each passage whole. The SCOPE note is short and
 *     counted in the packet size.
 *  3. Verifier: verifyClaims cuts sources at 500 chars by default and shows the whole
 *     passage with sourceCharCap; with the switch on,
 *     assessClaimSupport sends the packet text the answer model read.
 *  4. Flags: the tool defaults to on; the orchestrator reads one mode per request; the
 *     query-cache key differs by mode and "off" adds nothing to it; the retrieved set and
 *     its order do not depend on the mode.
 *  5. Off: the literature packet, the synthesis evidence block, the citations, the
 *     fallback text and the verifier input match the frozen baseline below.
 *  6. On, end to end: the synthesis prompt carries each passage whole and every record
 *     whole; each literature citation prints a quotation chosen against the answer
 *     sentence citing it and keeps the model's text in modelText.
 */
import { readFileSync } from "fs";
import { join } from "path";

import type { LeadsCitation, LeadsEvidence } from "../lib/leads/types";

// In-process LLM stand-in
const MOCK_ORIGIN = "http://llm-check.invalid";
process.env.LEADS_GEN_BASE_URL = `${MOCK_ORIGIN}/v1`;
process.env.LEADS_GEN_API_KEY = "offline-check";
for (const key of [
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "LEADS_AUX_MODEL",
  "LEADS_LIT_VERBATIM", "LEADS_RAPTOR_MODE", "COHERE_API_KEY", "CO_API_KEY",
]) delete process.env[key];

interface ChatRequest {
  system: string;
  user: string;
}
const chatRequests: ChatRequest[] = [];
const strayRequests: string[] = [];
let synthesisReply = "";
let verifierReply = "[]";

globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
  if (!url.startsWith(MOCK_ORIGIN)) {
    strayRequests.push(url);
    throw new Error(`check-verbatim-excerpts: unexpected request to ${url}`);
  }
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
    messages?: Array<{ role: string; content: string }>;
  };
  const messages = body.messages ?? [];
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  chatRequests.push({ system, user });
  const content = system.startsWith("You are a faithfulness verifier")
    ? verifierReply
    : system.startsWith("You are LEADS")
    ? synthesisReply
    : "";
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}) as typeof fetch;

// Result bookkeeping
const failures: string[] = [];
let passed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}${detail ? `  ::  ${detail}` : ""}`);
  }
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const original = { info: console.info, warn: console.warn, log: console.log };
  const logged: string[] = [];
  const sink = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  };
  console.info = sink;
  console.warn = sink;
  try {
    return { value: await fn(), logged };
  } finally {
    console.info = original.info;
    console.warn = original.warn;
  }
}

// Fixtures: verbatim chunks from the indexed corpus
interface Fixture {
  docName: string;
  chunkIndex: number;
  pageNum: number;
  text: string;
}
const CHUNKS: Record<string, Fixture> = {
  GERLING: {
    docName: "Gerling2014_WaterResearch.pdf",
    chunkIndex: 18,
    pageNum: 7,
    text: "Available online 10 September 2014\n\nWe activated the SSS system on 14 May 2013 and operated it continuously for five weeks. The system was deactivated on 20 June 2013 and remained off until it was reactivated on 1 August 2013. After the system was reactivated a second time, it remained on for the duration of the experimental monitoring period.\n\nDuring both activation periods, the SSS was operated to add oxygen to the hypolimnion at 25 kg/d with a pump flow rate set at 227 LPM. At this pump flow rate, the mean hypolimnetic volume during both activation periods (4.4 -10 7 L) was actively circulated through the SSS system every 133 days. However, the active circulation induced in the hypolimnion from pump discharge through the eductor nozzles was estimated to be 1135 LPM, thus mixing the mean hypolimnetic volume every 26 days.\n\nwater research 67 (2014) 129 e 1 4 3\n\n135\n\nFig. 3 e Dissolved oxygen concentrations from the deep hole of the reservoir from 4 April to 25 September 2013. The system was deactivated until 14 May (denoted by the ' OFF ' ), activated until 20 June (denoted by the ' ON ' ), deactivated again until 1 August (denoted by the ' OFF ' ), and finally reactivated for the remainder of the sampling period (denoted by the ' ON ' ). All sample days are denoted by inverted black triangles; data were interpolated between sample days for the figure. The distri bution header was located at 8.5 m depth.",
  },
  WOOD: {
    docName: "Wood2026_WaterResearch.pdf",
    chunkIndex: 20,
    pageNum: 6,
    text: "Water Research 288 (2026) 124722\n\n3. Results\n\n3.1. Water temperature and dissolved oxygen\n\nOver the six years of data, both FCR and BVR experienced seasonal hypolimnetic anoxia as a result of summer thermal stratification (defined as DO concentrations less than 0 mg/L). FCR and BVR typically thermally stratified in March or April each year and remained stratified through fall turnover in late October or November (Fig. 2). Stratification duration and buoyancy frequency was similar between FCR and BVR (Figs. S 8 & S 9). Temperatures in the hypolimnion ranged from approximately 5 to 15 \u25e6 C in both FCR and BVR during the summer stratification period.\n\nWhile FCR and BVR both exhibited stable summer thermal stratification and winter mixing over the monitoring period (Fig. 2), they had differing hypolimnetic DO depth profiles due to the presence of the HOx system in FCR but not BVR (Fig. 3). In BVR, DO in the hypolimnion began to decrease in April. The hypolimnion typically became anoxic in C.E. Wood et al.\n\n4",
  },
  KRUEGER: {
    docName: "Krueger2020_WaterResearch.pdf",
    chunkIndex: 41,
    pageNum: 13,
    text: "In a similar fashion, SOD was calculated using the change of\n\n[REDACTED-NAME] et al. / Water Research 182 (2020) 116003\n\n13",
  },
  LEWIS_KEY_POINTS: {
    docName: "Lewis2024_JGRBiogeosciences.pdf",
    chunkIndex: 0,
    pageNum: 1,
    text: "Key Points:\n\nAmonth-long drawdown (36% volume reduction) in a eutrophic reservoir substantially changed water quality relative to a reference year\n\nCoincident with drawdown, both stratification strength at the thermocline and epilimnetic nutrient concentrations increased\n\nAsubsequent cyanobacterial bloom led to decreased surface dissolved oxygen and increases in solutes associated with bloom degradation",
  },
  LEWIS_STAMP: {
    docName: "Lewis2023_JGRBiogeosciences.pdf",
    chunkIndex: 10,
    pageNum: 5,
    text: "Journal of Geophysical Research: Biogeosciences\n\n10.1029/2022 JG 007071\n\n21698961, 2023, 1, See the wiley.com/terms-and-conditions) on Conceptual diagram describing the hypo thesized effects of changing oxygen conditions on coupled iron (Fe) and organic carbon (OC) interactions in a lake or reservoir. Under oxic conditions (top), complexation of Fe and OC (both through coprecipitation and adsorption) leads to increased concentrations of Fe-OC in sediments (increased Fe-OC protection), though oxic conditions may also lead to increased OC respiration rates. Under hypoxic conditions, reductive dissolution of Fe(III) in Fe-OC complexes increases dissolved concentrations of Fe(II) and OC in the water column while decreasing the amount of Fe-OC in sediment (decreasing Fe-OC protection), though hypoxia may also decrease OC respiration rates. The net effect of these processes on OC sequestration remains unknown, motivating this study. This figure is a simplification of complex interactions happening on a whole-ecosystem scale, and focuses on hypo thesized dominant processes operating on the timescale of days to years.",
  },
  LEWIS_SUMMARY: {
    docName: "Lewis2023_JGRBiogeosciences.pdf",
    chunkIndex: 4,
    pageNum: 2,
    text: "Author Contri butions:\n\nPlain Language Summary Freshwater lakes and reservoirs (hereafter: lakes) play a remarkably important role in the global carbon cycle, as important sites for both carbon sequestration and greenhouse gas emissions. The extent to which lakes sequester carbon versus release greenhouse gases depends upon many factors, including associations between carbon and iron that can help to preserve carbon in sediment. However, global declines in freshwater oxygen concentrations have the potential to affect these chemical complexes. Here, we added oxygen to the bottom waters of a lake to test how changes in oxygen concentration affect carbon and iron cycling. We found that over short timescales (weeks), low oxygen conditions decreased the amount of carbon in sediment by breaking apart associations between iron and carbon that help retain carbon in sediment. However, over long timescales (years), low oxygen conditions appeared to increase carbon burial by decreasing the rate at which carbon inputs were decomposed. These results suggest that declining oxygen concentrations in lakes around the world may have important effects on global carbon cycling, with the direction and magnitude of the impact depending on the duration of low oxygen conditions.\n\n1. Introduction",
  },
  DOUBEK: {
    docName: "Doubek2019_Water.pdf",
    chunkIndex: 1,
    pageNum: 1,
    text: "Article\n\nAbstract: In freshwater lakes and reservoirs, climate change and eutrophication are increasing the occurrence of low-dissolved oxygen concentrations (hypoxia), which has the potential to alter the variability of zooplankton seasonal dynamics. We sampled zooplankton and physical, chemical and biological variables (e.g., temperature, dissolved oxygen, and chlorophyll a ) in four reservoirs during the summer stratified period for three consecutive years. The hypolimnion (bottom waters) of two reservoirs remained oxic throughout the entire stratified period, whereas the hypolimnion of the other two reservoirs became hypoxic during the stratified period. Biomass variability (measured as the coe cient of the variation of zooplankton biomass) and compositional variability (measured as the community composition of zooplankton) of crustacean zooplankton communities were similar throughout the summer in the oxic reservoirs; however, biomass variability and compositional variability significantly increased after the onset of hypoxia in the two seasonally-hypoxic reservoirs. The increase in biomass variability in the seasonally-hypoxic reservoirs was driven largely by an increase in the variability of copepod biomass, while the increase in compositional variability was driven by increased variability in the dominance (proportion of total crustacean zooplankton biomass) of copepod taxa. Our results suggest that hypoxia may increase the seasonal variability of crustacean zooplankton communities.\n\nKeywords: aggregate variability; anoxia; calanoid copepod; cladoceran; climate change; cyclopoid copepod; global change; lake; plankton; reservoir\n\n1. Introduction\n\nGlobal change is resulting in more variable environmental conditions in both terrestrial and aquatic ecosystems [1-3], which may in turn be altering the variability of biotic communities [4-6]. Here we define variability as biomass variability, that is, as the temporal variability of biomass in an ecological community thatis summedacross all taxa present [7,8], and compositional variability as the relative change in the composition of taxa within that community [9-11]. Underst anding the variability of ecological communities is critical to predicting how ecosystems will respond to environmental change [12].",
  },
  HOWARD: {
    docName: "Howard2026_JGRBiogeosciences.pdf",
    chunkIndex: 8,
    pageNum: 3,
    text: "Journal of Geophysical Research: Biogeosciences\n\nDespite this challenge, several studies have explored different data-driven model structures, including autoregressive models (Olson et al., 2022) and machine learning models (He & Ma, 2024), that rely on readily forecastable inputs or observed DOM time series. Each of these data-driven model structures provide different advantages: for example, autoregressive models are relatively easy to configure and enable testing of a wide variety of environmental covariates that may influence DOM concentrations, such as water temperature (Dinsmore et al., 2013), meteorology (M\u00fcller et al., 2014), and hydrology (Catal\u00e1n et al., 2016). Similarly, machine learning models are increasing in popularity in water quality and quantity forecasting (Lofton et al., 2023) and provide new opportunities to leverage historical data sets for prediction, especially using neural network modeling approaches (Wai et al., 2022). Additionally, simple baseline models, such as persistence or day-of-year baseline models, are easily applied data-driven models that can sometimes outperform process and other datadriven models in forecasting other water quality variables (e.g., Olsson et al., 2024; Page et al., 2018; Woelmer et al., 2024), though remain untested for forecasting DOM.\n\nGiven the widespread issues of DBP formation in freshwater ecosystems, developing simple, data-driven models with limited input data would be beneficial for informing manager decision-making (Mukundan & Van Dreason, 2014; K. Wang et al., 2024). We note that our focus here is specifically on data-driven models because forecast models require forecasted inputs, and more complex model structures (e.g., process-based ecosystem models; hydrodynamic models) require input data sets for which forecasts cannot easily be acquired (e.g., inflow nutrient and carbon concentrations, algal dynamics). Consequently, by focusing on simpler data-driven models that have inputs that can be readily forecasted and accessed (e.g., meteorological variables), we developed forecasting approaches in this study that can be more readily applied at other waterbodies, and in the future be exp anded with more complex model structures when other forecasted data sets become available.",
  },
  WANDER: {
    docName: "Wander2024_Ecosphere.pdf",
    chunkIndex: 27,
    pageNum: 12,
    text: "Question 3\n\nWe quantified total forecast uncertainty for each day in the 1- to 35-day forecast horizon using the variance of the 256-member FLARE ensemble. The relative contri bution of initial condition uncertainty to total forecast uncertainty was calculated for each forecasted day by comparing the variance in the 256-member FLARE ensemble between the set of forecasts with initial condition uncertainty included and the set without initial condition uncertainty.\n\nAll statistical analyses were conducted in R v.4.2.0 (R Core Team, 2022). All R code and data files used to run these analyses are archived and available in the Zenodo repository (Wander et al., 2023 a, 2023 b).",
  },
};

// Frozen baseline for LEADS_LIT_VERBATIM "off"
// Fixed copies of evidenceToPromptContext (lib/leads/fusion.ts), the 8,000-char cut,
// toCitations and formatFallbackEvidence (lib/leads/generator.ts) and the verifier's
// Sources block (lib/faithfulness.ts) as they behave with the switch off.
function legacyEvidenceToPromptContext(evidence: LeadsEvidence[]): string {
  return evidence
    .map((item, index) => {
      const citationLabel =
        item.channel === "literature"
          ? `${item.provenance.docName ?? item.title} · page ${item.provenance.pageNum ?? 0}`
          : item.channel === "sensor"
          ? `${item.provenance.siteId?.toUpperCase() ?? item.title} · ${item.provenance.variable ?? "sensor"} · ${item.provenance.timestamp ?? "unknown time"}`
          : item.title;
      const kind =
        item.channel === "literature"
          ? "LITERATURE"
          : item.channel === "sensor"
          ? "SENSOR OBSERVATION"
          : "FORECAST";
      const selfRef = item.channel === "literature" &&
        /\b(?:our|the present|this)\s+(?:study|work|analysis|dataset|survey|sampling|experiment)\b|\bwe\s+(?:analyz|examin|sampl|measur|collect|estimat|observ|report|found|conduct)/i.test(item.text ?? "");
      const anchor = selfRef
        ? `\n[SCOPE: "our study" / "we" in this excerpt refers to ${item.provenance.docName ?? item.title} and to NO other source. Any period, duration, sample size or site condition it describes belongs to that source alone — do not let it describe a different study named nearby. If you use this detail, name its source.]`
        : "";
      return `[${index + 1}] ${kind} — ${citationLabel}\n${item.text}${anchor}`;
    })
    .join("\n\n---\n\n");
}

function legacyEvidenceBlock(evidence: LeadsEvidence[]): string {
  let context = legacyEvidenceToPromptContext(evidence);
  if (context.length > 8_000) context = context.slice(0, 8_000) + "\n[evidence truncated for brevity]";
  return context;
}

function legacyBracketNumbers(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g)) {
    for (const part of match[1].split(/\s*,\s*/)) out.push(Number.parseInt(part, 10));
  }
  return out;
}

function legacyToCitations(response: string, evidence: LeadsEvidence[]): LeadsCitation[] {
  const used = new Set<number>();
  for (const bracket of legacyBracketNumbers(response)) {
    const index = bracket - 1;
    if (index >= 0 && index < evidence.length) used.add(index);
  }
  return evidence.map((item, index) => ({
    text: item.text,
    fullText: item.fullText,
    chunkIndex: item.provenance.chunkIndex ?? index,
    docName: item.provenance.docName ?? item.provenance.label,
    pageNum: item.provenance.pageNum ?? 0,
    rerankScore: item.score,
    method:
      item.channel === "sensor"
        ? "hybrid"
        : item.provenance.method?.includes("sparse")
        ? "sparse"
        : item.provenance.method?.includes("dense")
        ? "dense"
        : "hybrid",
    sourceType: item.provenance.type,
    sourceUrl: item.provenance.sourceUrl,
    timestamp: item.provenance.timestamp,
    siteId: item.provenance.siteId,
    variable: item.provenance.variable,
    depthM: item.provenance.depthM,
    bracketNum: index + 1,
    citedInAnswer: used.has(index),
  }));
}

function legacyFormatFallbackEvidence(evidence: LeadsEvidence[]): string {
  const cleanDocumentTitle = (name?: string) => (name ? name.replace(/\.[^/.]+$/, "").trim() || name : "Indexed source");
  const label = (item: LeadsEvidence, index: number) => {
    if (item.channel === "literature") {
      const title = cleanDocumentTitle(item.provenance.docName ?? item.title);
      const page = item.provenance.pageNum && item.provenance.pageNum > 0 ? `p.${item.provenance.pageNum}` : "page unknown";
      return `${title} (${page})`;
    }
    if (item.channel === "sensor") {
      return `${item.provenance.siteId?.toUpperCase() ?? item.title} ${item.provenance.variable ?? "sensor"} (${item.provenance.timestamp ?? "unknown time"})`;
    }
    if (item.channel === "forecast") {
      const parts = [
        item.provenance.siteId?.toUpperCase() ?? "",
        item.provenance.variable ?? "",
        item.provenance.horizon ? `${item.provenance.horizon}d` : "",
        item.provenance.ensembleSize ? `${item.provenance.ensembleSize}-member ensemble` : "",
      ].filter(Boolean);
      return parts.length > 0 ? `FLARE GLM-AED ${parts.join(" ")}` : item.title;
    }
    return item.title || `Source ${index + 1}`;
  };
  return evidence
    .slice(0, 4)
    .map((item, index) => `Source ${index + 1}: ${label(item, index)}\nExcerpt: ${item.text} [${index + 1}]`)
    .join("\n\n");
}

function legacySourcesBlock(sources: string[]): string {
  return `Sources:\n${sources.map((s, i) => `[${i}] ${s.slice(0, 500)}`).join("\n\n---\n\n")}`;
}

// Evidence builders
function literature(f: Fixture, slot: number, claim: string, docName = f.docName): LeadsEvidence {
  return {
    id: `lit:dense:0:${slot}`,
    channel: "literature",
    title: docName,
    text: claim,
    fullText: f.text,
    score: 0.72 - slot * 0.01,
    provenance: {
      type: "literature",
      label: docName,
      docName,
      pageNum: f.pageNum,
      chunkIndex: f.chunkIndex,
      score: 0.72 - slot * 0.01,
      method: "cohere-rerank",
    },
  };
}

function record(
  channel: "sensor" | "forecast",
  id: string,
  title: string,
  text: string,
  provenance: Partial<LeadsEvidence["provenance"]> = {}
): LeadsEvidence {
  return {
    id,
    channel,
    title,
    text,
    score: 0.9,
    provenance: { type: channel, label: title, ...provenance },
  };
}

// Synthetic operational records shaped like the orchestrator's deterministic items.
function forecastCard(site: string, variable: string, days: number): string {
  const lines = Array.from({ length: days }, (_, d) =>
    `Day ${d + 1}: mean ${(7.4 - d * 0.05).toFixed(2)}, 10th pct ${(6.1 - d * 0.06).toFixed(2)}, 90th pct ${(8.6 - d * 0.04).toFixed(2)}, ${Math.min(31, d)} of 31 members below the decision limit.`
  );
  return (
    `FLARE GLM-AED ensemble forecast, ${site} ${variable} at 1.6 m, run 2026-05-01, 31 members.\n` +
    `${lines.join("\n")}\n` +
    `Window summary: over days 1-${days} the ensemble mean stays between ${(7.4 - (days - 1) * 0.05).toFixed(2)} and 7.40; ` +
    `the lowest 10th percentile is ${(6.1 - (days - 1) * 0.06).toFixed(2)}.\n` +
    `Peak line: the highest daily count below the limit is ${Math.min(31, days - 1)} of 31 members, on day ${days}.`
  );
}

const RECORDS: LeadsEvidence[] = [
  record("sensor", "sensor:constraint-eval", "Operational constraint evaluation (deterministic)",
    "DECISION CONSTRAINT EVALUATION (deterministic, computed by LEADS — treat as authoritative for the operational verdict): " +
      "the qualifying-depth search over the full profile on the latest sample date found no depth at or below the decision limit; " +
      "persistence run: 0 consecutive days below the limit; season: inside the stratified period. Not evaluated: withdrawal depth.",
    { method: "constraint-eval" }),
  record("forecast", "forecast:freshness-caveat", "Forecast freshness caveat",
    "FORECAST FRESHNESS CAVEAT (deterministic): the newest forecast run predates the newest sensor observation; leads valid on or before that observation are superseded by it.",
    { method: "forecast-freshness" }),
  record("forecast", "forecast:skill-record", "FLARE forecast skill record",
    "FORECAST SKILL RECORD (deterministic, FCR Chlorophyll-a at 1.6 m, past forecasts to 14 Oct 2026): More skilful than climatology on days 1–7. CRPSS against climatology by forecast day, with 95% CI: day 1 +62% (51 to 71); day 2 +55% (43 to 64); day 7 +24% (6 to 39).",
    { method: "forecast-skill" }),
  record("sensor", "sensor:operational-framing", "Operational framing (decision guardrail)",
    "OPERATIONAL FRAMING (decision guardrail — authoritative; honor the operational lever and any do-not rules): " +
      "the lever for this decision is the reservoir's management system; state what the deterministic check evaluated and do not describe its operating state.",
    { method: "operational-framing" }),
  record("forecast", "forecast:fcre:do:card1", "FLARE FCRE DO_mgL_mean", forecastCard("FCRE", "DO_mgL_mean", 21),
    { siteId: "fcre", variable: "DO_mgL_mean", horizon: 21, ensembleSize: 31 }),
  record("forecast", "forecast:fcre:temp:card2", "FLARE FCRE Temp_C_mean", forecastCard("FCRE", "Temp_C_mean", 21),
    { siteId: "fcre", variable: "Temp_C_mean", horizon: 21, ensembleSize: 31 }),
  record("forecast", "forecast:bvre:do:card3", "FLARE BVRE DO_mgL_mean", forecastCard("BVRE", "DO_mgL_mean", 21),
    { siteId: "bvre", variable: "DO_mgL_mean", horizon: 21, ensembleSize: 31 }),
  ...Array.from({ length: 6 }, (_, i) =>
    record("sensor", `sensor:fcre:${i}`, `VERA FCRE DO_mgL_mean ${i}`,
      `FCRE DO_mgL_mean at ${[0.1, 1.6, 3.8, 5.0, 6.2, 8.0][i]} m on 2026-04-28: ${(8.2 - i * 0.9).toFixed(2)} mg/L. ` +
        `Matched seasonal baseline (all years, same weeks): mean ${(8.0 - i * 0.8).toFixed(2)}, range ${(5.1 - i * 0.7).toFixed(2)}-${(10.3 - i * 0.6).toFixed(2)}, n=${140 + i}.`,
      { siteId: "fcre", variable: "DO_mgL_mean", timestamp: "2026-04-28", depthM: [0.1, 1.6, 3.8, 5.0, 6.2, 8.0][i] })),
];

// Quote checks
const FURNITURE_START: RegExp[] = [
  /^water research \d/i,
  /^\d{8}, \d{4}/,
  /^\d{1,4}\s/,
  /^available online/i,
  /^(?:figs?\.?|f ?i ?g ?u ?r ?e ?s?|tables?)\s*S?\d/i,
  /^(?:plain language summary|abstract|key points|author contri|keywords?)\b/i,
  /^journal of /i,
];
const FURNITURE_ANYWHERE = /water research \d+ \(\d{4}\)|\b\d{8}, \d{4}, \d{1,3},|et al\. ?\/|downloaded from|wiley\.com/i;

function quoteProblems(chunk: string, quote: string): string[] {
  const passage = verbatimPassageFn(chunk);
  const problems: string[] = [];
  const at = passage.indexOf(quote);
  if (at < 0) problems.push("not a substring of the passage");
  if (!collapseWhitespaceFn(chunk).includes(collapseWhitespaceFn(quote))) problems.push("not a substring of the indexed chunk");
  if (quote.length > LITERATURE_QUOTE_CHAR_CAP_V) problems.push(`length ${quote.length} > ${LITERATURE_QUOTE_CHAR_CAP_V}`);
  if (!/^["'“‘([]?[A-Z0-9]/.test(quote)) problems.push("does not open on a capital or digit");
  if (quote.includes("\n\n")) problems.push("spans a paragraph break");
  if (at >= 0) {
    const before = passage.slice(0, at);
    const after = passage.slice(at + quote.length);
    const opens =
      at === 0 ||
      before.endsWith("\n\n") ||
      /[.!?]["'”’)\]]*\s+$/.test(before) ||
      /(?:^|\n\n)(?:plain language summary|abstract:?)\s+$/i.test(before);
    if (!opens) problems.push("starts mid-sentence");
    const fullStop = /[.!?]["'”’)\]]*$/.test(quote) && !/\b(?:al|Fig|Figs|e\.g|i\.e|[A-Z])\.$/.test(quote);
    const keyPointsItem = passage.startsWith("Key Points:") && before.endsWith("\n\n") && (after === "" || after.startsWith("\n\n"));
    if (!((fullStop && (after === "" || /^\s/.test(after))) || keyPointsItem)) problems.push("ends mid-sentence");
  }
  for (const re of FURNITURE_START) if (re.test(quote)) problems.push(`starts with page furniture ${re}`);
  if (FURNITURE_ANYWHERE.test(quote)) problems.push("contains a running head or stamp");
  return problems;
}

// Bound late in main() to the live module (kept here so quoteProblems reads plainly).
let verbatimPassageFn: (raw: string) => string = (raw) => raw;
let collapseWhitespaceFn: (raw: string) => string = (raw) => raw;
let LITERATURE_QUOTE_CHAR_CAP_V = 600;

async function main(): Promise<void> {
  const lv = await import("../lib/leads/lit-verbatim");
  const budgetMod = await import("../lib/leads/evidence-budget");
  const { evidenceToPromptContext, fuseEvidence } = await import("../lib/leads/fusion");
  const { verifyClaims, formatVerifierSources, DEFAULT_SOURCE_CHAR_CAP } = await import("../lib/faithfulness");
  const { assessClaimSupport, verifierSources } = await import("../lib/leads/verification");
  const { generateGroundedAnswer, generateAbstentionAnswer } = await import("../lib/leads/generator");
  const { buildCacheKey } = await import("../lib/leads/query-cache");
  const { literatureExcerptNote, LITERATURE_EXCERPT_NOTE, excerptLimit, selectTopEvidence } = await import("../lib/report-content");
  verbatimPassageFn = lv.verbatimPassage;
  collapseWhitespaceFn = lv.collapseWhitespace;
  LITERATURE_QUOTE_CHAR_CAP_V = lv.LITERATURE_QUOTE_CHAR_CAP;
  const passageOf = (f: Fixture) => lv.verbatimPassage(f.text);

  // 1. Quotes
  console.log("\n[quotes] whole sentences copied from the chunk");
  check("quote cap is 600 chars, packet cap 2,500", lv.LITERATURE_QUOTE_CHAR_CAP === 600 && lv.LITERATURE_ITEM_CHAR_CAP === 2_500);

  const pinned: Array<[string, Fixture, string, string | null, string?]> = [
    ["dose and flow sentence", CHUNKS.GERLING,
      "The SSS added oxygen to the hypolimnion at 25 kg/d with a pump flow of 227 LPM [1].",
      "During both activation periods, the SSS was operated to add oxygen to the hypolimnion at 25 kg/d with a pump flow rate set at 227 LPM."],
    ["deactivation sentence", CHUNKS.GERLING,
      "The oxygenation system was switched off on 20 June 2013 and back on 1 August 2013 [1].",
      "The system was deactivated on 20 June 2013 and remained off until it was reactivated on 1 August 2013."],
    ["one sentence when the previous one adds nothing", CHUNKS.WOOD,
      "In BVR, hypolimnetic DO began to decline in April [2].",
      "In BVR, DO in the hypolimnion began to decrease in April."],
    ["first sentence after a running head and two headings", CHUNKS.WOOD,
      "Both reservoirs develop seasonal hypolimnetic anoxia during summer stratification [2].",
      "Over the six years of data, both FCR and BVR experienced seasonal hypolimnetic anoxia as a result of summer thermal stratification (defined as DO concentrations less than 0 mg/L)."],
    ["Key Points item without a full stop", CHUNKS.LEWIS_KEY_POINTS,
      "During the drawdown, stratification strength at the thermocline and epilimnetic nutrients increased [3].",
      "Coincident with drawdown, both stratification strength at the thermocline and epilimnetic nutrient concentrations increased"],
    ["sentence after a publisher stamp", CHUNKS.LEWIS_STAMP,
      "Under oxic conditions, complexation of Fe and OC increases Fe-OC in sediments [4].",
      "Under oxic conditions (top), complexation of Fe and OC (both through coprecipitation and adsorption) leads to increased concentrations of Fe-OC in sediments (increased Fe-OC protection), though oxic conditions may also lead to increased OC respiration rates."],
    ["heading run into the sentence is left out", CHUNKS.LEWIS_SUMMARY,
      "Lakes play an important role in the global carbon cycle [5].",
      "Freshwater lakes and reservoirs (hereafter: lakes) play a remarkably important role in the global carbon cycle, as important sites for both carbon sequestration and greenhouse gas emissions."],
    ["sentence late in the passage", CHUNKS.LEWIS_SUMMARY,
      "Over weeks, low oxygen decreased sediment carbon by breaking iron-carbon associations [5].",
      "We found that over short timescales (weeks), low oxygen conditions decreased the amount of carbon in sediment by breaking apart associations between iron and carbon that help retain carbon in sediment."],
    ["closing sentence of an abstract", CHUNKS.DOUBEK,
      "Hypoxia may increase the seasonal variability of crustacean zooplankton communities [6].",
      "Our results suggest that hypoxia may increase the seasonal variability of crustacean zooplankton communities."],
    ["no shared word: opening sentence of the running text", CHUNKS.DOUBEK, "",
      "In freshwater lakes and reservoirs, climate change and eutrophication are increasing the occurrence of low-dissolved oxygen concentrations (hypoxia), which has the potential to alter the variability of zooplankton seasonal dynamics."],
    ["methods sentence under a heading", CHUNKS.WANDER,
      "Total forecast uncertainty was quantified from the variance of the 256-member FLARE ensemble [7].",
      "We quantified total forecast uncertainty for each day in the 1- to 35-day forecast horizon using the variance of the 256-member FLARE ensemble."],
    ["extracted sentence breaks ties for an uncited item", CHUNKS.WOOD, "",
      "Temperatures in the hypolimnion ranged from approximately 5 to 15 \u25e6 C in both FCR and BVR during the summer stratification period.",
      "Temperatures in the hypolimnion ranged from approximately 5 to 15 C in both reservoirs."],
    ["chunk with no quotable sentence", CHUNKS.KRUEGER, "SOD was calculated using the change of oxygen [8].", null],
  ];
  for (const [name, f, support, want, retrieval] of pinned) {
    const got = lv.pickVerbatimQuote(passageOf(f), support, retrieval ?? "");
    check(`${name} (${f.docName})`, got === want, `got ${JSON.stringify(got)}`);
    if (got) {
      const problems = quoteProblems(f.text, got);
      check(`${name}: whole sentences, verbatim, no page furniture`, problems.length === 0, problems.join("; "));
    }
  }

  // A claim the caption states: the caption is skipped while running text exists.
  const captionClaim = lv.pickVerbatimQuote(passageOf(CHUNKS.GERLING), "The distribution header sat at 8.5 m depth [1].", "");
  check(
    "figure caption is not quoted while running text exists",
    captionClaim !== null && !/^Fig/.test(captionClaim) && quoteProblems(CHUNKS.GERLING.text, captionClaim).length === 0,
    JSON.stringify(captionClaim)
  );
  const pageBreak = lv.pickVerbatimQuote(passageOf(CHUNKS.WOOD), "The hypolimnion typically became anoxic [2].", "");
  check(
    "a sentence cut by a page break ('… anoxic in C.E. Wood et al.') is never quoted",
    pageBreak !== null && !/Wood et al\.$/.test(pageBreak) && quoteProblems(CHUNKS.WOOD.text, pageBreak).length === 0,
    JSON.stringify(pageBreak)
  );

  // Sweep: every sentence-like piece of every chunk as the citing sentence, plus none.
  let sweeps = 0;
  const sweepProblems: string[] = [];
  for (const [key, f] of Object.entries(CHUNKS)) {
    const pieces = ["", ...f.text.split(/(?<=[.!?])\s+|\n\n/).filter((p) => p.trim().length >= 25)];
    for (const piece of pieces) {
      for (const retrieval of ["", pieces[1] ?? ""]) {
        sweeps += 1;
        const q = lv.pickVerbatimQuote(passageOf(f), `${piece} [1]`, retrieval);
        if (key === "KRUEGER") {
          if (q !== null) sweepProblems.push(`${key}: expected null, got ${JSON.stringify(q)}`);
          continue;
        }
        if (q === null) {
          sweepProblems.push(`${key}: null for ${JSON.stringify(piece.slice(0, 60))}`);
          continue;
        }
        for (const p of quoteProblems(f.text, q)) sweepProblems.push(`${key}: ${p} :: ${JSON.stringify(q.slice(0, 80))}`);
      }
    }
  }
  check(`sweep: ${sweeps} quotations all whole-sentence, verbatim, within the cap`, sweepProblems.length === 0, sweepProblems.slice(0, 5).join(" | "));

  // citingSentences: single and grouped markers; a marker after the full stop stays.
  const response = "Anoxia develops each summer [2]. Both systems differ [2, 3]. Oxygen fell sharply. [3]\n- A bullet without a stop [1]";
  check(
    "citingSentences keeps grouped and trailing markers with their sentence",
    lv.citingSentences(response, 3) === "Both systems differ [2, 3]. Oxygen fell sharply. [3]" &&
      lv.citingSentences(response, 1) === "- A bullet without a stop [1]" &&
      lv.citingSentences(response, 9) === "",
    JSON.stringify([lv.citingSentences(response, 3), lv.citingSentences(response, 1)])
  );

  // clipPassage: whole sentences inside the cap, starting at running text.
  const clipProblems: string[] = [];
  for (const f of [CHUNKS.DOUBEK, CHUNKS.HOWARD, CHUNKS.GERLING, CHUNKS.WOOD, CHUNKS.LEWIS_SUMMARY]) {
    const passage = passageOf(f);
    if (lv.clipPassage(passage, lv.LITERATURE_ITEM_CHAR_CAP) !== passage) clipProblems.push(`${f.docName}: not whole at the packet cap`);
    for (const cap of [1_800, 1_200, 800, 500, 300]) {
      const clip = lv.clipPassage(passage, cap);
      if (passage.length <= cap) {
        if (clip !== passage) clipProblems.push(`${f.docName}@${cap}: not whole although it fits`);
        continue;
      }
      if (clip.length > cap) clipProblems.push(`${f.docName}@${cap}: ${clip.length} chars`);
      if (!passage.includes(clip)) clipProblems.push(`${f.docName}@${cap}: not a substring`);
      if (!/[.!?]["'”’)\]]*$/.test(clip)) clipProblems.push(`${f.docName}@${cap}: ends mid-sentence`);
      if (FURNITURE_START.some((re) => re.test(clip))) clipProblems.push(`${f.docName}@${cap}: starts with page furniture`);
    }
  }
  check("clipPassage: whole when it fits; otherwise whole sentences from running text", clipProblems.length === 0, clipProblems.slice(0, 4).join(" | "));

  // 2. Budget
  console.log("\n[budget] records whole, literature trimmed first");
  const { budgetEvidenceContext, EVIDENCE_CONTEXT_CHAR_LIMIT, LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT } = budgetMod;
  check(
    "limits: 8,000 with the switch off, 20,000 with it on",
    LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT === 8_000 && EVIDENCE_CONTEXT_CHAR_LIMIT >= 16_000 && EVIDENCE_CONTEXT_CHAR_LIMIT <= 20_000,
    `${LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT}/${EVIDENCE_CONTEXT_CHAR_LIMIT}`
  );
  const worstLiterature = lv.attachVerbatimPassages(
    [
      literature(CHUNKS.DOUBEK, 1, "Hypoxia may increase seasonal zooplankton variability."),
      literature(CHUNKS.HOWARD, 2, "Simple data-driven models can forecast DOM."),
      literature(CHUNKS.DOUBEK, 3, "Zooplankton variability rose after the onset of hypoxia.", "Doubek2019b_Water.pdf"),
      literature(CHUNKS.HOWARD, 4, "Baseline models can outperform process models.", "Howard2026b_JGRBiogeosciences.pdf"),
      literature(CHUNKS.GERLING, 5, "The SSS added oxygen at 25 kg/d."),
      literature(CHUNKS.LEWIS_SUMMARY, 6, "Low oxygen decreased sediment carbon over weeks."),
      literature(CHUNKS.LEWIS_STAMP, 7, "Oxic conditions favour Fe-OC complexes."),
      literature(CHUNKS.WOOD, 8, "Both reservoirs became anoxic each summer."),
    ],
    "on"
  );
  // Literature first, as in tool/ when literature scores high.
  const worst = [...worstLiterature, ...RECORDS];
  const worstBudget = budgetEvidenceContext(worst, "on");
  const recordProblems = (b: ReturnType<typeof budgetEvidenceContext>, evidence: LeadsEvidence[]) =>
    evidence.flatMap((item, i) => {
      if (item.channel === "literature") return [];
      const out: string[] = [];
      if (b.bodies[i] !== item.text) out.push(`${item.id}: body changed`);
      const occurrences = b.context.split(`\n${item.text}`).length - 1;
      if (occurrences !== 1) out.push(`${item.id}: found ${occurrences} times whole in the packet`);
      return out;
    });
  const recordsWhole = recordProblems(worstBudget, worst);
  check(
    `worst case (${worst.length} items): every non-literature record is in the packet whole`,
    recordsWhole.length === 0,
    recordsWhole.join("; ")
  );
  check(
    "worst case: window summary and peak line of every forecast card survive",
    RECORDS.filter((r) => r.text.includes("Window summary:")).every(
      (r) => worstBudget.context.includes(r.text.slice(r.text.indexOf("Window summary:")))
    )
  );
  check(
    `worst case: packet fits the limit (${worstBudget.chars} <= ${EVIDENCE_CONTEXT_CHAR_LIMIT}) by trimming literature`,
    worstBudget.chars <= EVIDENCE_CONTEXT_CHAR_LIMIT &&
      worstBudget.chars === worstBudget.context.length &&
      !worstBudget.overLimit &&
      !worstBudget.truncated &&
      worstBudget.literatureTrimmed > 0 &&
      (worstBudget.literatureCap ?? 0) < lv.LITERATURE_ITEM_CHAR_CAP,
    `chars=${worstBudget.chars} cap=${worstBudget.literatureCap} trimmed=${worstBudget.literatureTrimmed}`
  );
  const trimmedBodies = worst.flatMap((item, i) => {
    if (item.channel !== "literature") return [];
    const body = worstBudget.bodies[i];
    const problems: string[] = [];
    if (!item.verbatimText?.includes(body)) problems.push(`${item.id}: not a substring of its passage`);
    if (body.length > (worstBudget.literatureCap ?? 0)) problems.push(`${item.id}: ${body.length} chars`);
    if (body !== item.verbatimText && !/[.!?]["'”’)\]]*$/.test(body)) problems.push(`${item.id}: ends mid-sentence`);
    return problems;
  });
  check("worst case: trimmed passages are verbatim, within the cap, and end on a sentence", trimmedBodies.length === 0, trimmedBodies.join("; "));
  check(
    "worst case: a flat 8,000-char cut would cut records (the case this budget exists for)",
    budgetEvidenceContext(worst, "off").truncated &&
      !budgetEvidenceContext(worst, "off").context.includes(RECORDS[RECORDS.length - 1].text)
  );

  const hugeCard = record("forecast", "forecast:huge", "FLARE FCRE DO_mgL_mean", forecastCard("FCRE", "DO_mgL_mean", 260));
  const extreme = [...worstLiterature, hugeCard, ...RECORDS];
  const extremeBudget = budgetEvidenceContext(extreme, "on");
  check(
    `records alone over the limit (${hugeCard.text.length}-char card): reported over the limit, nothing cut`,
    hugeCard.text.length > EVIDENCE_CONTEXT_CHAR_LIMIT &&
      extremeBudget.overLimit &&
      recordProblems(extremeBudget, extreme).length === 0 &&
      extremeBudget.literatureCap === budgetMod.LITERATURE_TRIM_CAPS[budgetMod.LITERATURE_TRIM_CAPS.length - 1],
    `overLimit=${extremeBudget.overLimit} cap=${extremeBudget.literatureCap}`
  );

  const typical = [
    ...lv.attachVerbatimPassages(
      [
        literature(CHUNKS.GERLING, 1, "The SSS added oxygen at 25 kg/d."),
        literature(CHUNKS.WOOD, 2, "Both reservoirs became anoxic each summer."),
        literature(CHUNKS.DOUBEK, 3, "Hypoxia may increase seasonal zooplankton variability."),
      ],
      "on"
    ),
    RECORDS[0],
    RECORDS[4],
    RECORDS[7],
    RECORDS[8],
  ];
  const typicalBudget = budgetEvidenceContext(typical, "on");
  check(
    "typical packet: each passage is carried whole (no trimming)",
    typicalBudget.literatureTrimmed === 0 &&
      typical.every((item, i) => item.channel !== "literature" || typicalBudget.bodies[i] === item.verbatimText) &&
      typical.every((item) => item.channel !== "literature" || typicalBudget.context.includes(item.verbatimText ?? "\u0000")),
    `trimmed=${typicalBudget.literatureTrimmed}`
  );
  const compactNote = `[SCOPE: "our study"/"we" here means ${CHUNKS.DOUBEK.docName} only;`;
  const noteLine = typicalBudget.context.split("\n").find((line) => line.startsWith(compactNote)) ?? "";
  check(
    "SCOPE note: short form on a passage with 'we sampled', counted in the packet size",
    noteLine.length > 0 &&
      noteLine.length < 200 &&
      !typicalBudget.context.includes("and to NO other source") &&
      typicalBudget.chars === typicalBudget.context.length,
    `note=${JSON.stringify(noteLine)}`
  );

  // 3. Verifier
  console.log("\n[verifier] judges the text the model read");
  const longPassage = passageOf(CHUNKS.DOUBEK);
  const lateSentence = "Our results suggest that hypoxia may increase the seasonal variability of crustacean zooplankton communities.";
  check("fixture: the supporting sentence sits beyond char 500", longPassage.indexOf(lateSentence) > 500, String(longPassage.indexOf(lateSentence)));
  check(
    "formatVerifierSources: default cut is 500 chars; sourceCharCap shows the whole passage",
    DEFAULT_SOURCE_CHAR_CAP === 500 &&
      formatVerifierSources([longPassage]) === `Sources:\n[0] ${longPassage.slice(0, 500)}` &&
      formatVerifierSources([longPassage], lv.LITERATURE_ITEM_CHAR_CAP) === `Sources:\n[0] ${longPassage}` &&
      formatVerifierSources([longPassage], Number.NaN) === formatVerifierSources([longPassage])
  );
  verifierReply = JSON.stringify([{ text: "Hypoxia may increase zooplankton variability.", supported: true, sourceIndex: 0, confidence: 0.9 }]);
  let mark = chatRequests.length;
  await verifyClaims("Hypoxia may increase zooplankton variability [1].", [longPassage]);
  const defaultCall = chatRequests.slice(mark).find((r) => r.system.startsWith("You are a faithfulness verifier"));
  mark = chatRequests.length;
  const capped = await verifyClaims("Hypoxia may increase zooplankton variability [1].", [longPassage], { sourceCharCap: lv.LITERATURE_ITEM_CHAR_CAP });
  const cappedCall = chatRequests.slice(mark).find((r) => r.system.startsWith("You are a faithfulness verifier"));
  check(
    "verifyClaims without options sends the first 500 chars only",
    !!defaultCall && defaultCall.user.includes(`[0] ${longPassage.slice(0, 500)}`) && !defaultCall.user.includes(lateSentence)
  );
  check(
    "verifyClaims with sourceCharCap sends text beyond char 500",
    !!cappedCall && cappedCall.user.includes(lateSentence) && capped.claims.length === 1 && capped.claims[0].supported
  );

  // Evidence for the verifier, off/on and end-to-end sections: literature first (as
  // retrieval returns it with the switch off), then records.
  const QUERY = "What do the papers report about hypolimnetic oxygen and zooplankton in these reservoirs?";
  const baseLiterature = [
    literature(CHUNKS.GERLING, 1, "The SSS oxygenation system added 25 kg/d of oxygen to the hypolimnion."),
    literature(CHUNKS.WOOD, 2, "Both reservoirs experienced seasonal hypolimnetic anoxia during stratification."),
    literature(CHUNKS.DOUBEK, 3, "Hypoxia was associated with more variable zooplankton communities in our study."),
    literature(CHUNKS.KRUEGER, 4, "Sediment oxygen demand was calculated from the change in oxygen."),
  ];
  const offEvidence = [...baseLiterature, RECORDS[4], RECORDS[7]];
  const onEvidence = [...lv.attachVerbatimPassages(baseLiterature, "on"), RECORDS[4], RECORDS[7]];
  const doubekSlot = 3;
  const verifierAnswer = `Hypoxia may increase the seasonal variability of crustacean zooplankton communities [${doubekSlot}].`;

  mark = chatRequests.length;
  const onVerification = await assessClaimSupport({
    query: QUERY,
    answer: verifierAnswer,
    evidence: onEvidence,
    requestedChannels: ["literature", "forecast", "sensor"],
    litVerbatim: "on",
  });
  const onVerifierCall = chatRequests.slice(mark).find((r) => r.system.startsWith("You are a faithfulness verifier"));
  const onSources = verifierSources(onEvidence, [doubekSlot - 1, 0, 1, 3, 4, 5], "on");
  const onBudget = budgetEvidenceContext(onEvidence, "on");
  check(
    "assessClaimSupport (on): the verifier gets the packet text, beyond char 500",
    !!onVerifierCall &&
      onVerifierCall.user.includes(formatVerifierSources(onSources.sources, lv.LITERATURE_ITEM_CHAR_CAP)) &&
      onVerifierCall.user.includes(lateSentence) &&
      onSources.sources[0] === onBudget.bodies[doubekSlot - 1] &&
      onSources.sourceCharCap === lv.LITERATURE_ITEM_CHAR_CAP,
    onVerifierCall ? onVerifierCall.user.slice(0, 200) : "no verifier request"
  );
  check(
    "assessClaimSupport (on): the supported claim maps back to its evidence slot",
    onVerification.supported === 1 && onVerification.claims[0]?.bracketNum === doubekSlot,
    JSON.stringify(onVerification.claims)
  );

  // 4. Flags
  console.log("\n[flags] defaults and recording");
  const flagCases: Array<[string | undefined, string]> = [
    [undefined, "on"], ["", "on"], ["  ", "on"], ["on", "on"], ["ON", "on"], ["yes", "on"],
    ["off", "off"], [" Off ", "off"], ["0", "off"], ["false", "off"], ["no", "off"],
  ];
  for (const [raw, want] of flagCases) {
    if (raw === undefined) delete process.env.LEADS_LIT_VERBATIM;
    else process.env.LEADS_LIT_VERBATIM = raw;
    const got = lv.litVerbatimMode();
    check(`LEADS_LIT_VERBATIM ${raw === undefined ? "unset" : JSON.stringify(raw)} -> ${want}`, got === want, `got ${got}`);
  }
  delete process.env.LEADS_LIT_VERBATIM;

  const orchestratorSrc = readFileSync(join(__dirname, "..", "lib", "leads", "orchestrator.ts"), "utf8");
  check(
    "orchestrator: one mode per request, passed to retrieval, verifier, cache key and done event",
    (orchestratorSrc.match(/litVerbatim: literatureLitVerbatim/g) ?? []).length >= 6 &&
      orchestratorSrc.includes("buildCacheKey(query, plan.channels, literatureRaptorMode, literatureLitVerbatim")
  );

  const q = "What drives hypolimnetic oxygen depletion in Falling Creek Reservoir?";
  const djb2 = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(36);
  };
  const cacheSrc = readFileSync(join(__dirname, "..", "lib", "leads", "query-cache.ts"), "utf8");
  const tag = /const CACHE_PIPELINE_TAG = "([^"]+)"/.exec(cacheSrc)?.[1];
  const norm = q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  check(
    "cache key differs by mode (literature and sensor + literature)",
    buildCacheKey(q, ["literature"], "off", "on") !== buildCacheKey(q, ["literature"], "off", "off") &&
      buildCacheKey(q, ["sensor", "literature"], "legacy", "on") !== buildCacheKey(q, ["sensor", "literature"], "legacy", "off")
  );
  check(
    "cache key: \"off\" adds nothing to the key",
    Boolean(tag) &&
      buildCacheKey(q, ["literature"], "off", "off", "off") === `leads:qcache:${djb2(`${tag}|raptor:off|${norm}`)}` &&
      buildCacheKey(q, ["literature"], "legacy", "off", "off") === `leads:qcache:${djb2(`${tag}|${norm}`)}`
  );
  delete process.env.LEADS_LIT_VERBATIM;
  const keyUnset = buildCacheKey(q, ["literature"], "off");
  process.env.LEADS_LIT_VERBATIM = "off";
  const keyOff = buildCacheKey(q, ["literature"], "off");
  delete process.env.LEADS_LIT_VERBATIM;
  check(
    "cache key follows the variable when no mode is passed",
    keyUnset === buildCacheKey(q, ["literature"], "off", "on") && keyOff === buildCacheKey(q, ["literature"], "off", "off")
  );

  // The retrieved set and its order do not depend on the mode.
  const withPassages = fuseEvidence({ sensor: [RECORDS[7], RECORDS[8]], literature: onEvidence.slice(0, 4), forecast: [RECORDS[4]] });
  const withoutPassages = fuseEvidence({ sensor: [RECORDS[7], RECORDS[8]], literature: offEvidence.slice(0, 4), forecast: [RECORDS[4]] });
  check(
    "fusion: same evidence ids, order and scores with or without verbatim passages",
    JSON.stringify(withPassages.evidence.map((e) => [e.id, e.score])) === JSON.stringify(withoutPassages.evidence.map((e) => [e.id, e.score]))
  );
  const summaryNode: LeadsEvidence = { ...literature(CHUNKS.WANDER, 9, "A summary sentence."), provenance: { ...literature(CHUNKS.WANDER, 9, "x").provenance, raptorLevel: 2 } };
  const attached = lv.attachVerbatimPassages([summaryNode, RECORDS[7], baseLiterature[0]], "on");
  check(
    "attachVerbatimPassages: verbatim chunks only (not summary nodes or records); off returns the input",
    attached[0].verbatimText === undefined &&
      attached[1].verbatimText === undefined &&
      attached[2].verbatimText === lv.verbatimPassage(CHUNKS.GERLING.text) &&
      lv.attachVerbatimPassages(baseLiterature, "off") === baseLiterature
  );

  // 5. Off
  console.log("\n[off] unchanged when the switch is off");
  process.env.LEADS_LIT_VERBATIM = "off";
  const bigOff = [...offEvidence, ...RECORDS];
  for (const [name, evidence] of [["short packet", offEvidence], ["packet over 8,000 chars", bigOff], ["passages attached but switch off", onEvidence]] as const) {
    check(`${name}: literature packet identical`, evidenceToPromptContext(evidence) === legacyEvidenceToPromptContext(evidence));
    check(`${name}: synthesis evidence block identical`, budgetEvidenceContext(evidence, "off").context === legacyEvidenceBlock(evidence));
    check(`${name}: budget follows the variable`, budgetEvidenceContext(evidence).context === legacyEvidenceBlock(evidence));
  }
  delete process.env.LEADS_GEN_API_KEY; // no chat key: the no-model answer
  const offAnswer = await generateGroundedAnswer(QUERY, onEvidence, 0.5, ["fcr"]);
  process.env.LEADS_GEN_API_KEY = "offline-check";
  check(
    "fallback answer text identical",
    offAnswer.response === `LEADS fallback answer for: ${QUERY}\n\n${legacyFormatFallbackEvidence(onEvidence)}`
  );
  check(
    "citations identical (same keys, same values, no modelText or verbatim)",
    JSON.stringify(offAnswer.citations) === JSON.stringify(legacyToCitations(offAnswer.response, onEvidence)),
    JSON.stringify(offAnswer.citations[0])
  );
  const offAbstention = generateAbstentionAnswer(QUERY, onEvidence, 2);
  check(
    "abstention text and citations identical",
    offAbstention.response.endsWith(legacyFormatFallbackEvidence(onEvidence)) &&
      JSON.stringify(offAbstention.citations) === JSON.stringify(legacyToCitations(offAbstention.response, onEvidence))
  );
  mark = chatRequests.length;
  await assessClaimSupport({ query: QUERY, answer: verifierAnswer, evidence: offEvidence, requestedChannels: ["literature"] });
  const offVerifierCall = chatRequests.slice(mark).find((r) => r.system.startsWith("You are a faithfulness verifier"));
  const offIndices = [doubekSlot - 1, 0, 1, 3, 4, 5];
  check(
    "verifier input identical (item.text, 500-char cut)",
    !!offVerifierCall &&
      offVerifierCall.user === `Answer:\n${verifierAnswer}\n\n${legacySourcesBlock(offIndices.map((i) => offEvidence[i].text))}` &&
      verifierSources(offEvidence, offIndices).sourceCharCap === undefined,
    offVerifierCall?.user.slice(0, 160)
  );
  delete process.env.LEADS_LIT_VERBATIM;

  // 6. On, end to end
  console.log("\n[on] synthesis prompt, citations and quotations");
  delete process.env.LEADS_LIT_VERBATIM;
  process.env.OPENAI_API_KEY = "offline-check";
  synthesisReply =
    "Both reservoirs develop seasonal hypolimnetic anoxia during summer stratification [2]. " +
    "The SSS added oxygen to the hypolimnion at 25 kg/d with a pump flow of 227 LPM [1]. " +
    "Hypoxia may increase the seasonal variability of crustacean zooplankton communities [3]. " +
    "Sediment oxygen demand was calculated from the change in oxygen [4]. " +
    "The ensemble mean stays above the decision limit through the window [5], and recent readings sit within the seasonal range [6].";
  mark = chatRequests.length;
  const { value: onAnswer, logged } = await captureLogs(() => generateGroundedAnswer(QUERY, onEvidence, 0.5, ["fcr"]));
  delete process.env.OPENAI_API_KEY;
  const synthesisCall = chatRequests.slice(mark).find((r) => r.system.startsWith("You are LEADS"));
  const prompt = synthesisCall?.user ?? "";
  check(
    "synthesis prompt carries every literature passage whole",
    onEvidence.every((item) => item.channel !== "literature" || (item.verbatimText && prompt.includes(item.verbatimText)))
  );
  check(
    "synthesis prompt carries every record whole and is not cut",
    onEvidence.every((item) => item.channel === "literature" || prompt.includes(`\n${item.text}`)) &&
      !prompt.includes("[evidence truncated for brevity]")
  );
  check(
    "extra prompt size is logged",
    logged.some((line) => line.startsWith("[evidence-budget] lit_verbatim=on") && /vs lit_verbatim=off/.test(line)),
    logged.join(" | ")
  );
  const c = onAnswer.citations;
  const expectedQuotes = [
    "During both activation periods, the SSS was operated to add oxygen to the hypolimnion at 25 kg/d with a pump flow rate set at 227 LPM.",
    "Over the six years of data, both FCR and BVR experienced seasonal hypolimnetic anoxia as a result of summer thermal stratification (defined as DO concentrations less than 0 mg/L).",
    lateSentence,
  ];
  expectedQuotes.forEach((want, i) => {
    check(
      `[${i + 1}] prints the sentence supporting the answer sentence that cites it`,
      c[i].text === want && c[i].verbatim === true && quoteProblems(baseLiterature[i].fullText ?? "", c[i].text).length === 0,
      JSON.stringify(c[i].text)
    );
  });
  check(
    "[4] chunk with no quotable sentence: its opening text, copied not reworded, flagged not verbatim",
    c[3].text === lv.collapseWhitespace(CHUNKS.KRUEGER.text) && c[3].text !== baseLiterature[3].text && c[3].verbatim === false,
    JSON.stringify(c[3].text)
  );
  const longFlat = lv.collapseWhitespace(CHUNKS.HOWARD.text);
  const excerpt = lv.passageExcerpt(CHUNKS.HOWARD.text);
  check(
    "passageExcerpt: at most 600 chars with the mark, a prefix of the passage cut at a word",
    excerpt.length <= lv.LITERATURE_QUOTE_CHAR_CAP && excerpt.endsWith("…") && longFlat.startsWith(excerpt.slice(0, -1)) &&
      longFlat[excerpt.length - 1] === " ",
    `${excerpt.length} ${JSON.stringify(excerpt.slice(-30))}`
  );
  check(
    "literature modelText is the passage the model read; fullText unchanged",
    [0, 1, 2, 3].every((i) => c[i].modelText === onEvidence[i].verbatimText && c[i].fullText === baseLiterature[i].fullText) &&
      [0, 1, 2].every((i) => (c[i].modelText ?? "").includes(c[i].text))
  );
  check(
    "records: text unchanged, modelText equals it, no verbatim flag",
    [4, 5].every((i) => c[i].text === onEvidence[i].text && c[i].modelText === onEvidence[i].text && c[i].verbatim === undefined)
  );
  const modelContexts = c.map((x) => x.modelText ?? x.text ?? x.fullText ?? "");
  check(
    "evaluation model contexts equal the packet bodies, in order",
    JSON.stringify(modelContexts) === JSON.stringify(budgetEvidenceContext(onEvidence, "on").bodies)
  );
  check("every cited slot flagged cited", c.every((x) => x.citedInAnswer === true));

  const onAbstention = generateAbstentionAnswer(QUERY, onEvidence, 2);
  const abstentionQuote = onAbstention.citations[0];
  check(
    "abstention excerpt (on) is a quotation from the passage, not the extracted claim",
    !onAbstention.response.includes(baseLiterature[0].text) &&
      abstentionQuote.verbatim === true &&
      onAbstention.response.includes(abstentionQuote.text) &&
      quoteProblems(CHUNKS.GERLING.text, abstentionQuote.text).length === 0,
    JSON.stringify(abstentionQuote.text)
  );

  // Report helpers: whole quotations printed, note only when every excerpt is quoted.
  check(
    "PDF/UI note wording",
    LITERATURE_EXCERPT_NOTE ===
      "Excerpts are verbatim from the indexed text of each paper (PDF extraction may differ slightly from the published article); page numbers are approximate."
  );
  check(
    "note shown only when every literature excerpt is verbatim",
    literatureExcerptNote(c) === null &&
      literatureExcerptNote(c.filter((_, i) => i !== 3)) === LITERATURE_EXCERPT_NOTE &&
      literatureExcerptNote(offAnswer.citations) === null &&
      literatureExcerptNote(c.slice(4)) === null
  );
  const longQuote = { docName: "A.pdf", text: "x".repeat(590), verbatim: true, citedInAnswer: true };
  check(
    "a verbatim quotation is printed whole; other excerpts keep their clip",
    excerptLimit(longQuote, 400) === 590 &&
      excerptLimit({ text: "x".repeat(590) }, 400) === 400 &&
      selectTopEvidence([longQuote], 1)[0].snippet.length === 590 &&
      selectTopEvidence([{ ...longQuote, verbatim: undefined }], 1)[0].snippet.length === 220 &&
      selectTopEvidence([{ ...longQuote, verbatim: undefined }], 1)[0].verbatim === undefined
  );

  check("no request left the process", strayRequests.length === 0, strayRequests.join("; "));
}

main()
  .catch((err) => {
    failures.push(`uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    console.error(err);
  })
  .finally(() => {
    const ok = failures.length === 0;
    console.log(`\n[verbatim-excerpts] ${passed} passed, ${failures.length} failed`);
    console.log(`\n${ok ? "ALL CHECKS PASSED" : "CHECKS FAILED"}\n`);
    process.exit(ok ? 0 : 1);
  });
