/**
 * Generator operating-state rule + PDF source-list order gate.
 *
 *   npx tsx scripts/check-prompt-and-listorder.ts
 *
 * Offline: no network, no model calls, nothing rendered. The system prompt is read
 * from the generator source (its string literals, comments removed), so no client module
 * is imported; the PDF lists are tested through the pure builder the PDF draws from.
 *
 * Asserts:
 *  1. Prompt: rule 10 opens with the unconditional operating-state sentence (no "if" or
 *     "when" clause before it), no activation-only operating-state wording is present, the
 *     activation scope is kept, and the numbered rules are all present once, in order.
 *  2. Generality: rule 10 names no water-quality constituent, site, unit, date or value;
 *     the whole prompt carries no site code, measured value or case-identifier code.
 *  3. List order: for display numbers [1 sensor][2 snapshot][3 sensor][4 sensor]
 *     [5..7 forecast][8 window][9 forecast][10 rule][11 freshness], every list printed in
 *     the brief, full and evaluation modes reads in strictly ascending display number,
 *     and only consecutive numbers from the same source share a heading. A by-source
 *     grouping prints 1, 3, 4, 2, ... for the same input (premise check).
 *  4. Mixed: literature and records interleaved in citation order; each section ascends
 *     on its own, and same-paper passages split where the numbers are not consecutive.
 *  5. Properties: seeded random packets, all modes - ascending, consecutive runs, one
 *     source per heading, maximal runs, no entry lost or duplicated.
 *  6. Edges: unordered input, missing bracketNum (fallback numbering), page union, empty.
 *  7. Wiring: every PDF list in lib/report.ts comes from buildSourceListing and prints
 *     the group's numbers; no by-source Map grouping is present.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { renumberMessageForDisplay } from "../lib/citation-display";
import {
  buildSourceListing, groupConsecutiveSources, splitCitedSources,
  type ReportCitation, type ReportMessage, type SourceListGroup, type SourceListMode,
} from "../lib/report-content";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const ROOT = join(__dirname, "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const MODES: SourceListMode[] = ["brief", "full", "evaluation"];

// 1. Prompt rule
console.log("\n[1] operating-state rule");
const generatorSrc = src("lib/leads/generator.ts");
const start = generatorSrc.indexOf("const LEADS_SYSTEM_PROMPT");
const end = generatorSrc.indexOf("function extractText");
check("system prompt located in lib/leads/generator.ts", start >= 0 && end > start);
/** The prompt as sent: the concatenated string literals, with comment lines removed. */
const prompt = generatorSrc
  .slice(start, end)
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n")
  .match(/"(?:[^"\\\n]|\\.)*"/g)!
  .map((lit) => JSON.parse(lit.replace(/\\'/g, "'")) as string)
  .join("");
check("prompt parsed from its literals", prompt.startsWith("You are LEADS") && prompt.includes("CRITICAL GROUNDING RULES:"));

const RULE_TEXT =
  "LEADS has no record of whether any management system (for example an oxygenation system, mixing or algaecide " +
  "dosing) is running; never infer its operating state or effectiveness from sensor observations alone. " +
  "\"Consistent with\" phrasing is acceptable.";
const rules = prompt.split("\n").filter((l) => /^\d+a?\. /.test(l));
const rule10 = rules.find((l) => l.startsWith("10. ")) ?? "";
check("rule text present exactly once", count(prompt, RULE_TEXT) === 1);
check("rule 10 opens with it (unconditional: no clause before it)",
  rule10.startsWith(`10. VERDICT SCOPE — ${RULE_TEXT}`), rule10.slice(0, 90));
check("no activation-only operating-state wording",
  !prompt.includes("you do not know whether the intervention is currently running") &&
  !prompt.includes("never infer its operating state from the observations"));
check("activation scope kept",
  rule10.includes("your verdict must not claim more than that check evaluated") &&
  rule10.includes("confine the verdict to activation and never recommend continuing, stopping or reducing it") &&
  rule10.includes("'activation is not indicated by this reading'"));
const LABELS = ["1", "2", "3", "4", "5", "6", "7", "7a", "8", "9", "9a", "10", "11", "12"];
check("numbered rules 1-12 (with 7a, 9a) each present once, in order",
  same(rules.map((l) => l.slice(0, l.indexOf("."))), LABELS), rules.map((l) => l.slice(0, l.indexOf("."))).join(","));

// 1b. Answer form and writing rules
console.log("\n[1b] answer form and writing rules");
const rule = (label: string) => rules.find((l) => l.startsWith(`${label}. `)) ?? "";
const rule5 = rule("5"), rule6 = rule("6"), rule9a = rule("9a"), rule12 = rule("12");
check("rule 6 opens verdict-first",
  rule6.startsWith("6. ANSWER STRUCTURE — decision-brief format. Open with a single committal sentence"));
check("rule 6 asks for plain prose paragraphs (no headings, bold labels or lists)",
  rule6.includes("no headings, bold labels, bullet or numbered lists, or tables") &&
  rule6.includes("three or four short paragraphs of plain prose"));
check("rule 6 keeps a plain 'Confidence:' closing line", rule6.includes("a closing line beginning 'Confidence:' (plain text, not bold)") &&
  !rule6.includes("clearly-labeled closing line"));
check("rule 6 keeps every caveat sentence",
  rule6.includes("Preserve every caveat you would otherwise raise") &&
  rule6.includes("never as a freestanding list of unknowns that withdraws the verdict") &&
  rule6.includes("pair any such note with its operational consequence"));
check("rule 6: every paragraph item is conditional on the evidence (no invented threshold, context or skill verdict)",
  rule6.includes("the most recent reading with its date and depth and, where the evidence gives them, the operational threshold it is compared with and its seasonal context") &&
  rule6.includes("shares of ensemble members where the record gives them (rules 9 and 9a)") &&
  rule6.includes("when a forecast skill record is present, its verdict") &&
  rule6.includes("never fill one with a threshold, value or context the evidence does not give") &&
  !rule6.includes("the current reading"));
check("rule 6: no 'supporting sensor and forecast evidence' sentence",
  !rule6.includes("Then give the supporting sensor and forecast evidence."));
check("rule 5: every relied-on packet is cited at least once, under rule 7",
  rule5.includes("must carry its [N] marker at least once, on a sentence it directly supports (rule 7)") &&
  rule5.includes("the deterministic constraint evaluation") && rule5.includes("the forecast skill record") &&
  rule5.includes("the data-recency record"));
check("rule 9a: member shares, never 'probability'/'chance'/'likelihood'",
  rule9a.includes("Report ensemble member shares exactly as the record gives them, with the member count") &&
  rule9a.includes("never call a member share a 'probability', 'chance' or 'likelihood'") &&
  rule9a.includes("report per-day shares per day and never combine them into a share over a window"));
check("rule 9a: skill verdict for the forecast's days, cited, no cherry-picked lead day",
  rule9a.includes("When a FORECAST SKILL RECORD is present, state its verdict for the days the forecast covers in the record's own terms") &&
  rule9a.includes("do not single out individual lead days unless the record's verdict differs between them"));
check("rule 9a: unscored days kept; a value without a member count keeps the record's qualifier",
  rule9a.includes("keep the record's note of any days it does not score") &&
  rule9a.includes("When the record gives no member count (a Gaussian approximation, or values pooled across depths), report the value with the record's own qualifier and do not call it a share of ensemble members."));
check("rule 6: Confidence line cites only its own qualifiers; an unassessable flagged risk is the gap to name",
  rule6.includes("it cites only the packets behind its own qualifiers") &&
  rule6.includes("when the operational framing asks you to flag a risk that no evidence packet can assess, that unassessed risk is the gap to name"));
check("rule 9a: verdict with the forecast as subject; 'skill' only for the record; no skill claim without a skill packet",
  rule9a.includes("with the forecast as the subject (e.g. 'the forecast is more skilful than climatology on each of days 1–N')") &&
  rule9a.includes("Reserve 'skill' and 'skilful' for the skill record's comparison with climatology") &&
  rule9a.includes("When no FORECAST SKILL RECORD packet is present, make no claim that the forecast's skill is known, unknown, untested or unevaluated"));
check("rule 6: a gap already stated earlier is referred back to (gap paragraph and Confidence line), not restated",
  rule6.includes("the most important evidence gap, stated once (when an earlier paragraph already stated that gap, such as a missing skill record, this paragraph and the 'Confidence:' line refer back to it in a few words and do not restate it)"));
check("rule 6: a no-record skill disclosure goes to paragraph 3 (the gap), not the forecast paragraph",
  rule6.includes("its verdict (when the record says no skill record exists, leave that to paragraph 3, where it is the evidence gap)."));
check("rule 12: 'significant', 'significantly' and 'significance' only for a statistical test",
  rule12.includes("Use 'significant', 'significantly' or 'significance' only for a statistical test the evidence reports; otherwise write 'substantial', 'substantially' or 'marked'.") &&
  !rule12.includes("Use 'significantly' only"));
check("rule 9a keeps the no-skill-claim sentence for answers without a skill packet",
  rule9a.includes("When no FORECAST SKILL RECORD packet is present, make no claim that the forecast's skill is known, unknown, untested or unevaluated: the record is simply not among the packets."));
check("rule 12: caveats once where they first apply; each value once",
  rule12.includes("State each caveat once, where it first applies") && rule12.includes("Report each value once"));
check("rule 12: writing style (units, operational threshold, skilful, substantially, no 'as of today', caveats once)",
  rule12.startsWith("12. WRITING STYLE — ") &&
  ["unit", "operational threshold", "'skilful'", "'substantially'", "'as of today'", "State each caveat once"].every((w) => rule12.includes(w)));
check("rules 5, 6, 9a and 12 name no site", ![rule5, rule6, rule9a, rule12].some((r) => /\b(FCRE?|BVRE?|Falling Creek|Beaverdam)\b/i.test(r)));

// 2. Generality
console.log("\n[2] generality");
const CONSTITUENTS = /\b(dissolved oxygen|oxygen|DO|chlorophyll|chl-?a|temperature|iron|manganese|nitrogen|nitrate|ammonium|phosphorus|phosphate|nutrients?|methane|carbon|sulfide|turbidity|conductivity|pH|cyanobacteria)\b/;
const rule10Body = rule10.replace(/^10\. /, "");
const rule12Body = rule12.replace(/^12\. /, "");
check("rule 12 names no water-quality constituent and quotes no number",
  !CONSTITUENTS.test(rule12Body) && !/\d/.test(rule12Body), rule12Body.match(CONSTITUENTS)?.[0] ?? "");
check("rule 10 names no water-quality constituent", !CONSTITUENTS.test(rule10Body), rule10Body.match(CONSTITUENTS)?.[0] ?? "");
check("rule 10 quotes no number, value or date", !/\d/.test(rule10Body));
check("rule 10 names no site", !/\b(FCRE?|BVRE?|Falling Creek|Beaverdam)\b/i.test(rule10Body));
check("prompt carries no site code", !/\b(FCRE?|BVRE?)\b/.test(prompt));
check("prompt carries no measured value with units",
  !/\d\s*(mg\/L|µg\/L|ug\/L|mmol|°C|m depth|\bm\b)/i.test(prompt), prompt.match(/\d\s*(mg\/L|µg\/L|ug\/L|mmol|°C|\bm\b)/i)?.[0] ?? "");
check("prompt carries no case-identifier code (LETTERS-digits)", !/\b[A-Z]{2,5}-\d{1,3}\b/.test(prompt), prompt.match(/\b[A-Z]{2,5}-\d{1,3}\b/)?.[0] ?? "");

// Fixtures
type Kind = "sensor" | "snapshot" | "forecast" | "window" | "rule" | "freshness" | "litA" | "litB" | "litC";
const DOC: Record<Kind, string> = {
  sensor: "FCRE Chla_ugL_mean",
  snapshot: "VERA recency snapshot",
  forecast: "FLARE FCRE Chla_ugL_mean",
  window: "7-day FLARE GLM-AED ensemble (221 members)",
  rule: "LEADS deterministic constraint evaluation",
  freshness: "FLARE forecast freshness",
  litA: "Hammond2023_WaterResearch.pdf",
  litB: "Carey2022_Ecosphere.pdf",
  litC: "Munger2019_LakeReservoirManagement.pdf",
};

/** A message as the pipeline stores it: `pipeline` lists the items in synthesis-prompt
 *  order (bracketNum = slot), `citeOrder` is the order the answer first cites slots in.
 *  The PDF renumbers it for display exactly as lib/report.ts does. */
function displayMessage(pipeline: { kind: Kind; page?: number }[], citeOrder: number[]): ReportMessage {
  const citations: ReportCitation[] = pipeline.map((p, i) => ({
    text: `${p.kind} record ${i + 1}.`,
    docName: DOC[p.kind],
    pageNum: p.page ?? 0,
    bracketNum: i + 1,
    citedInAnswer: citeOrder.includes(i + 1),
  }));
  const raw: ReportMessage = { id: 1, content: citeOrder.map((n) => `Claim [${n}].`).join(" "), citations };
  return renumberMessageForDisplay(raw).message;
}

const heads = (groups: SourceListGroup<{ docName: string }>[]) => groups.map((g) => `${g.nums.map((n) => `[${n}]`).join(" ")} ${g.docName}`);
const printed = (groups: SourceListGroup<unknown>[]) => groups.flatMap((g) => g.nums);
const ascending = (ns: number[]) => ns.every((n, i) => i === 0 || n > ns[i - 1]);

/** Properties every printed list must hold. */
function listProperties(tag: string, groups: SourceListGroup<{ docName: string; bracketNum?: number }>[], want: number[]) {
  const nums = printed(groups);
  check(`${tag}: strictly ascending`, ascending(nums), nums.join(","));
  check(`${tag}: each heading is one run of consecutive numbers`,
    groups.every((g) => g.nums.every((n, i) => i === 0 || n === g.nums[i - 1] + 1)));
  check(`${tag}: each heading is one source, one entry per number`,
    groups.every((g) => g.items.length === g.nums.length && g.items.every((c) => c.docName === g.docName) &&
      g.items.every((c, i) => c.bracketNum === undefined || c.bracketNum === g.nums[i])));
  check(`${tag}: runs are maximal (no split of a consecutive same-source run)`,
    groups.every((g, i) => i === 0 || !(g.docName === groups[i - 1].docName && g.nums[0] === groups[i - 1].nums[groups[i - 1].nums.length - 1] + 1)));
  check(`${tag}: every entry printed once`, same(nums, want), `${nums.join(",")} vs ${want.join(",")}`);
}

/** By-source grouping (one heading per source, in first-seen order, with the heading's
 *  numbers sorted), used as the premise check. */
function bySourceGrouping(list: ReportCitation[]): number[] {
  const groups = new Map<string, ReportCitation[]>();
  for (const c of list) groups.set(c.docName ?? "", [...(groups.get(c.docName ?? "") ?? []), c]);
  return [...groups.values()].flatMap((items) => items.map((c, i) => c.bracketNum ?? i + 1).sort((a, b) => a - b));
}

// 3. Record list
console.log("\n[3] record list: [1 sensor][2 snapshot][3,4 sensor][5..7 forecast][8 window][9 forecast][10 rule][11 freshness]");
{
  // Pipeline order is forecast first (slots 1-7), then records and sensors; three slots
  // stay uncited. The answer cites them so that display numbers come out as specified.
  const pipeline: { kind: Kind }[] = [
    { kind: "window" },    // slot 1: display [8]
    { kind: "forecast" },  // slot 2: display [5]
    { kind: "forecast" },  // slot 3: display [6]
    { kind: "forecast" },  // slot 4: display [7]
    { kind: "forecast" },  // slot 5: display [9]
    { kind: "rule" },      // slot 6: display [10]
    { kind: "freshness" }, // slot 7: display [11]
    { kind: "snapshot" },  // slot 8: display [2]
    { kind: "sensor" },    // slot 9: display [1]
    { kind: "sensor" },    // slot 10: display [3]
    { kind: "sensor" },    // slot 11: display [4]
    { kind: "sensor" },    // slot 12 uncited
    { kind: "litA" },      // slot 13 uncited
    { kind: "litB" },      // slot 14 uncited
  ];
  const m = displayMessage(pipeline, [9, 8, 10, 11, 2, 3, 4, 1, 5, 6, 7]);
  const kindAt = new Map(m.citations!.filter((c) => c.citedInAnswer).map((c) => [c.bracketNum!, c.docName]));
  check("fixture: display numbers carry the specified sources",
    same([...kindAt.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d), [
      DOC.sensor, DOC.snapshot, DOC.sensor, DOC.sensor, DOC.forecast, DOC.forecast, DOC.forecast,
      DOC.window, DOC.forecast, DOC.rule, DOC.freshness,
    ]));
  const { data } = splitCitedSources(m.citations);
  const legacy = bySourceGrouping(data);
  check("premise: by-source grouping prints out of order for this input",
    same(legacy, [1, 3, 4, 2, 5, 6, 7, 9, 8, 10, 11]), legacy.join(","));

  const wantData = [
    `[1] ${DOC.sensor}`, `[2] ${DOC.snapshot}`, `[3] [4] ${DOC.sensor}`, `[5] [6] [7] ${DOC.forecast}`,
    `[8] ${DOC.window}`, `[9] ${DOC.forecast}`, `[10] ${DOC.rule}`, `[11] ${DOC.freshness}`,
  ];
  // Key evidence = the first three cited slots in pipeline order (slots 1, 2, 3 are
  // display 8, 5, 6), printed ascending: [5] [6] forecast, then [8] window.
  const wantKey = [`[5] [6] ${DOC.forecast}`, `[8] ${DOC.window}`];
  for (const mode of MODES) {
    const L = buildSourceListing(m.citations, mode);
    const printsKey = mode !== "evaluation";
    const printsLists = mode !== "brief";
    check(`${mode}: no literature list (none cited)`, L.references.length === 0);
    if (printsLists) {
      check(`${mode}: data headings`, same(heads(L.data), wantData), heads(L.data).join(" | "));
      listProperties(`${mode} data`, L.data, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } else {
      check(`${mode}: prints no full data list`, L.data.length === 0);
    }
    if (printsKey) {
      check(`${mode}: key-evidence headings`, same(heads(L.keyEvidence), wantKey), heads(L.keyEvidence).join(" | "));
      listProperties(`${mode} key evidence`, L.keyEvidence, [5, 6, 8]);
    } else {
      check(`${mode}: prints no key-evidence extract`, L.keyEvidence.length === 0);
    }
  }

  // Key evidence whose picks are same-source but not consecutive: [1], [3], [4] sensor.
  const m2 = displayMessage(pipeline.slice(8, 12).concat(pipeline.slice(0, 8)), [1, 8, 2, 3]);
  const key2 = buildSourceListing(m2.citations, "brief").keyEvidence;
  check("brief: same source, numbers 1 and 3 adjacent in the list -> separate headings",
    same(heads(key2), [`[1] ${DOC.sensor}`, `[3] [4] ${DOC.sensor}`]), heads(key2).join(" | "));
}

// 4. Literature and records interleaved
console.log("\n[4] mixed literature + records");
{
  // Display: [1 A p3][2 sensor][3 A p5][4 A p7][5 B p2][6 sensor][7 A p9][8 sensor][9 sensor]
  const pipeline: { kind: Kind; page?: number }[] = [
    { kind: "litA", page: 3 }, { kind: "sensor" }, { kind: "litA", page: 5 }, { kind: "litA", page: 7 },
    { kind: "litB", page: 2 }, { kind: "sensor" }, { kind: "litA", page: 9 }, { kind: "sensor" }, { kind: "sensor" },
    { kind: "litC", page: 4 },
  ];
  const m = displayMessage(pipeline, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const mode of ["full", "evaluation"] as SourceListMode[]) {
    const L = buildSourceListing(m.citations, mode);
    check(`${mode}: literature headings`, same(heads(L.references), [
      `[1] ${DOC.litA}`, `[3] [4] ${DOC.litA}`, `[5] ${DOC.litB}`, `[7] ${DOC.litA}`,
    ]), heads(L.references).join(" | "));
    check(`${mode}: page union per heading`, same(L.references.map((g) => g.pages), [[3], [5, 7], [2], [9]]));
    check(`${mode}: data headings`, same(heads(L.data), [`[2] ${DOC.sensor}`, `[6] ${DOC.sensor}`, `[8] [9] ${DOC.sensor}`]),
      heads(L.data).join(" | "));
    listProperties(`${mode} literature`, L.references, [1, 3, 4, 5, 7]);
    listProperties(`${mode} data`, L.data, [2, 6, 8, 9]);
  }
  const key = buildSourceListing(m.citations, "brief").keyEvidence;
  check("brief: key evidence mixes channels in one ascending list",
    same(heads(key), [`[1] ${DOC.litA}`, `[2] ${DOC.sensor}`, `[3] ${DOC.litA}`]), heads(key).join(" | "));
}

// 5. Properties over seeded random packets
console.log("\n[5] seeded random packets (all modes)");
{
  let seed = 20261003;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const kinds = Object.keys(DOC) as Kind[];
  let bad = 0;
  const TRIALS = 400;
  for (let t = 0; t < TRIALS; t++) {
    const n = 1 + Math.floor(rand() * 16);
    // Few distinct sources so that same-source neighbours are common.
    const pool = kinds.slice(0, 2 + Math.floor(rand() * 4));
    const pipeline = Array.from({ length: n }, () => ({ kind: pool[Math.floor(rand() * pool.length)], page: Math.floor(rand() * 4) }));
    const slots = Array.from({ length: n }, (_, i) => i + 1).sort(() => rand() - 0.5);
    const cite = slots.slice(0, Math.max(1, Math.floor(rand() * (n + 1))));
    const m = displayMessage(pipeline, cite);
    const split = splitCitedSources(m.citations);
    for (const mode of MODES) {
      const L = buildSourceListing(m.citations, mode);
      const lists: [SourceListGroup<{ docName: string; bracketNum?: number }>[], number[]][] = [
        [L.references, mode === "brief" ? [] : split.references.map((c) => c.bracketNum!)],
        [L.data, mode === "brief" ? [] : split.data.map((c) => c.bracketNum!)],
        // Key evidence: the first three cited entries in pipeline (array) order.
        [L.keyEvidence, mode === "evaluation" ? [] : m.citations!.filter((c) => c.citedInAnswer).slice(0, 3)
          .map((c) => c.bracketNum!).sort((a, b) => a - b)],
      ];
      for (const [groups, want] of lists) {
        const nums = printed(groups);
        const ok =
          ascending(nums) && same(nums, want) &&
          groups.every((g) => g.nums.every((x, i) => i === 0 || x === g.nums[i - 1] + 1)) &&
          groups.every((g) => g.items.every((c) => c.docName === g.docName)) &&
          groups.every((g, i) => i === 0 || !(g.docName === groups[i - 1].docName && g.nums[0] === groups[i - 1].nums[groups[i - 1].nums.length - 1] + 1));
        if (!ok) bad++;
      }
    }
  }
  check(`${TRIALS} packets x 3 modes: every list ascending, grouped only by consecutive runs, nothing lost`, bad === 0, `${bad} bad`);
}

// 6. Edges
console.log("\n[6] edges");
{
  const c = (docName: string, bracketNum?: number, pageNum?: number): ReportCitation => ({ text: "x", docName, bracketNum, pageNum });
  const unordered = groupConsecutiveSources([c("A", 4), c("A", 2), c("B", 1), c("A", 3)]);
  check("unordered input is ordered before grouping", same(heads(unordered), ["[1] B", "[2] [3] [4] A"]), heads(unordered).join(" | "));
  const noNums = groupConsecutiveSources([c("A"), c("A"), c("B")], 5);
  check("missing bracketNum numbers from fallbackStart + position + 1", same(heads(noNums), ["[6] [7] A", "[8] B"]), heads(noNums).join(" | "));
  const pages = groupConsecutiveSources([c("A.pdf", 1, 7), c("A.pdf", 2, 0), c("A.pdf", 3, 7), c("A.pdf", 4, 2)]);
  check("page union skips 0 and repeats, keeps list order", same(pages.map((g) => g.pages), [[7, 2]]));
  const dup = groupConsecutiveSources([c("A", 2), c("A", 2)]);
  check("a repeated number never joins a run", dup.length === 2);
  check("empty / missing input -> no headings",
    groupConsecutiveSources([]).length === 0 && groupConsecutiveSources(undefined).length === 0 &&
    MODES.every((mo) => { const L = buildSourceListing(undefined, mo); return !L.keyEvidence.length && !L.references.length && !L.data.length; }));
}

// 7. Wiring
console.log("\n[7] wiring (lib/report.ts)");
{
  const report = src("lib/report.ts");
  check("every PDF list comes from buildSourceListing (evaluation sources, key evidence, full appendix)",
    count(report, "buildSourceListing(m.citations, mode)") === 3);
  check("no list is built from splitCitedSources / selectTopEvidence directly",
    !/splitCitedSources\(|selectTopEvidence\(/.test(report));
  check("by-source Map grouping removed", !/groups\.set\(/.test(report) && !/new Map<string, typeof references>/.test(report));
  check("each list heading prints its group's numbers", count(report, 'nums.map((n) => `[${n}]`).join(" ")') === 3);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
