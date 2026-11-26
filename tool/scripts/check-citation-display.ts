/**
 * Citation display-numbering gate (display only).
 *
 *   npx tsx scripts/check-citation-display.ts
 *
 * Offline: no network, no model calls. The pipeline numbers every retrieved item
 * by its slot in the synthesis prompt, so an answer citing a subset shows markers like
 * [3][9][10] ... [16]. lib/citation-display.ts renumbers the cited items 1..n in order of
 * first appearance for display, and every display path (answer bubble, evidence cards,
 * claim list, all three PDF modes) reads from it. This gate locks:
 *  1. Grouping and first-appearance order - "[3][9][10]" becomes "[1][2][3]", comma groups
 *     keep the comma form, padded markers are normalised.
 *  2. Unknown numbers - a marker naming no citation is left as written;
 *     inside a group only the known numbers change.
 *  3. Repeated markers share one number and one list entry.
 *  4. No markers / no citations - text returned unchanged; while streaming (citations
 *     not yet received) every marker is numbered by first appearance, matching the final
 *     view at every point of the stream.
 *  5. Tier order - text first, then citedInAnswer-only, then verifier-only, then the rest.
 *     The PDF passes the verifier's matches as the screen does, so both count the same
 *     sources as cited; a message stored without claims still prints the same numbers.
 *  6. Banner markers are renumbered with the body, and parseVerdict/stripBanner read the
 *     renumbered text.
 *  7. Saved-message shape - a JSON round-tripped message, citations stored without
 *     bracketNum/citedInAnswer, a message without citations; the input is never mutated.
 *  8. PDF lists - splitCitedSources over the renumbered message reads 1..n in order, the
 *     key-evidence pick is the same sources as before renumbering, and a verifier-matched
 *     source is listed and counted as on screen.
 *  9. Footnote - the count of retrieved-but-uncited sources, singular and zero forms.
 * 10. Idempotence, and parity with the pipeline's canonical marker parser.
 * 11. Wiring - every display path uses the view; no server/eval module imports it.
 * 12. Reader text - evidence cards, PDF lists and no-model answers print records without
 *     the instructions written for the answer model (lib/reader-text.ts).
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  numberCitationsForDisplay, renumberMessageForDisplay, rewriteCitationMarkers, citationNumberingNote,
} from "../lib/citation-display";
import {
  parseVerdict, stripBanner, splitCitedSources, selectTopEvidence,
  type ReportCitation, type ReportMessage,
} from "../lib/report-content";
import { bracketNumbers } from "../lib/leads/citation-brackets";
import { readerText } from "../lib/reader-text";
import { buildSourceListing } from "../lib/report-content";
import { RESERVOIR_DECISION_GUARDRAILS } from "../lib/leads/guardrails";
import { buildForecastSkillNote } from "../lib/skill/forecast-skill";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const ROOT = join(__dirname, "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `total` citations shaped like the pipeline's done-event packet: bracketNum = slot,
 *  citedInAnswer for the numbers in `cited`; odd slots are literature PDFs, even slots
 *  operational records. */
function packet(total: number, cited: number[]): ReportCitation[] {
  return Array.from({ length: total }, (_, i) => ({
    text: `passage ${i + 1}`,
    docName: (i + 1) % 2 ? `Author${2000 + i}_Journal.pdf` : `FLARE FCRE DO_mgL_mean ${i + 1}`,
    pageNum: (i + 1) % 2 ? i + 1 : 0,
    chunkIndex: i,
    bracketNum: i + 1,
    citedInAnswer: cited.includes(i + 1),
  }));
}

// 1. Grouping and first-appearance order
console.log("\n[1] grouping and first-appearance order");
{
  const cites = packet(16, [3, 9, 10, 16]);
  const v = numberCitationsForDisplay("Bloom risk is low [3][9][10]. Mixing persists [16].", cites);
  check("grouped singles [3][9][10] ... [16] -> [1][2][3] ... [4]",
    v.text === "Bloom risk is low [1][2][3]. Mixing persists [4].", v.text);
  check("cited list is 1..4 and maps back to 3, 9, 10, 16",
    same(v.cited.map((x) => [x.n, x.original]), [[1, 3], [2, 9], [3, 10], [4, 16]]));
  const order = numberCitationsForDisplay("A [9]. B [3]. C [9][16].", cites);
  check("numbers follow first appearance, not the pipeline order",
    order.text === "A [1]. B [2]. C [1][3].", order.text);
  const comma = numberCitationsForDisplay("Two sources [9, 3] agree.", cites);
  check("comma group keeps the comma form, numbers mapped in place",
    comma.text === "Two sources [1, 2] agree.", comma.text);
  const padded = numberCitationsForDisplay("Padded [ 10 , 3 ] and [ 9 ].", cites);
  // The renderer's own marker grammar (components/AnswerText.tsx): INLINE finds the chip
  // tokens, BRACKET_GROUP reads the numbers out of one.
  const answerText = src("components/AnswerText.tsx");
  const inlineSrc = answerText.match(/^const INLINE = \/(.+)\/g;$/m)?.[1];
  const groupSrc = answerText.match(/^const BRACKET_GROUP = \/(.+)\/;$/m)?.[1];
  const chips = inlineSrc ? (padded.text.match(new RegExp(inlineSrc, "g")) ?? []) : [];
  check("padded markers are normalised to the form the answer renderer chips",
    padded.text === "Padded [1, 2] and [3]." && !!inlineSrc && !!groupSrc &&
    same(chips, ["[1, 2]", "[3]"]) && chips.every((t) => new RegExp(groupSrc!).test(t)),
    `${padded.text}  chips=${JSON.stringify(chips)}`);
}

// 2. Unknown numbers
console.log("\n[2] unknown numbers");
{
  const cites = packet(16, [3]);
  const t = "Cited [3]; not citations: [99], [0], [ 42 ], (2023) [2023].";
  const v = numberCitationsForDisplay(t, cites);
  check("markers naming no citation are left exactly as written",
    v.text === "Cited [1]; not citations: [99], [0], [ 42 ], (2023) [2023].", v.text);
  const mixed = numberCitationsForDisplay("Mixed [3, 99] group.", cites);
  check("inside a group only the known number changes", mixed.text === "Mixed [1, 99] group.", mixed.text);
  check("displayNumber is null for a number no citation carries",
    v.displayNumber(99) === null && v.displayNumber(0) === null && v.displayNumber(3) === 1);
  const onlyUnknown = "Only unknown [77] and [200].";
  check("text with only unknown markers is returned unchanged",
    numberCitationsForDisplay(onlyUnknown, cites).text === onlyUnknown);
}

// 3. Repeated markers
console.log("\n[3] repeated markers");
{
  const v = numberCitationsForDisplay("First [5]. Again [5]. Twice [5][5].", packet(16, [5]));
  check("a repeated marker keeps one number", v.text === "First [1]. Again [1]. Twice [1][1].", v.text);
  check("and one list entry", v.cited.length === 1 && v.cited[0].original === 5 && v.uncitedCount === 15);
}

// 4. No markers / no citations
console.log("\n[4] no markers, no citations");
{
  const plain = "No inline markers in this answer.";
  const none = numberCitationsForDisplay(plain, packet(16, []));
  check("no markers, nothing flagged: text unchanged, nothing cited, 16 uncited",
    none.text === plain && none.cited.length === 0 && none.uncitedCount === 16);
  check("uncited items keep the pipeline order as their numbers (1..16)",
    same(none.all.map((x) => x.n), Array.from({ length: 16 }, (_, i) => i + 1)));
  const flagged = numberCitationsForDisplay(plain, packet(16, [7, 2]));
  check("no markers, two flagged: numbered by pipeline order (2 -> 1, 7 -> 2)",
    same(flagged.cited.map((x) => [x.n, x.original]), [[1, 2], [2, 7]]) && flagged.text === plain);
  const streaming = numberCitationsForDisplay("Partial answer [3][9", []);
  check("no citations and no assumeKnown: text unchanged",
    streaming.text === "Partial answer [3][9" && streaming.cited.length === 0 && streaming.uncitedCount === 0);
  // While streaming (citations arrive with the final event) every marker number is taken
  // as a citation, so each completed marker already reads its final number.
  const final = "Risk is low [16]. Mixing persists [3][9][10]. Again [9, 3]. Floor [12]. Low [3].";
  const finalText = numberCitationsForDisplay(final, packet(16, [16, 3, 9, 10, 12])).text;
  const live = numberCitationsForDisplay("Partial answer [16] then [3][9", [], { assumeKnown: true });
  check("streaming: completed markers numbered by first appearance, partial marker left as is",
    live.text === "Partial answer [1] then [2][9", live.text);
  const prefixes = [...final.matchAll(/\]/g)].map((mm) => final.slice(0, mm.index! + 1));
  const drift = prefixes.filter((p) => !finalText.startsWith(numberCitationsForDisplay(p, [], { assumeKnown: true }).text));
  check("streaming: at every completed marker the text reads as the final view does",
    prefixes.length === 7 && drift.length === 0, drift[0] ?? finalText);
  const nulls = numberCitationsForDisplay(undefined, null);
  check("missing text and citations are fail-soft", nulls.text === "" && nulls.all.length === 0);
  check("rewriteCitationMarkers with an empty map is the identity", rewriteCitationMarkers("x [3]", new Map()) === "x [3]");
}

// 5. Tier order
console.log("\n[5] tier order (text, flagged, verifier, rest)");
{
  const cites = packet(16, [9, 4]); // 4 flagged but its marker is not in the text
  const text = "Only [9] is in the text.";
  const screen = numberCitationsForDisplay(text, cites, { alsoCited: [2, 9, 99, null, undefined] });
  check("screen: text 9 -> 1, flagged 4 -> 2, verifier-only 2 -> 3",
    same(screen.cited.map((x) => [x.n, x.original]), [[1, 9], [2, 4], [3, 2]]));
  check("verifier numbers that name no citation are ignored", screen.displayNumber(99) === null);
  check("uncited count excludes every cited tier", screen.uncitedCount === 13);
  const noClaims = numberCitationsForDisplay(text, cites);
  check("without verifier input (no claims stored), every number printed matches the screen",
    noClaims.cited.every((x) => screen.displayNumber(x.original) === x.n) && noClaims.cited.length === 2);
  check("every item has a unique display number",
    new Set(screen.all.map((x) => x.n)).size === 16);
}

// 6. Banner markers
console.log("\n[6] banner markers");
{
  const content = "> **Operational check:** DO 1.8 mg/L [12] is below the floor.\n\nBody cites [3] and [12].";
  const { message } = renumberMessageForDisplay({ id: 1, content, citations: packet(16, [3, 12]) } as ReportMessage);
  check("a banner marker is numbered first, the body follows",
    message.content === "> **Operational check:** DO 1.8 mg/L [1] is below the floor.\n\nBody cites [2] and [1].", message.content);
  check("parseVerdict reads the renumbered banner", (parseVerdict(message.content)?.verdict ?? "").includes("[1]"));
  check("stripBanner reads the renumbered body", stripBanner(message.content) === "Body cites [2] and [1].");
}

// 7. Saved-message shape
console.log("\n[7] saved-message shape");
{
  const live: ReportMessage = {
    id: 42, content: "Low risk [3][9][10]. See also [16].",
    citations: packet(16, [3, 9, 10, 16]),
    profile: { persona: "manager", reservoir: "fcr", decision: "none" },
  };
  // A conversation reloaded from storage is the JSON of the message array.
  const saved = JSON.parse(JSON.stringify(live)) as ReportMessage;
  const before = JSON.stringify(saved);
  const { message, uncitedCount } = renumberMessageForDisplay(saved);
  check("saved message renumbers at render time", message.content === "Low risk [1][2][3]. See also [4].", message.content);
  check("saved message object is not mutated", JSON.stringify(saved) === before);
  check("a new message object is returned with the other fields intact",
    message !== saved && message.id === 42 && same(message.profile, saved.profile));
  check("citations stay in input order with display bracketNum and citedInAnswer",
    same(message.citations!.map((c) => c.chunkIndex), saved.citations!.map((c) => c.chunkIndex)) &&
    message.citations![2].bracketNum === 1 && message.citations![2].citedInAnswer === true &&
    message.citations![0].citedInAnswer === false && uncitedCount === 12);
  // Citations stored without bracketNum (array position + 1 is the number) or citedInAnswer.
  const legacy = { id: 7, content: "Old answer [2] and [5].", citations: [
    { text: "a", docName: "A.pdf" }, { text: "b", docName: "B.pdf" }, { text: "c", docName: "C.pdf" },
    { text: "d", docName: "D.pdf" }, { text: "e", docName: "E.pdf" },
  ] };
  const legacyView = renumberMessageForDisplay(legacy as ReportMessage);
  check("legacy citations without bracketNum use array position", legacyView.message.content === "Old answer [1] and [2].",
    legacyView.message.content);
  check("legacy: only the text-cited items are cited",
    same(legacyView.message.citations!.filter((c) => c.citedInAnswer).map((c) => c.docName), ["B.pdf", "E.pdf"]) &&
    legacyView.uncitedCount === 3);
  const noCites = { id: 8, content: "Error: something failed [3]" } as ReportMessage;
  const noCitesView = renumberMessageForDisplay(noCites);
  check("a message without citations is returned as is", noCitesView.message === noCites && noCitesView.uncitedCount === 0);
}

// 8. PDF lists
console.log("\n[8] PDF source lists");
{
  const raw: ReportMessage = { id: 1, content: "Claims [16], [3], [10][9] and [4].", citations: packet(16, [16, 3, 10, 9, 4]) };
  const { message } = renumberMessageForDisplay(raw);
  const { references, data } = splitCitedSources(message.citations);
  const nums = [...references, ...data].map((c) => c.bracketNum!).sort((a, b) => a - b);
  check("references + data read 1..n with no gaps", same(nums, [1, 2, 3, 4, 5]), nums.join(","));
  check("each list is ordered by its display numbers",
    references.every((c, i) => i === 0 || c.bracketNum! > references[i - 1].bracketNum!) &&
    data.every((c, i) => i === 0 || c.bracketNum! > data[i - 1].bracketNum!));
  check("literature/operational split is unchanged by renumbering",
    same(references.map((c) => c.docName).sort(), splitCitedSources(raw.citations).references.map((c) => c.docName).sort()));
  const pickRaw = selectTopEvidence(raw.citations, 3).map((e) => e.docName);
  const pickDisplay = selectTopEvidence(message.citations, 3).map((e) => e.docName);
  check("key evidence picks the same three sources after renumbering", same(pickRaw, pickDisplay));
  const markersInText = bracketNumbers(message.content);
  check("every marker in the renumbered text has an entry in the printed lists",
    markersInText.every((n) => nums.includes(n)));
  // Source 6 is matched only by the claim verifier: the screen shows it as card [6], so
  // the PDF lists it as [6] and does not count it as uncited.
  const withClaims = { ...raw, claims: [{ bracketNum: 6 }, { bracketNum: null }, { bracketNum: 3 }] };
  const screen = numberCitationsForDisplay(withClaims.content, withClaims.citations, {
    alsoCited: withClaims.claims.map((cl) => cl.bracketNum),
  });
  const pdf = renumberMessageForDisplay(withClaims, { alsoCited: withClaims.claims.map((cl) => cl.bracketNum) });
  const pdfLists = splitCitedSources(pdf.message.citations);
  const pdfNums = [...pdfLists.references, ...pdfLists.data].map((c) => c.bracketNum!).sort((a, b) => a - b);
  check("verifier-matched source: PDF lists and screen cards carry the same numbers",
    same(pdfNums, screen.cited.map((x) => x.n)) && same(pdfNums, [1, 2, 3, 4, 5, 6]) &&
    screen.displayNumber(6) === 6, pdfNums.join(","));
  check("verifier-matched source: PDF uncited count equals the screen's (16 - 6 = 10)",
    pdf.uncitedCount === screen.uncitedCount && pdf.uncitedCount === 10);
}

// 9. Footnote
console.log("\n[9] footnote");
{
  check("plural", citationNumberingNote(11) === "Sources are numbered in the order they are cited; 11 further retrieved sources were not cited.",
    citationNumberingNote(11));
  check("singular", citationNumberingNote(1) === "Sources are numbered in the order they are cited; 1 further retrieved source was not cited.");
  check("zero", citationNumberingNote(0) === "Sources are numbered in the order they are cited.");
  const { uncitedCount } = renumberMessageForDisplay({ id: 1, content: "[3][9][10] ... [16]", citations: packet(16, [3, 9, 10, 16]) } as ReportMessage);
  check("count is retrieved minus cited (16 - 4 = 12)",
    citationNumberingNote(uncitedCount) === "Sources are numbered in the order they are cited; 12 further retrieved sources were not cited.");
}

// 10. Idempotence and parser parity
console.log("\n[10] idempotence, parser parity");
{
  const raw: ReportMessage = { id: 1, content: "> Check [12]\n\nA [9, 3]. B [16][3]. C [99].", citations: packet(16, [12, 9, 3, 16]) };
  const once = renumberMessageForDisplay(raw).message;
  const twice = renumberMessageForDisplay(once).message;
  check("renumbering an already-renumbered message changes nothing", same(once, twice));
  const samples = [
    "[4][6][7][15]", "[4, 6, 7, 15]", "[ 7 , 8 ]", "[12]", "see [note] and [3]", "x[1]y[2,3]z", "[ 5 ]", "[1,2 , 3]",
  ];
  const many = packet(20, []);
  const parity = samples.every((t) => {
    const want = [...new Set(bracketNumbers(t))];
    const got = numberCitationsForDisplay(t, many).cited.map((x) => x.original);
    return same(want, got);
  });
  check("marker grammar matches the pipeline's canonical parser on every sample", parity);
}

// 11. Wiring
console.log("\n[11] wiring");
{
  const lib = src("lib/citation-display.ts");
  check("lib/citation-display.ts imports nothing", !/^\s*import\s/m.test(lib));

  const report = src("lib/report.ts");
  check("report.ts: every PDF mode reads the renumbered message, with the verifier's matches",
    report.includes("renumberMessageForDisplay(input.message, {") &&
    report.includes("alsoCited: (input.message.claims ?? []).map((cl) => cl?.bracketNum)") &&
    !/const m = input\.message;/.test(report));
  check("report.ts: the gaps note is replaced by the numbering note alone, printed in evaluation and full",
    !report.includes("Gaps in the sequence") && !report.includes("Numbers match the [N] markers") &&
    report.includes("const sourcesNote = citationNumberingNote(uncitedCount);") &&
    count(report, "para(sourcesNote") === 2);

  const page = src("app/page.tsx");
  check("page.tsx: the answer bubble renders the renumbered text",
    page.includes("<AnswerText text={citationView(m).text}") && !page.includes("<AnswerText text={m.content}"));
  check("page.tsx: evidence cards and claim numbers read the same view",
    page.includes("citationView(m).cited") && page.includes("view.displayNumber(claim.bracketNum)") &&
    page.includes("view.rewrite(claim.text)"));
  check("page.tsx: the panel does not re-parse markers from the raw content", !page.includes("m.content.matchAll("));
  check("page.tsx: the view passes the verifier's brackets, and numbers a streaming answer's markers",
    page.includes("numberCitationsForDisplay(m.content, m.citations, {") &&
    page.includes("alsoCited: (m.claims ?? []).map((cl) => cl.bracketNum),") &&
    page.includes("assumeKnown: m.streaming === true && !m.citations?.length,"));
  // The claims behind alsoCited come from the last faithfulness event (page.tsx keeps the
  // latest); when best-of-N ships an earlier attempt, that attempt's claims must be re-sent
  // so the claim list and the counted sources belong to the answer shown.
  check("page.tsx: the claim list is the last faithfulness event",
    page.includes('else if (event.type === "faithfulness") { finalClaims = event.claims; }'));
  const orchSrc = src("lib/leads/orchestrator.ts");
  check("orchestrator: a best-of-N swap re-sends the kept attempt's claims as the last faithfulness event",
    /answer = bestAttempt\.answer;\s*(?:\/\/[^\n]*\n\s*)*if \(answer\.verification\?\.claims\) \{\s*yield \{ type: "faithfulness", claims: answer\.verification\.claims \};/.test(orchSrc));

  // Display only: nothing on the server, retrieval, verifier or eval side may use it.
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir)).flatMap((f) => {
      const rel = join(dir, f);
      return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(f) ? [rel] : [];
    });
  const serverFiles = [...walk("lib/leads"), ...walk("app/api")];
  const importsDisplay = /(?:from\s*|import\(\s*|require\(\s*)["'][^"']*citation-display["']/;
  const importers = serverFiles.filter((f) => importsDisplay.test(src(f)));
  check("no server module imports the display numbering",
    importers.length === 0, importers.join(", "));
}

// 12. Reader text
console.log("\n[12] reader text");
{
  // Instructions to the answer model; none may reach a reader.
  const INSTRUCTIONS = /authoritative|honor the|Apply this silently|never describe|say '|use this to determine|MUST NOT|State this plainly|and say so|Ground the recommendation|Preserve forecast|[Rr]efuse/;
  // Producers' template literals joined, so a sentence split over `...` + `...` reads whole.
  const joined = (rel: string) => src(rel).replace(/`\s*\+\s*`/g, "");
  const orch = joined("lib/leads/orchestrator.ts");
  const framingPrefix = "OPERATIONAL FRAMING (decision guardrail — authoritative; honor the operational lever and any do-not rules): ";
  check("producers still write the clauses reader-text removes",
    orch.includes(`${framingPrefix}\${framing}`) &&
    orch.includes("DECISION CONSTRAINT EVALUATION (deterministic, computed by LEADS — treat as authoritative for the operational verdict):") &&
    joined("lib/leads/sensor-public.ts").includes(`DATA RECENCY ANCHOR — use this to determine what counts as "current" sensor data. `) &&
    joined("lib/leads/sensor-public.ts").includes(" and MUST NOT be presented as the latest reading.") &&
    joined("lib/leads/sensor-public.ts").includes(" State this plainly to the user: there is NO observation at that depth; do NOT substitute another depth's value as if it were the requested one; if useful, point to the depths that ARE measured.") &&
    src("lib/skill/forecast-skill.ts").includes("treat it as weaker evidence than climatology on"));
  for (const [reservoir, decisions] of Object.entries(RESERVOIR_DECISION_GUARDRAILS)) {
    for (const [decision, g] of Object.entries(decisions)) {
      if (decision === "none") continue;
      const shown = readerText(framingPrefix + g.system_prompt_addendum);
      check(`${reservoir}/${decision}: framing shows only the decision and its lever`,
        shown.startsWith("DECISION CONTEXT:") && g.system_prompt_addendum.startsWith(shown) && !INSTRUCTIONS.test(shown), shown);
    }
  }
  const skill = buildForecastSkillNote({ site: "fcre", variable: "DO_mgL_mean", depthsM: [1.6], fullProfile: false, horizonDays: 21 });
  check("skill record: less-skilful days kept, instruction dropped",
    skill.includes("and say so") && !INSTRUCTIONS.test(readerText(skill)) && readerText(skill).includes("the forecast is less skilful than climatology."));
  const plain = ["Sensor observation at FCRE on 2026-04-03 for DO_mgL_mean at 9 m depth is 4.42.", "FLARE 7-day forecast for FCRE DO_mgL_mean at 9 m: mean 3.69 mg/L.", "We never refuse to say so."];
  check("other text unchanged", plain.every((t) => readerText(t) === t) && readerText("") === "");
  const records: ReportCitation[] = [
    { text: framingPrefix + RESERVOIR_DECISION_GUARDRAILS.fcr.hypoxia_management.system_prompt_addendum, docName: "LEADS decision guardrail (operational framing)", bracketNum: 1, citedInAnswer: true },
    { text: "DECISION CONSTRAINT EVALUATION (deterministic, computed by LEADS — treat as authoritative for the operational verdict): DO_mgL_mean = 4.42 mg/L — the <= 4 mg/L condition is NOT met.", docName: "LEADS deterministic constraint evaluation", bracketNum: 2, citedInAnswer: true },
    { text: skill, docName: "FLARE forecast skill vs climatology", bracketNum: 3, citedInAnswer: true },
  ];
  check("PDF: brief and full print the records without instructions, input untouched",
    (["brief", "full"] as const).every((mode) => {
      const L = buildSourceListing(records, mode);
      const printed = JSON.stringify([L.keyEvidence, L.references, L.data]);
      return printed.includes("DO_mgL_mean = 4.42 mg/L") && !INSTRUCTIONS.test(printed);
    }) && records[0].text.startsWith(framingPrefix));
  {
    const L = buildSourceListing(records, "evaluation");
    check("PDF: the evaluation copy prints the records as before",
      JSON.stringify([L.references, L.data].flat().flatMap((g) => g.items.map((c) => c.text))) === JSON.stringify(records.map((c) => c.text)));
  }
  check("page.tsx: evidence cards print reader text", src("app/page.tsx").includes("<CitationCard n={n} text={readerText(c.text)}"));
  const gen = src("lib/leads/generator.ts");
  check("generator: no-model answers read reader text; citations keep the model's text",
    count(gen, "formatFallbackEvidence(forReader(evidence))") === 2 && gen.includes("buildSimpleAnswerFallback(query, forReader(evidence))") &&
    gen.includes("buildSectionedAnalysisFallback(query, forReader(evidence))") &&
    gen.includes("buildStructuredEvidenceSheet(query, forReader(evidence), requestedChannels)") &&
    !/toCitations\([^)]*forReader/.test(gen));
}

const ok = failures === 0;
console.log(`\n${ok ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(ok ? 0 : 1);
