/**
 * Deterministic checks for alias matching (lib/leads/alias-match.ts) and its consumers:
 * the planner (router.ts), the forecast channel's variable fallback (forecast.ts), the
 * literature concept boost (literature.ts) and the Layer-3 answer audit
 * (layer3-validation.ts). No network, no model calls.
 * Run:  npx tsx scripts/check-alias-matching.ts
 *
 * Short aliases must not match as substrings: otherwise "How does …" adds dissolved oxygen
 * ("do" inside "does"), "questions"/"conditions" add conductivity ("ions") and "temporal"
 * adds temperature ("temp"), and in the forecast channel spurious DO rows displace the
 * asked-for variable's per-day rows. "do" is also the English verb, so it names DO only
 * as the abbreviation (see alias-match.ts, rule 4).
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { planLeadsQuery } from "../lib/leads/router";
import { mentionsVariable, variableMentions, variablesMentioned } from "../lib/leads/alias-match";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const DO = "DO_mgL_mean";
const vars = (q: string) => planLeadsQuery(q).variableHints;
const sites = (q: string) => planLeadsQuery(q).siteHints;
const has = (q: string, v: string) => vars(q).includes(v);

// 1. "do" as the verb, or inside another word: no dissolved oxygen
for (const q of [
  "How does surface chlorophyll-a at FCR change this week?",
  "What do the forecasts say about chlorophyll-a at FCR?",
  "How do concentrations of chlorophyll-a change at BVR?",
  "Do levels of chlorophyll-a exceed 20 ug/L at FCR?",
  "Do forecasts show rising bloom risk at FCR?",
  "What should we do at FCR this week about chlorophyll-a?",
  "What should managers do at 9 m?",
  "What should operations staff do at 9 m during a bloom?",
  "What can the utility do at 9 m to reduce manganese?",
  "What can FCR do to reduce manganese?",
  "How did the FLARE forecast do over the last week at FCR?",
  "How well did the FLARE model do at 9 m last month?",
  "What did chlorophyll-a do over the weekend at BVR?",
  "What does the model do at 9 m?",
  "How high do chlorophyll-a concentrations get at FCR in summer?",
  "How low do temperatures drop at FCR in winter?",
  "How deep do cyanobacteria blooms extend at FCR?",
  "Is chlorophyll-a rising at FCR, and do levels exceed 20 µg/L this week?",
  "Will surface chlorophyll-a at FCR exceed 20 µg/L, or do values stay below it?",
  "Chlorophyll-a at FCR — do values exceed 20 µg/L this week?",
  "HOW DO CHLOROPHYLL LEVELS COMPARE TO 20 ug/L AT FCR?",
  "What is the dominant driver of chlorophyll-a blooms at BVR?",
  "Should we dose algaecide at FCR given chlorophyll-a conditions?",
  "Are iron and manganese a problem at FCR, and what can be done about it?",
  "Chlorophyll-a values that do not exceed 20 ug/L at FCR",
  "How often do chlorophyll-a levels exceed 20 ug/L at FCR?",
  "Which variables do you forecast at FCR?",
  "How well do FLARE forecasts perform for surface temperature at FCR?",
  "Do profiles at FCR show a thermocline in May?",
  "What should we DO about the bloom at FCR?",
  "Tell me what the forecasts do when a storm hits FCR",
  "do's and don'ts for bloom management at fcr",
]) {
  check(`no DO: "${q}"`, !has(q, DO), vars(q).join(","));
}

// 2. dissolved oxygen named: DO (mixed case, lower case, capitals, terse)
for (const q of [
  "Is DO at 9 m below 2 mg/L at FCR?",
  "Will hypolimnetic DO fall below 2 mg/L this week?",
  "Compare temperature and DO at FCR.",
  "What DO levels are forecast at FCR?",
  "is do at 9 m below 2 mg/l at fcr",
  "low do in the hypolimnion at fcr",
  "what are the do levels at 9 m",
  "what is do at fcr",
  "is do low at fcr?",
  "how low is do at 9 m",
  "How has do changed at FCR since 2019?",
  "will do fall below 2 at fcr",
  "does do drop below 2 mg/l at fcr this week",
  "do at 9m fcr",
  "do below 2 at fcr?",
  "do < 2 mg/L at FCR?",
  "do trend at fcr",
  "do and chla at bvr",
  "temp and do at fcr",
  "plot do and temp at bvr",
  "fcr do forecast",
  "show me do at fcr",
  "compare do at fcr and bvr",
  "hox effect on do",
  "what drives do at fcr?",
  "can you show do at fcr",
  "do conc at 9m",
  "do forecast for fcr",
  "do forecast next 14 days fcr",
  "do levels at fcr?",
  "FCR DO",
  "DO AT FCR",
  "IS DO LOW AT FCR?",
  "DO?",
  "D.O. at 9 m in FCR",
  "RDO_mgL_9 at FCR today",
  "should we worry about low do at fcr?",
  "can you show me the do at fcr",
  "will the do at 9 m drop below 2 this week",
  "WILL THE DO AT 9 M FALL BELOW 2 MG/L?",
  "will do at bvr drop below 2?",
  "what happens to do after fall turnover at fcr",
  "is manganese release related to do at fcr?",
  "do/temp at fcr",
  "DO/DOC ratio at BVR",
  "do is low at fcr, should we run hox?",
  "can the model predict when do hits zero at 9 m",
  "What is the dissolved oxygen at 9 m in FCR?",
  "Will the hypolimnion at FCR become hypoxic this week?",
  "How does internal loading from anoxic sediments respond to HOx?",
  "How does hypolimnetic oxygenation affect iron at FCR?",
]) {
  check(`DO: "${q}"`, has(q, DO), vars(q).join(","));
}

// 3. chlorophyll questions get chlorophyll only
check('forecast question: "…BVR…, and does its probability … rise?" -> Chla only',
  JSON.stringify(vars("What is the 7-day trajectory of surface chlorophyll-a at BVR in the latest FLARE forecast, and does its probability of exceeding the 20 µg/L bloom threshold rise?")) === JSON.stringify(["Chla_ugL_mean"]));
check('forecast question: "How does the probability that surface chlorophyll-a at FCR exceeds …" -> Chla only',
  JSON.stringify(vars("How does the probability that surface chlorophyll-a at FCR exceeds the 20 µg/L bloom threshold change over the 7-day FLARE forecast?")) === JSON.stringify(["Chla_ugL_mean"]));

// 4. DO saturation phrases that start with "do"
check('"What do satellite images show …" does not add DO saturation',
  !has("What do satellite images show about blooms at FCR?", "DOsat_percent_mean"));
check('"What do saturation index values tell us …" does not add DO saturation',
  !has("What do saturation index values tell us about blooms?", "DOsat_percent_mean"));
check('"DO saturation at FCR" adds DO saturation', has("DO saturation at FCR", "DOsat_percent_mean"));
check('"DO %saturation" adds DO saturation', has("What is DO %saturation at 9 m at FCR?", "DOsat_percent_mean"));

// 5. other short aliases: whole word only (plural or digits allowed), "temp" as a prefix
check('"questions"/"conditions" do not add conductivity',
  !has("What conditions promote blooms, and which questions remain open?", "SpCond_uScm_mean"));
check('"dissolved ions" adds conductivity', has("How do dissolved ions vary at FCR?", "SpCond_uScm_mean"));
check('"implications" does not add conductivity',
  !has("What are the implications of MOMs for CH4 at FCR?", "SpCond_uScm_mean"));
check('"temporal" does not add temperature', !has("What are the temporal trends in chlorophyll-a at FCR?", "Temp_C_mean"));
check('"template"/"attempt" do not add temperature', !has("Use the template to attempt a chlorophyll forecast", "Temp_C_mean"));
for (const q of ["What is the water temp at FCR?", "Are surface temps rising at BVR?", "water temprature at 9 m in BVR",
  "What is the water temperture at FCR today?", "watertemp at fcr", "What is ThermistorTemp_C_surface at FCR?"]) {
  check(`temperature: "${q}"`, has(q, "Temp_C_mean"), vars(q).join(","));
}
check('"blooms" still adds chlorophyll (long alias, substring)', has("What drives blooms at FCR?", "Chla_ugL_mean"));
check('"EXOChla_ugL_1" adds chlorophyll', has("What is EXOChla_ugL_1 at FCR?", "Chla_ugL_mean"));
check('"EXOfDOM_QSU_1" adds fDOM, not DO',
  has("What is EXOfDOM_QSU_1 at FCR?", "fDOM_QSU_mean") && !has("What is EXOfDOM_QSU_1 at FCR?", DO));
check('"EXOBGAPC_RFU_1" adds phycocyanin', has("EXOBGAPC_RFU_1 trend at FCR", "phyco_ugL_mean"));

// 6. sites: whole word for the short codes, digits allowed
check('"FCR" -> fcre', sites("Is DO low at FCR?").includes("fcre"));
check('"FCR\'s" -> fcre', sites("What is FCR's surface temperature?").includes("fcre"));
check('"FCR50" -> fcre', sites("FCR50 surface temperature").includes("fcre"));
check('"BVR50" -> bvre', sites("BVR50 chlorophyll-a").includes("bvre"));
check('"FCRmet"/"FCRcatwalk" -> fcre', sites("FCRmet wind").includes("fcre") && sites("FCRcatwalk temperature").includes("fcre"));
check('"BVRplatform" -> bvre', sites("BVRplatform temperature").includes("bvre"));
check('"Carvins Cove" -> ccre', sites("What is the temperature at Carvins Cove?").includes("ccre"));
check('"accretion" does not name Carvins Cove (ccr)', !sites("How fast is sediment accretion in reservoirs?").includes("ccre"));
check('out-of-scope lake still detected when "ccr" is inside a word',
  planLeadsQuery("How fast is sediment accretion in Lake Tahoe?").outOfScope != null);
check('a named covered site is trusted: "DO at FCR50 vs Lake Sunapee"',
  planLeadsQuery("What's the DO at FCR50 vs Lake Sunapee?").outOfScope == null);

// 7. consumers that match aliases against answer or evidence text
check('forecast fallback: "How does the FLARE forecast look at FCR this week?" names no variable',
  variablesMentioned("How does the FLARE forecast look at FCR this week?").length === 0);
check('literature boost: "random"/"document" are not DO mentions',
  !mentionsVariable("Random forests were used to model chlorophyll blooms. This document reports zooplankton.", DO));
check('literature boost: "Hypolimnetic oxygen fell below 2 mg/L" is a DO mention',
  mentionsVariable("Hypolimnetic oxygen fell below 2 mg/L.", DO));
check('Layer 3: "chlorophyll-a does not exceed 20 µg/L" has no DO mention',
  variableMentions("Surface chlorophyll-a at FCR does not exceed the 20 µg/L threshold this week; no action is needed.", DO).length === 0);
check('Layer 3: "temperatures at FCR do not exceed 25 °C" has no DO mention',
  variableMentions("Surface water temperatures at FCR do not exceed 25 °C over the 7-day window (median 23.1 °C).", DO).length === 0);
check('Layer 3: "DO at 9 m is 7.49 mg/L" has a DO mention',
  variableMentions("DO at 9 m is 7.49 mg/L.", DO).length === 1);

// 8. cost stays linear in text length (a long pasted text must not stall a request)
{
  const long = "what should we do ".repeat(20000); // ~350 KB
  const t0 = performance.now();
  variablesMentioned(long);
  const ms = performance.now() - t0;
  check("350 KB of \"… we do …\" is scanned in under 2 s", ms < 2000, `${ms.toFixed(0)} ms`);
}

// 9. structural guard: alias lists are matched only through alias-match.ts
const allowed = new Set(["lib/leads/config.ts", "lib/leads/alias-match.ts", "lib/leads/router.ts", "lib/leads/literature.ts"]);
const offenders: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "node_modules") walk(path); continue; }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const src = readFileSync(path, "utf8");
    if (/\b(?:VARIABLE_ALIASES|SITE_ALIASES)\b/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")) && !allowed.has(path)) offenders.push(path);
  }
};
for (const dir of ["lib", "app", "components"]) walk(dir);
check("no file outside the allowed modules matches VARIABLE_ALIASES/SITE_ALIASES", offenders.length === 0, offenders.join(", "));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
