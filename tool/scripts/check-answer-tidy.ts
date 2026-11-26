/**
 * Display-time answer tidy gate (lib/answer-tidy.ts).
 *
 *   npx tsx scripts/check-answer-tidy.ts
 *
 * Offline: no network, no model calls, nothing rendered.
 *
 * Asserts:
 *  1. Order: every run of two or more citation numbers reads ascending without repeats,
 *     in the run's own form; single, non-adjacent and already-sorted runs are untouched.
 *  2. Spelling: skillful/Skillful/skillfully/unskillful/skillfulness become skilful forms;
 *     "skilful", all-caps text and quoted text are left as written; URLs, DOIs and
 *     inline code are verbatim for both the spelling and the citation-order tidy.
 *  2b. Edge counts: "0% (0 of N)" becomes "0 of N" and "100% (N of N)" becomes "N of N" (with any
 *     "ensemble members" noun kept); other percentages, mismatched counts, decimals such as
 *     "2.0%", URLs and banner lines are left as written.
 *  3. Banner: a returned blockquote line matches the input.
 *  4. Only targets: with markers and the skill word normalised away, the text is unchanged;
 *     the tidy is idempotent.
 *  5. Display order (seeded random packets): renumbering the tidied display text is a
 *     no-op, and the cited set, display numbers and uncited count are unchanged.
 *  6. Fixture: an algal-bloom answer (inline example) reads [2][3][4][6] and
 *     "skilful" once renumbered and tidied; its banner is unchanged.
 *  7. Wiring: the answer bubble, claim list and every PDF mode read the tidied text; the
 *     module imports nothing; no server, pipeline or eval module imports it.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { numberCitationsForDisplay, renumberMessageForDisplay } from "../lib/citation-display";
import { ANSWER_TIDY_ENABLED, tidyAnswerText, tidyCitationRuns, tidyMemberCounts, tidySpelling } from "../lib/answer-tidy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const ROOT = join(__dirname, "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check("tidy enabled by default (off switch unset)", ANSWER_TIDY_ENABLED === true);

// 1. Citation order
console.log("\n[1] citation order");
const ORDER: [string, string][] = [
  ["guardrail [6][2][3][4].", "guardrail [2][3][4][6]."],
  ["twice [3][3].", "twice [3]."],
  ["comma [4, 2].", "comma [2, 4]."],
  ["spaced [6] [2].", "spaced [2] [6]."],
  ["mixed [2][4, 3].", "mixed [2, 3, 4]."],
  ["repeat in a group [5, 5, 1].", "repeat in a group [1, 5]."],
  ["tab [9]\t[1]", "tab [1]\t[9]"],
];
for (const [input, want] of ORDER) {
  const got = tidyCitationRuns(input);
  check(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, got === want, got);
}
for (const keep of [
  "single [7] marker.", "apart [6] and later [2].", "sorted [1][3][10][12].", "sorted comma [1, 3, 10]",
  "sorted spaced [2] [5]", "odd spacing [ 2 , 5 ]", "no markers here", "[note] [x]", "",
]) {
  check(`unchanged: ${JSON.stringify(keep)}`, tidyCitationRuns(keep) === keep);
}

// 2. Spelling
console.log("\n[2] spelling");
const SPELL: [string, string][] = [
  ["forecasts are skillful", "forecasts are skilful"],
  ["Skillful at days 1–7", "Skilful at days 1–7"],
  ["it performs skillfully", "it performs skilfully"],
  ["an unskillful forecast", "an unskilful forecast"],
  ["Unskillful leads", "Unskilful leads"],
  ["the skillfulness of FLARE", "the skilfulness of FLARE"],
  ["skillful, skillful.", "skilful, skilful."],
];
for (const [input, want] of SPELL) {
  const got = tidySpelling(input);
  check(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, got === want, got);
}
for (const keep of [
  "already skilful", "SKILLFUL in capitals", "the paper \"Skillful forecasts of lake temperature\" reports",
  "the paper “Skillful forecasts” reports", "skill and full", "",
]) {
  check(`unchanged: ${JSON.stringify(keep)}`, tidySpelling(keep) === keep);
}
// URLs, DOIs and inline code are verbatim for both tidies (a web address or a code
// snippet may contain "skillful" or bracketed numbers that are not citations).
for (const keep of [
  "see https://example.org/skillful-forecasts for details",
  "see www.example.org/Skillful_lakes/index[2][1]",
  "doi:10.1000/skillful[3][1] and DOI:10.1/a[4, 2]",
  "run `x[2][1] = skillful` here",
]) {
  check(`URL / DOI / code kept verbatim: ${JSON.stringify(keep)}`, tidyAnswerText(keep) === keep, tidyAnswerText(keep));
}
check("text around a URL is still tidied",
  tidyAnswerText("skillful runs [2][1] (https://example.org/skillful[2][1]) are skillful [4][3].") ===
  "skilful runs [1][2] (https://example.org/skillful[2][1]) are skilful [3][4].",
  tidyAnswerText("skillful runs [2][1] (https://example.org/skillful[2][1]) are skillful [4][3]."));
check("quoted text kept while unquoted text is fixed",
  tidySpelling("a skillful run, per \"Skillful lake forecasts\" [3]") === "a skilful run, per \"Skillful lake forecasts\" [3]");

// 2b. Ensemble counts at the edge of the ensemble
console.log("\n[2b] edge ensemble counts");
const EDGE: [string, string][] = [
  ["is 0% (0 of 221) on day 1, 20% (44 of 221) on day 3", "is 0 of 221 on day 1, 20% (44 of 221) on day 3"],
  ["0% of ensemble members (0 of 221) project it", "0 of 221 ensemble members project it"],
  ["0% of the ensemble members (0 of 221)", "0 of 221 ensemble members"],
  ["100% (221 of 221 members) on day 2", "221 of 221 members on day 2"],
  ["100% of members (31 of 31)", "31 of 31 members"],
  ["0.0% (0 of 221)", "0 of 221"],
];
for (const [input, want] of EDGE) {
  const got = tidyMemberCounts(input);
  check(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, got === want, got);
}
for (const keep of [
  "10% (0 of 221)", "0% (3 of 221)", "100% (220 of 221)", "2.0% (0 of 9)", "38% (83 of 221)",
  "a 0% change", "see https://example.org/a?0%(0 of 2)", "",
]) {
  check(`unchanged: ${JSON.stringify(keep)}`, tidyMemberCounts(keep) === keep);
}
check("edge counts applied by tidyAnswerText, not on the banner line",
  tidyAnswerText("> P(x) peaks at 0% (0 of 221)\n\nBody 0% (0 of 221) [2][1].") === "> P(x) peaks at 0% (0 of 221)\n\nBody 0 of 221 [1][2].");

// 3. Banner
console.log("\n[3] banner");
{
  const banner = "> **Operational check (LEADS-computed):** skillful [3][1]; P(x > 1) peaks at 60% [2][2].";
  const text = `${banner}\n\nBody skillful [3][1].`;
  const out = tidyAnswerText(text);
  check("banner line matches the input", out.split("\n")[0] === banner);
  check("body below the banner tidied", out.split("\n")[2] === "Body skilful [1][3].", out.split("\n")[2]);
  check("indented blockquote untouched too", tidyAnswerText("  > a [2][1] skillful") === "  > a [2][1] skillful");
  check("missing text -> empty string", tidyAnswerText(null) === "" && tidyAnswerText(undefined) === "");
}

// Seeded generator
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ["Bloom", "risk", "is", "high", "skillful", "forecast", "Skillful", "members", "mg/L", "unskillful", "spread", "\"Skillful title\""];
function randomAnswer(r: () => number, nPackets: number): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const num = () => 1 + Math.floor(r() * nPackets);
  const run = () => {
    const k = 1 + Math.floor(r() * 4);
    const nums = Array.from({ length: k }, num);
    const style = r();
    if (style < 0.25) return `[${nums.join(", ")}]`;
    if (style < 0.4) return nums.map((n) => `[${n}]`).join(" ");
    if (style < 0.5 && k > 1) return `[${nums[0]}][${nums.slice(1).join(", ")}]`;
    return nums.map((n) => `[${n}]`).join("");
  };
  const lines: string[] = [];
  if (r() < 0.5) lines.push(`> **Operational check (LEADS-computed):** skillful ${run()} banner.`, "");
  const nLines = 1 + Math.floor(r() * 4);
  for (let l = 0; l < nLines; l++) {
    const parts: string[] = [];
    const nSent = 1 + Math.floor(r() * 3);
    for (let s = 0; s < nSent; s++) {
      const len = 2 + Math.floor(r() * 6);
      parts.push(Array.from({ length: len }, () => pick(WORDS)).join(" ") + (r() < 0.7 ? ` ${run()}` : "") + ".");
    }
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}

// 4. Only targets change; idempotent
console.log("\n[4] only targets change, idempotent");
{
  const RUN = /\[\s*\d+(?:\s*,\s*\d+)*\s*\](?:[ \t]*\[\s*\d+(?:\s*,\s*\d+)*\s*\])*/g;
  const normalise = (t: string) => t.replace(RUN, "<cite>").replace(/([Ss])kill?ful/g, "$1KILFUL");
  const r = rng(20261016);
  let onlyTargets = true, idempotent = true, firstBad = "";
  for (let i = 0; i < 400; i++) {
    const t = randomAnswer(r, 12);
    const once = tidyAnswerText(t);
    if (normalise(once) !== normalise(t)) { onlyTargets = false; firstBad ||= t; }
    if (tidyAnswerText(once) !== once) { idempotent = false; firstBad ||= t; }
  }
  check("400 random answers: text identical outside markers and the skill word", onlyTargets, firstBad.slice(0, 120));
  check("400 random answers: tidy(tidy(x)) === tidy(x)", idempotent, firstBad.slice(0, 120));
}

// 5. Display order is preserved
console.log("\n[5] display order (seeded random packets)");
{
  interface Packet { bracketNum: number; citedInAnswer: boolean; docName: string; id: string }
  const r = rng(9450891);
  let noop = true, sameCited = true, sortedRuns = true, bad = "";
  for (let i = 0; i < 400; i++) {
    const n = 4 + Math.floor(r() * 14);
    const packets: Packet[] = Array.from({ length: n }, (_, k) => ({ bracketNum: k + 1, citedInAnswer: false, docName: `doc ${k % 5}`, id: `p${k + 1}` }));
    const text = randomAnswer(r, n);
    // Flags as the pipeline sets them (from the stored text), plus a few claim-check matches.
    const inText = new Set([...text.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((x) => x <= n));
    packets.forEach((p) => { p.citedInAnswer = inText.has(p.bracketNum); });
    const alsoCited = Array.from({ length: Math.floor(r() * 3) }, () => 1 + Math.floor(r() * n));
    const view = numberCitationsForDisplay(text, packets, { alsoCited });
    const tidied = tidyAnswerText(view.text);
    const { message, uncitedCount } = renumberMessageForDisplay({ content: text, citations: packets }, { alsoCited });
    const again = numberCitationsForDisplay(tidied, message.citations);
    if (again.text !== tidied) { noop = false; bad ||= `${view.text} || ${tidied} || ${again.text}`; }
    const before = view.cited.map((x) => [x.n, x.citation.id]);
    const after = again.cited.map((x) => [x.n, x.citation.id]);
    if (!same(before, after) || again.uncitedCount !== uncitedCount || view.uncitedCount !== uncitedCount) {
      sameCited = false; bad ||= JSON.stringify({ text, before, after: again.cited.map((x) => x.n), u: [view.uncitedCount, uncitedCount, again.uncitedCount] });
    }
    for (const line of tidied.split("\n")) {
      if (line.trimStart().startsWith(">")) continue;
      for (const m of line.matchAll(/\[\s*\d+(?:\s*,\s*\d+)*\s*\](?:[ \t]*\[\s*\d+(?:\s*,\s*\d+)*\s*\])*/g)) {
        const nums = [...m[0].matchAll(/\d+/g)].map((x) => Number(x[0]));
        if (!nums.every((x, k) => k === 0 || x > nums[k - 1])) { sortedRuns = false; bad ||= line; }
      }
    }
  }
  check("renumbering the tidied display text is a no-op", noop, bad.slice(0, 200));
  check("cited set, each display number's source, and uncited count unchanged", sameCited, bad.slice(0, 200));
  check("every run in the tidied body is strictly ascending", sortedRuns, bad.slice(0, 200));
}

// 6. Fixture: an algal-bloom answer
console.log("\n[6] fixture: algal-bloom answer (inline example)");
{
  // An example displayText (banner + three cited runs + the confidence line) and its
  // citation flags and claim-check matches, by pipeline number.
  const BANNER = "> **Operational check (LEADS-computed):** latest 1.6 m chl-a 24.80 µg/L (2026-07-14) is above the 20 µg/L bloom threshold → bloom control **indicated** on this reading. Forecast: P(chl-a > 20 µg/L) peaks at 88% (194 of 221 members) on day 5 of 7; 81% (179 of 221 members) on day 7.";
  const displayText = [
    BANNER,
    "",
    "The most recent available data (2026-07-14) show surface chlorophyll-a is above the operational bloom threshold, but still within the historical range for this time of year [5][3]. ",
    "",
    "Bloom risk over the next 7 days is high, with daily means rising from 25.1 to 28.6 µg/L [10][12]. Forecast skill is positive at 3 and 7 days [2].",
    "",
    "Algaecide treatment planning is indicated by the operational decision guardrail [1][3][10][12].",
    "",
    "Confidence: High, as sensor data are current (1 day old) and forecasts are skillful at the relevant lead times.",
  ].join("\n");
  const flags: [number, boolean][] = [
    [1, true], [2, true], [3, true], [4, false], [5, true], [6, false], [7, false], [8, false], [9, false], [10, true],
    [11, false], [12, true], [13, false], [14, false], [15, false], [16, false], [17, false], [18, false], [19, false],
  ];
  const citations = flags.map(([bracketNum, citedInAnswer]) => ({ bracketNum, citedInAnswer, docName: `item ${bracketNum}` }));
  const claims = [5, 3, 5, 5, 10, 10, 10, 10, 2, 3, 12, null, 1, 6, 2];
  const view = numberCitationsForDisplay(displayText, citations, { alsoCited: claims });
  check("premise: display renumbering reads [6][2][3][4] before the tidy", view.text.includes("guardrail [6][2][3][4]."));
  const out = tidyAnswerText(view.text);
  check("tidied: [2][3][4][6]", out.includes("guardrail [2][3][4][6].") && !out.includes("[6][2][3][4]"));
  check("tidied: other runs unchanged ([1][2], [3][4], [5])",
    out.includes("time of year [1][2].") && out.includes("µg/L [3][4].") && out.includes("3 and 7 days [5]."));
  check("tidied: 'skilful', not 'skillful'", out.includes("forecasts are skilful at") && !/skillful/i.test(out));
  check("banner unchanged", out.split("\n")[0] === BANNER);
  check("cited sources unchanged (7 cited, 12 not cited)", view.cited.length === 7 && view.uncitedCount === 12,
    `${view.cited.length} cited, ${view.uncitedCount} not`);
  const inline = new Set([...out.matchAll(/\d+(?=[\],])/g)].map((m) => Number(m[0])).filter((x) => x <= 19));
  const tier3 = view.cited.filter((x) => !inline.has(x.n)).map((x) => x.n);
  check("listed-but-uncited count measurable (recency record matched by the claim check only)", same(tier3, [7]), tier3.join(","));
}

// 7. Wiring
console.log("\n[7] wiring");
{
  const lib = src("lib/answer-tidy.ts");
  check("lib/answer-tidy.ts imports nothing", !/^\s*import\s/m.test(lib) && !/require\(/.test(lib));
  check("lib/answer-tidy.ts has the off switch", lib.includes('process.env.NEXT_PUBLIC_LEADS_ANSWER_TIDY !== "false"'));

  const page = src("app/page.tsx");
  check("page.tsx: citationView tidies the displayed text and the claim rewrite",
    page.includes('import { tidyAnswerText } from "@/lib/answer-tidy";') &&
    page.includes("const raw = numberCitationsForDisplay(m.content, m.citations, {") &&
    page.includes("view = { ...raw, text: tidyAnswerText(raw.text), rewrite: (s: string) => tidyAnswerText(raw.rewrite(s)) };"));
  check("page.tsx: the answer bubble still reads the view", page.includes("<AnswerText text={citationView(m).text}"));

  const report = src("lib/report.ts");
  check("report.ts: every PDF mode reads the renumbered, tidied content",
    report.includes('import { tidyAnswerText } from "./answer-tidy";') &&
    report.includes("const { message: shown, uncitedCount } = renumberMessageForDisplay(input.message, {") &&
    report.includes("const m = { ...shown, content: tidyAnswerText(shown.content) };"));

  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir)).flatMap((f) => {
      const rel = join(dir, f);
      return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
    });
  const serverFiles = [...walk("lib/leads"), ...walk("app/api")];
  const importsTidy = /(?:from\s*|import\(\s*|require\(\s*)["'][^"']*answer-tidy["']/;
  const importers = serverFiles.filter((f) => importsTidy.test(src(f)));
  check("no server module imports the answer tidy", importers.length === 0, importers.join(", "));
}

const ok = failures === 0;
console.log(`\n${ok ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(ok ? 0 : 1);
