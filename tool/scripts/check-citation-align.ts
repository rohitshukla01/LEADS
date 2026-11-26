/**
 * Citation alignment gate (LEADS_CITATION_ALIGN, lib/leads/citation-align.ts).
 *
 *   npx tsx scripts/check-citation-align.ts
 *
 * Offline. No model is called: the verifier result is a fixture, and globalThis.fetch
 * is replaced so any request fails the run.
 *
 * Asserts:
 *  1. Align: a sentence citing [1][2] whose verifier claim is supported by [4] gets [4];
 *     [1] (weak word overlap, not the verifier's match) is removed; [2] (overlap above the
 *     threshold) stays. The same holds for the comma form "[1, 2]".
 *  2. Deterministic: markers on sensor and forecast records are never added or removed; a
 *     sentence citing only records is untouched even when its claim matches literature.
 *  3. Words: aligned text differs from the input only in markers.
 *  4. Guard: a sentence never loses its last marker when the verifier found no alternative.
 *  5. Idempotent, no claims, no literature, off: the input comes back unchanged.
 *  6. Answer: alignAnswerCitations rebuilds citedInAnswer and the quotations from the
 *     aligned text, and returns the answer object itself with "off" or no change.
 *  7. Flags: the tool defaults to on; the query-cache key differs by mode and "off" adds
 *     nothing; the orchestrator aligns once, before Layer 3, streaming, caching and
 *     saving, and reports the mode on the done event.
 *  8. Prompt: rule 7 carries the hedge-and-scope sentence once.
 */
import { readFileSync } from "fs";
import { join } from "path";

import type { LeadsAnswer, LeadsEvidence } from "../lib/leads/types";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `  ::  ${detail}` : ""}`);
  }
}

const ROOT = join(__dirname, "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// No request may leave the process.
const strayRequests: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  strayRequests.push(String(input));
  throw new Error("network disabled in check-citation-align");
}) as typeof fetch;
delete process.env.OPENAI_API_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

// Fixtures
// Literature texts as the answer model saw them, plus two deterministic records.
const SOURCE_TEXT = {
  kurucz:
    "Hypolimnetic oxygenation (HOx) systems are deployed in drinking-water reservoirs to increase dissolved oxygen in the hypolimnion without altering thermal stratification.",
  gerling:
    "Phosphorus, iron and manganese released from anoxic sediments create water-quality problems for drinking-water utilities. Maintaining an oxygenated hypolimnion is paramount for controlling them.",
  munger:
    "Water is withdrawn by a submersible pump at 8.5 m depth and transferred to an oxygen contact chamber, where it is supersaturated before being returned to the reservoir.",
  lewis:
    "Hypolimnetic oxygenation effectively increased dissolved oxygen concentrations throughout the hypolimnion during the stratified period.",
  sensor: "FCRE DO_mgL_mean at 9 m: 1.2 mg/L (2026-09-30).",
  forecast: "FLARE FCRE DO_mgL_mean 9 m: daily mean stays below 2 mg/L over the 7-day window.",
};

function evidenceItem(slot: number, channel: LeadsEvidence["channel"], text: string, docName: string): LeadsEvidence {
  return {
    id: `item-${slot}`,
    channel,
    title: docName,
    text,
    ...(channel === "literature" ? { fullText: text, verbatimText: text } : {}),
    score: 1 - slot / 100,
    provenance: { type: channel, label: docName, docName, pageNum: channel === "literature" ? slot : 0, chunkIndex: slot },
  };
}

const EVIDENCE: LeadsEvidence[] = [
  evidenceItem(1, "literature", SOURCE_TEXT.kurucz, "Kurucz2025_WaterResearch.pdf"),
  evidenceItem(2, "literature", SOURCE_TEXT.gerling, "Gerling2014_WaterResearch.pdf"),
  evidenceItem(3, "literature", SOURCE_TEXT.munger, "Munger2016_WaterResearch.pdf"),
  evidenceItem(4, "literature", SOURCE_TEXT.lewis, "Lewis2024_JGRBiogeosciences.pdf"),
  evidenceItem(5, "sensor", SOURCE_TEXT.sensor, "FCRE DO_mgL_mean"),
  evidenceItem(6, "forecast", SOURCE_TEXT.forecast, "FLARE FCRE DO_mgL_mean"),
];
const SOURCES = EVIDENCE.map((e) => ({ channel: e.channel, text: e.text }));

const LIVE =
  "Literature confirms that this approach effectively raises hypolimnetic DO concentrations and prevents the accumulation of problematic nutrients and metals[1][2].";
const ANSWER = [
  "Activation of the oxygenation system is not indicated by the latest reading[5].",
  "The latest bottom-water reading shows dissolved oxygen of 1.2 mg/L[5].",
  LIVE,
  "The system withdraws water at 8.5 m and passes it through an oxygen contact chamber[3].",
  "Forecast oxygen stays low through the window[6].",
].join(" ");

const CLAIMS = [
  { text: "The latest bottom-water reading shows dissolved oxygen of 1.2 mg/L.", supported: true, bracketNum: 5 },
  { text: "This approach effectively raises hypolimnetic DO concentrations.", supported: true, bracketNum: 4 },
  { text: "This approach prevents the accumulation of problematic nutrients and metals.", supported: false, bracketNum: null },
  { text: "The system withdraws water at 8.5 m through an oxygen contact chamber.", supported: true, bracketNum: 3 },
  // A literature match for a sentence that cites only a forecast record.
  { text: "Forecast oxygen stays low through the window.", supported: true, bracketNum: 4 },
];

const RUN = /\[\s*\d+(?:\s*,\s*\d+)*\s*\](?:[ \t]*\[\s*\d+(?:\s*,\s*\d+)*\s*\])*/g;
const withoutMarkers = (s: string) => s.replace(RUN, "").replace(/\s+/g, "");

async function main(): Promise<void> {
  const ca = await import("../lib/leads/citation-align");
  const lv = await import("../lib/leads/lit-verbatim");
  const { alignCitations, describeCitationAlignment, WEAK_SUPPORT_THRESHOLD } = ca;

  const support = (sentence: string, text: string) => {
    const a = lv.contentTokens(sentence);
    const b = lv.contentTokens(text);
    let n = 0;
    for (const t of a) if (b.has(t)) n += 1;
    return a.size > 0 ? n / a.size : 0;
  };

  // 1. Alignment on the observed sentence
  console.log("\n[1] alignment");
  const s1 = support(LIVE, SOURCE_TEXT.kurucz);
  const s2 = support(LIVE, SOURCE_TEXT.gerling);
  check(`[1] overlap is weak (${s1.toFixed(3)} < ${WEAK_SUPPORT_THRESHOLD})`, s1 < WEAK_SUPPORT_THRESHOLD);
  check(`[2] overlap is not weak (${s2.toFixed(3)} >= ${WEAK_SUPPORT_THRESHOLD})`, s2 >= WEAK_SUPPORT_THRESHOLD);

  const result = alignCitations(ANSWER, CLAIMS, SOURCES, "on");
  const expected = ANSWER.replace("metals[1][2].", "metals[2][4].");
  check("sentence gets [4], loses [1], keeps [2]", result.text === expected, result.text);
  check(
    "one change recorded: sentence 3 +[4] -[1]",
    JSON.stringify(result.changes) === JSON.stringify([{ sentence: 3, added: [4], removed: [1] }]),
    JSON.stringify(result.changes)
  );
  const lines = describeCitationAlignment(result.changes);
  check("log line", lines.length === 1 && lines[0] === "[citation-align] sentence 3: +[4] -[1]", lines.join(" | "));

  const comma = ANSWER.replace("metals[1][2].", "metals [1, 2].");
  const commaResult = alignCitations(comma, CLAIMS, SOURCES, "on");
  check("comma group keeps its form, ascending", commaResult.text === ANSWER.replace("metals[1][2].", "metals [2, 4]."), commaResult.text);

  const gerlingMatch = CLAIMS.map((c, i) => (i === 2 ? { ...c, supported: true, bracketNum: 2 } : c));
  check(
    "a marker that is the verifier's match stays",
    alignCitations(ANSWER, gerlingMatch, SOURCES, "on").text === expected
  );

  // 2. Deterministic records
  console.log("\n[2] deterministic records");
  const sentences = ca.answerSentenceSpans(result.text).map((s) => result.text.slice(s.start, s.end));
  check("record-only sentences unchanged (sensor, sensor, forecast)",
    sentences[0].endsWith("reading[5].") && sentences[1].endsWith("mg/L[5].") && sentences[4].endsWith("window[6]."));
  const mixed =
    "Oxygenation raises concentrations throughout the hypolimnion during stratification, consistent with the latest reading[3][5].";
  const mixedSupport = support(mixed, SOURCE_TEXT.munger);
  const mixedResult = alignCitations(
    mixed,
    [{ text: "Oxygenation raises concentrations throughout the hypolimnion during stratification.", supported: true, bracketNum: 4 }],
    SOURCES,
    "on"
  );
  check(`mixed group: weak literature [3] (${mixedSupport.toFixed(3)}) replaced by [4], sensor [5] kept`,
    mixedResult.text === mixed.replace("[3][5]", "[4][5]"), mixedResult.text);
  const recordWeak = "Zooplankton grazing shifts seasonally in many lakes[5][3].";
  const recordWeakResult = alignCitations(recordWeak, [{ text: "Zooplankton grazing shifts seasonally in many lakes.", supported: false, bracketNum: null }], SOURCES, "on");
  check("a weak literature marker beside a record marker is removed; the record marker stays",
    recordWeakResult.text === "Zooplankton grazing shifts seasonally in many lakes[5].", recordWeakResult.text);
  const toRecord = alignCitations(LIVE, [{ text: "This approach effectively raises hypolimnetic DO concentrations.", supported: true, bracketNum: 5 }], SOURCES, "on");
  check("a verifier match on a record is never added", !/\[5\]/.test(toRecord.text), toRecord.text);

  // 3. Words
  console.log("\n[3] words");
  for (const [name, before, after] of [
    ["live", ANSWER, result.text],
    ["comma", comma, commaResult.text],
    ["mixed", mixed, mixedResult.text],
    ["record beside weak", recordWeak, recordWeakResult.text],
  ] as const) {
    check(`${name}: only markers differ`, withoutMarkers(before) === withoutMarkers(after));
  }
  const spaced = "Oxygenation consistently raises concentrations throughout the hypolimnion [3], during the stratified summer period [4].";
  const spacedResult = alignCitations(
    spaced,
    [{ text: "Oxygenation consistently raises concentrations throughout the hypolimnion during the stratified summer period.", supported: true, bracketNum: 4 }],
    SOURCES,
    "on"
  );
  check(`an emptied group goes with the space before it ([3] overlap ${support(spaced, SOURCE_TEXT.munger).toFixed(3)})`,
    spacedResult.text === "Oxygenation consistently raises concentrations throughout the hypolimnion, during the stratified summer period [4].",
    spacedResult.text);
  check("spaced: only markers differ", withoutMarkers(spaced) === withoutMarkers(spacedResult.text));

  // 4. Last-marker guard
  console.log("\n[4] last marker");
  const unsupported = [{ text: "Zooplankton grazing shifts seasonally in many lakes.", supported: false, bracketNum: null }];
  const single = "Zooplankton grazing shifts seasonally in many lakes[3].";
  check("single weak marker with no alternative stays", alignCitations(single, unsupported, SOURCES, "on").text === single);
  const pair = "Zooplankton grazing shifts seasonally in many lakes[1][3].";
  const pairResult = alignCitations(pair, unsupported, SOURCES, "on");
  check("two weak markers, no alternative: one stays (equal overlap -> the first)",
    pairResult.text === "Zooplankton grazing shifts seasonally in many lakes[1].", pairResult.text);

  // 5. Unchanged inputs
  console.log("\n[5] unchanged inputs");
  for (const [name, text] of [["live", result.text], ["mixed", mixedResult.text], ["pair", pairResult.text]] as const) {
    const claims = name === "live" ? CLAIMS : name === "mixed"
      ? [{ text: "Oxygenation raises concentrations throughout the hypolimnion during stratification.", supported: true, bracketNum: 4 }]
      : unsupported;
    const again = alignCitations(text, claims, SOURCES, "on");
    check(`idempotent (${name})`, again.text === text && again.changes.length === 0, again.text);
  }
  const noClaims = alignCitations(ANSWER, [], SOURCES, "on");
  check("no claims: unchanged", noClaims.text === ANSWER && noClaims.changes.length === 0);
  const recordsOnly = SOURCES.map((s) => ({ ...s, channel: s.channel === "literature" ? ("sensor" as const) : s.channel }));
  const noLit = alignCitations(ANSWER, CLAIMS, recordsOnly, "on");
  check("no literature: unchanged", noLit.text === ANSWER && noLit.changes.length === 0);
  const uncited = "Oxygenation raises concentrations throughout the hypolimnion during stratification.";
  check("uncited sentence: no marker added",
    alignCitations(uncited, [{ text: uncited, supported: true, bracketNum: 4 }], SOURCES, "on").text === uncited);
  const off = alignCitations(ANSWER, CLAIMS, SOURCES, "off");
  check("off: unchanged", off.text === ANSWER && off.changes.length === 0);

  // 6. Answer-level helper
  console.log("\n[6] answer helper");
  const gen = await import("../lib/leads/generator");
  const baseAnswer = (): LeadsAnswer => ({
    response: ANSWER,
    citations: [],
    faithfulness: { pct: 100, cited: 5, total: 5 },
    confidence: { grounding: 1, verifierConfidence: 1, policyAdherence: 1, channelCoverage: 1, overall: 1, iterations: 0 },
  });
  const offAnswer = baseAnswer();
  check("off: the answer object itself", gen.alignAnswerCitations(offAnswer, EVIDENCE, CLAIMS, "off", "on").answer === offAnswer);
  const noChange = baseAnswer();
  check("no change: the answer object itself", gen.alignAnswerCitations(noChange, EVIDENCE, [], "on", "on").answer === noChange);
  for (const litMode of ["off", "on"] as const) {
    const aligned = gen.alignAnswerCitations(baseAnswer(), EVIDENCE, CLAIMS, "on", litMode);
    const cited = aligned.answer.citations.filter((c) => c.citedInAnswer).map((c) => c.bracketNum);
    check(`lit ${litMode}: response aligned`, aligned.answer.response === expected);
    check(`lit ${litMode}: citedInAnswer follows the aligned text`, JSON.stringify(cited) === "[2,3,4,5,6]", JSON.stringify(cited));
    check(`lit ${litMode}: citation-presence score`, aligned.answer.faithfulness.cited === 5 && aligned.answer.faithfulness.total === 5,
      JSON.stringify(aligned.answer.faithfulness));
    if (litMode === "on") {
      const lewis = aligned.answer.citations[3];
      check("lit on: [4] prints a quotation from its passage", lewis.verbatim === true && SOURCE_TEXT.lewis.includes(lewis.text), lewis.text);
    }
  }

  // 7. Flags and wiring
  console.log("\n[7] flags and wiring");
  const modeFor = (value: string | undefined) => {
    if (value === undefined) delete process.env.LEADS_CITATION_ALIGN;
    else process.env.LEADS_CITATION_ALIGN = value;
    return ca.citationAlignMode();
  };
  check("unset, empty or unknown -> on; off/0/false/no -> off",
    modeFor(undefined) === "on" && modeFor("") === "on" && modeFor("yes") === "on" &&
      modeFor("off") === "off" && modeFor("OFF") === "off" && modeFor("0") === "off" && modeFor("false") === "off" && modeFor("no") === "off");
  delete process.env.LEADS_CITATION_ALIGN;

  const { buildCacheKey } = await import("../lib/leads/query-cache");
  const q = "Does hypolimnetic oxygenation control iron and manganese release?";
  const djb2 = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(36);
  };
  const tag = /const CACHE_PIPELINE_TAG = "([^"]+)"/.exec(src("lib/leads/query-cache.ts"))?.[1];
  const norm = q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  check("cache key differs by mode",
    buildCacheKey(q, ["literature"], "off", "on", "on") !== buildCacheKey(q, ["literature"], "off", "on", "off") &&
      buildCacheKey(q, ["sensor", "literature"], "legacy", "off", "on") !== buildCacheKey(q, ["sensor", "literature"], "legacy", "off", "off"));
  check("cache key: \"off\" adds nothing",
    Boolean(tag) &&
      buildCacheKey(q, ["literature"], "off", "on", "off") === `leads:qcache:${djb2(`${tag}|raptor:off|lit:on|${norm}`)}` &&
      buildCacheKey(q, ["literature"], "legacy", "off", "off") === `leads:qcache:${djb2(`${tag}|${norm}`)}`);
  const keyUnset = buildCacheKey(q, ["literature"], "off", "on");
  process.env.LEADS_CITATION_ALIGN = "off";
  const keyOff = buildCacheKey(q, ["literature"], "off", "on");
  delete process.env.LEADS_CITATION_ALIGN;
  check("cache key follows the variable when no mode is passed",
    keyUnset === buildCacheKey(q, ["literature"], "off", "on", "on") && keyOff === buildCacheKey(q, ["literature"], "off", "on", "off"));


  const orch = src("lib/leads/orchestrator.ts");
  const hook = orch.indexOf("alignAnswerCitations(\n");
  const lastIndex = (needle: string) => orch.lastIndexOf(needle);
  check("orchestrator: mode read once and passed to the cache key",
    orch.includes("const literatureCitationAlign = citationAlignMode();") &&
      orch.includes("buildCacheKey(query, plan.channels, literatureRaptorMode, literatureLitVerbatim, literatureCitationAlign)"));
  check("orchestrator: mode on the cache-hit and final done events",
    (orch.match(/citationAlign: literatureCitationAlign,/g) ?? []).length === 2);
  check("orchestrator: both verifier results recorded with the text and evidence they judged",
    (orch.match(/verifiedAnswers\.set\(/g) ?? []).length === 2);
  check("orchestrator: aligned after best-of-N and the conclusion check, before Layer 3, streaming, cache and memory",
    hook > orch.indexOf("// Best-of-N swap") &&
      hook > orch.indexOf("// ── Operational-conclusion guarantee") &&
      hook < orch.indexOf("// ── Layer 3 — post-generation deterministic validation") &&
      hook < lastIndex("chunkTokens(displayText)") &&
      hook < lastIndex("saveHistory(sessionId") &&
      hook < lastIndex("setCachedAnswer(") &&
      orch.includes('if (literatureCitationAlign === "on" && verifiedInput && verifiedInput.response === answer.response)'));

  // 8. Prompt
  console.log("\n[8] prompt");
  const generatorSrc = src("lib/leads/generator.ts");
  const rule7 = generatorSrc.split("\n").find((l) => l.includes("7. EVIDENCE DISCIPLINE")) ?? "";
  const sentence =
    'Do not make a source sound stronger than it is: keep its hedges and scope (for example, \\"helps control\\" must not become \\"prevents\\", and \\"can\\" must not become \\"does\\").';
  check("rule 7 carries the hedge-and-scope sentence", rule7.includes(sentence));
  check("the sentence appears once in the generator", generatorSrc.split(sentence).length === 2);

  check("no network request", strayRequests.length === 0, strayRequests.join(", "));
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(() => {
    console.log(`\n[citation-align] ${passed} passed, ${failures} failed`);
    console.log(failures === 0 ? "ALL CHECKS PASSED" : "CHECKS FAILED");
    process.exit(failures === 0 ? 0 : 1);
  });
