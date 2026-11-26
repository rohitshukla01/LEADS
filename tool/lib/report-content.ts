// LEADS decision report: pure content builders (no DOM, no jsPDF).
//
// These functions shape the data already on an assistant message for the PDF, so
// report content can be unit-tested in isolation. Every function is fail-soft: it
// returns null, [] or a safe default for missing or partial data, so an incomplete
// answer never makes the report throw. This module imports nothing from the runtime
// pipeline.

import type { ForecastPoint, SeriesPoint } from "./insights";
import { chartDepthLabel, siteDisplayName } from "./insights";
import type { ReproduceParams } from "./reproduce";
import { readerText } from "./reader-text";

// Structural subset of the app's Message that the report reads.
// Kept here (not imported from app/page.tsx) so lib/report* stays decoupled from
// the page. The app's Message is structurally assignable to this.
export interface ReportCitation {
  text: string;
  docName: string;
  pageNum?: number;
  bracketNum?: number;
  citedInAnswer?: boolean;
  chunkIndex?: number;
  /** True when `text` is a verbatim quotation of whole sentences (LEADS_LIT_VERBATIM). */
  verbatim?: boolean;
}
export interface ReportConfidence {
  grounding: number;
  verifierConfidence: number;
  policyAdherence: number;
  channelCoverage: number;
  overall: number;
  iterations: number;
}
export interface ReportChart {
  label: string;
  units: string;
  site: string;
  depthM: number | null;
  sensor: SeriesPoint[] | null;
  forecast: ForecastPoint[] | null;
  threshold?: { value: number; label: string; direction?: "below" | "above" };
  /** Full-profile decisions (water extraction) carry one series per depth here and leave
   *  `sensor` null, so anything reading `sensor` must fall back to this. */
  depthSeries?: { label: string; points: SeriesPoint[] }[] | null;
  /** The question's own horizon (unclamped): the forecast days the skill figure shows; the
   *  chart and outlook use the clamped horizon on `reproduce`. Optional. */
  questionHorizon?: number | null;
}
/** The profile choices an answer was generated under (persona, reservoir, decision). */
export interface ReportProfile {
  persona?: string;
  reservoir?: string;
  decision?: string;
}
/** Profile-question alignment (SSE `done`.alignment), as the UI's advisory reads it. */
export interface ReportAlignment {
  aligned: boolean;
  severity: string;
  dimensions: string[];
  rationale: string;
}
export interface ReportMessage {
  id: number;
  content: string;
  citations?: ReportCitation[];
  faithfulness?: { cited: number; total: number; pct: number };
  confidence?: ReportConfidence;
  chart?: ReportChart | null;
  reproduce?: ReproduceParams | null;
  pipeline?: Record<string, { status: string; data?: Record<string, unknown> }>;
  /** Stored on the message at send time, so a conversation reloaded later keeps the
   *  context it was answered under. Optional. */
  profile?: ReportProfile | null;
  alignment?: ReportAlignment | null;
  /** Per-claim verifier results; the matched bracket is read, so the report counts
   *  a verifier-matched source as cited exactly as the on-screen evidence panel does, and
   *  `checkedBy` (see claimCheckMissing). */
  claims?: { bracketNum?: number | null; checkedBy?: string }[] | null;
}

/** True when the claims come from the word-overlap fallback in lib/leads/verification.ts
 *  because the claim checker gave no result (no model key, a failed call, or no claims
 *  returned). Such claims are shown as "not checked", and the trust score, which is built
 *  from them, is not shown. False for every claim the checker model judged. */
export function claimCheckMissing(claims: { checkedBy?: string }[] | null | undefined): boolean {
  return (claims ?? []).some((c) => c?.checkedBy === "word-overlap");
}
export const CLAIM_CHECK_MISSING_NOTE =
  "No model checked the claims in this answer (no model key, or the claim checker gave no usable reply), so no trust score is given.";

// PDF-safe text
// jsPDF's default fonts render the CP1252/WinAnsi set (which includes em/en dashes,
// smart quotes, ellipsis, bullet, µ, °, ±). Characters outside CP1252, such as the
// arrow "→", have no glyph and print as garbage ("!'"). This maps the common
// out-of-set symbols to ASCII and drops anything else exotic, while keeping the
// CP1252 punctuation that renders fine. Apply to every string drawn into the PDF.
const CP1252_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);
export function sanitizePdfText(s: string | null | undefined): string {
  if (!s) return "";
  const mapped = s
    .replace(/→/g, "->").replace(/←/g, "<-")
    .replace(/↑/g, "^").replace(/↓/g, "v")
    .replace(/≥/g, ">=").replace(/≤/g, "<=")
    .replace(/≈/g, "~").replace(/≠/g, "!=")
    // Subscripts and superscripts sit above 0xFF, so the CP1252 filter below would
    // drop them (CO₂ and CH₄ would print as "CO" and "CH", which name different
    // compounds). Fold them to ASCII digits before that filter runs, and likewise the
    // charge signs in NH₄⁺ / NO₃⁻. (¹²³ are already CP1252 and render as true
    // superscripts, so they are left alone.)
    .replace(/[\u2080-\u2089]/g, (d) => String(d.charCodeAt(0) - 0x2080))
    .replace(/\u2070/g, "0")
    .replace(/[\u2074-\u2079]/g, (d) => String(d.charCodeAt(0) - 0x2074 + 4))
    .replace(/\u207A/g, "+").replace(/\u207B/g, "-")
    .replace(/ /g, " ")
    // The model writes a narrow no-break space between a number and its unit ("10.76\u202Fµg/L"); it is outside
    // CP1252, so the filter below would drop it ("10.76µg/L"). Fold it and the other thin spaces to a space.
    .replace(/[\u2002-\u200A\u202F\u205F]/g, " ");
  let out = "";
  for (const ch of mapped) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xff || CP1252_EXTRA.has(cp)) out += ch;
  }
  return out;
}

/** Upper-case for PDF eyebrows that leaves the micro sign alone. JavaScript upper-cases
 *  "µ" (U+00B5, in CP1252) to Greek capital Mu (U+039C, not in CP1252), which
 *  sanitizePdfText then deletes ("20 µg/L" would print as "20 G/L").
 *  A metre unit after a number stays lower case ("1.6 m", not "1.6 M", which reads as
 *  molar); "MG/L" and other words are unaffected.
 *  Use it wherever a label is upper-cased for drawing or for measuring. */
export function upperKeepMicro(s: string | null | undefined): string {
  return (s ?? "").split("\u00b5").map((part) => part.toUpperCase()).join("\u00b5").replace(/(\d)\s?M\b/g, "$1 m");
}

// Header context and figure identity (built from the message, never the dropdown)

/** The context tag under the PDF header bar: site · persona · decision · depth.
 *
 *  The site goes through the shared display table, the decision "none" reads
 *  "informational", and the depth is what the chart drew (omitted when it drew none;
 *  the profile's own depth is only a placeholder). The profile stored on the message
 *  wins; `fallback` (the live profile) fills in only when the message carries no
 *  profile. */
export function reportContextParts(m: ReportMessage, fallback?: ReportProfile | null): string[] {
  const p = m.profile ?? fallback ?? null;
  const decision = p?.decision
    ? (p.decision === "none" ? "informational" : p.decision.replace(/_/g, " "))
    : "";
  return [siteDisplayName(m.chart?.site || p?.reservoir), p?.persona ?? "", decision, chartDepthLabel(m.chart)]
    .filter(Boolean);
}

/** "<variable> (<units>) · <site> · <depth>" for a printed chart. The on-screen title
 *  is HTML outside the captured <svg>, so the PDF prints its own. Null when the chart
 *  has no variable label. */
export function chartIdentity(chart: ReportChart | null | undefined): string | null {
  if (!chart?.label) return null;
  return [chart.units ? `${chart.label} (${chart.units})` : chart.label, siteDisplayName(chart.site), chartDepthLabel(chart)]
    .filter(Boolean)
    .join(" · ");
}

/** The UI's amber profile-question advisory (app/page.tsx), as text for the PDF; same
 *  title rule as the UI. Null when the answer is aligned or carries no alignment. */
export function buildAlignmentAdvisory(
  a: ReportAlignment | null | undefined,
): { title: string; text: string; hard: boolean } | null {
  if (!a || a.aligned) return null;
  return {
    title: a.dimensions?.includes("mode") ? "No guardrail enforced" : `Profile mismatch · ${a.severity}`,
    text: a.rationale ?? "",
    hard: a.severity === "hard",
  };
}

// Constants
export const FLARE_MODEL = "glm_aed_flare_v3";
export const SYNTHESIS_MODEL = "gpt-4.1";

export const DISCLAIMER =
  "This is an experimental AI research tool for decision support, provided “as is” without warranty. " +
  "Its forecasts and recommendations are inherently uncertain and may be inaccurate; evaluate them and apply " +
  "your own expert judgment before acting. This is a decision-support record, not a validated regulatory document.";

export const GLOSSARY: { term: string; def: string }[] = [
  { term: "Trust score", def: "Composite of grounding, per-claim verifier confidence, policy adherence, and channel coverage. It measures how well-grounded and self-consistent the answer is — NOT the real-world outcome." },
  { term: "10-90% band", def: "The FLARE ensemble forecast's inner 80% range: a plausible spread, not a guarantee." },
  { term: "pessimistic / expected / optimistic", def: "The worst / typical / best value of the forecast at the end of the horizon, relative to the decision threshold. Where low is bad (e.g. hypoxia), pessimistic is the 10th percentile and optimistic the 90th; where high is bad (e.g. a bloom threshold) they swap: pessimistic is the 90th and optimistic the 10th. Expected is the mean." },
  { term: "Operational check", def: "A deterministic, LEADS-computed comparison of the latest reading against the guardrail threshold for the active decision." },
];

export const THRESHOLDS: { name: string; rule: string }[] = [
  { name: "Surface bloom (chlorophyll-a)", rule: "> 20 ug/L -> bloom-action threshold" },
  { name: "Hypoxia (dissolved oxygen)", rule: "< 2 mg/L -> hypoxia" },
  { name: "Thermal (surface temperature)", rule: "> 25 C -> thermal stress" },
];

// Verdict (BLUF): parse the leading operational-check blockquote
export function parseVerdict(content: string): { verdict: string; forecastClause: string | null } | null {
  if (!content) return null;
  const lines = content.split("\n");
  const bq: string[] = [];
  for (const ln of lines) {
    if (ln.startsWith(">")) bq.push(ln.replace(/^>\s?/, ""));
    else if (bq.length) break;      // banner ended
    else if (ln.trim() === "") continue;
    else return null;               // first content line is not a blockquote: no banner
  }
  if (!bq.length) return null;
  const joined = bq.join(" ").replace(/\*\*/g, "").trim();
  const fcIdx = joined.search(/Forecast:/i);
  const verdict = (fcIdx >= 0 ? joined.slice(0, fcIdx) : joined).trim();
  const forecastClause = fcIdx >= 0 ? joined.slice(fcIdx).trim() : null;
  return { verdict, forecastClause };
}

/** The answer body with the leading operational-check blockquote removed. */
export function stripBanner(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith(">"))) i++;
  return lines.slice(i).join("\n").trim();
}

/** The operational check's scope line ("Check used … only. Not evaluated: …"), verbatim
 *  from the deterministic constraint evaluation (the `guardrail-eval` step's
 *  `scopeNote`). Present only when the active rule leaves one of the reservoir's
 *  operating constraints unevaluated. Shared by the answer bubble and the PDF so both
 *  print the same words; it is never part of the answer text. Fail-soft: null when
 *  absent. */
export function buildCheckScopeLine(pipeline: ReportMessage["pipeline"]): string | null {
  const v = pipeline?.["guardrail-eval"]?.data?.scopeNote;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}


/** "Woelmer2023_AquaticSciences.pdf" -> "Woelmer et al. (2023), Aquatic Sciences".
 *  A raw filename does not let a reader recognise the study. Falls back to the bare
 *  name when the Author+Year+Journal pattern does not match. */
export function citeFromDocName(name: string): string {
  const base = (name ?? "").replace(/\.pdf$/i, "");
  const m = base.match(/^([A-Za-z]+)(\d{4})_(.+)$/);
  if (m) {
    const journal = m[3]
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      // acronym + word ("JGRBiogeosciences" -> "JGR Biogeosciences"); the word needs
      // 2+ lowercase letters so pure acronyms ("ESSOAr") stay intact.
      .replace(/([A-Z]{2,})([A-Z][a-z]{2,})/g, "$1 $2")
      .trim();
    return `${m[1]} et al. (${m[2]}), ${journal}`;
  }
  return base;
}

/** Round the long floats the constraint evaluator emits (6.722862729166667 -> 6.72).
 *  Display only - 15 decimal places is false precision in a printed document. */
export function roundLongDecimals(t: string): string {
  return (t ?? "").replace(/(\d+\.\d{3,})/g, (v) => String(Number(Number(v).toFixed(2))));
}

// Evidence

/** Printed under a literature list whose excerpts are all verbatim quotations. Shared by
 *  the on-screen evidence panel and the PDF so both say the same thing. */
export const LITERATURE_EXCERPT_NOTE =
  "Excerpts are verbatim from the indexed text of each paper (PDF extraction may differ slightly from the published article); page numbers are approximate.";

/** LITERATURE_EXCERPT_NOTE when the list holds at least one literature excerpt (a `.pdf`
 *  document) and every literature excerpt in it is flagged verbatim; null otherwise, so
 *  answers without the flag, or with any non-quoted excerpt, print no note. */
export function literatureExcerptNote(
  items: ReadonlyArray<{ docName?: string; verbatim?: boolean }> | undefined,
): string | null {
  const literature = (items ?? []).filter((c) => /\.pdf$/i.test(c.docName ?? ""));
  return literature.length > 0 && literature.every((c) => c.verbatim === true) ? LITERATURE_EXCERPT_NOTE : null;
}

/** Characters of a source's text to print: a verbatim quotation is printed whole (it is
 *  already at most 600 chars and ends on a sentence), anything else is clipped at
 *  `defaultLimit`. */
export function excerptLimit(c: { text?: string; verbatim?: boolean }, defaultLimit: number): number {
  return c.verbatim === true ? Math.max(defaultLimit, (c.text ?? "").length) : defaultLimit;
}

export function selectTopEvidence(
  citations: ReportCitation[] | undefined,
  n = 3,
): { docName: string; pageNum?: number; bracketNum?: number; snippet: string; verbatim?: boolean }[] {
  if (!citations?.length) return [];
  const cited = citations.filter((c) => c.citedInAnswer !== false);
  const pool = cited.length ? cited : citations;
  return pool.slice(0, n).map((c) => {
    const text = (c.text ?? "").replace(/\s+/g, " ");
    return {
      docName: c.docName,
      pageNum: c.pageNum,
      bracketNum: c.bracketNum,
      snippet: text.slice(0, excerptLimit({ text, verbatim: c.verbatim }, 220)).trim(),
      ...(c.verbatim === true ? { verbatim: true } : {}),
    };
  });
}

/** Split the answer's cited evidence into two groups for the report: literature
 *  `references` (corpus PDFs) and operational `data` (LEADS-derived
 *  sensor/forecast/guardrail records). Both are filtered to what the answer actually
 *  cited (`citedInAnswer !== false`) so the report count matches the answer, and both
 *  are ordered by `bracketNum` so a number in the report equals the [N] in the prose.
 *  The report passes a message already renumbered for display (lib/citation-display.ts),
 *  so `bracketNum` is the display number and the combined lists read 1..n.
 *  Literature is identified by a `.pdf` document name (the corpus is PDFs; operational
 *  evidence carries synthesized labels like "FLARE FCRE Chla_ugL_mean"). */
export function splitCitedSources(
  citations: ReportCitation[] | undefined,
): { references: ReportCitation[]; data: ReportCitation[] } {
  const cited = (citations ?? []).filter((c) => c.citedInAnswer !== false);
  const byBracket = (a: ReportCitation, b: ReportCitation) =>
    (a.bracketNum ?? Number.MAX_SAFE_INTEGER) - (b.bracketNum ?? Number.MAX_SAFE_INTEGER);
  const isLit = (c: ReportCitation) => /\.pdf$/i.test(c.docName ?? "");
  return {
    references: cited.filter(isLit).sort(byBracket),
    data: cited.filter((c) => !isLit(c)).sort(byBracket),
  };
}

/** One heading in a printed source list: a run of consecutive display numbers that all
 *  come from the same source (document or record label). */
export interface SourceListGroup<T> {
  docName: string;
  /** Display numbers under this heading: ascending, each one more than the last. */
  nums: number[];
  /** Distinct non-zero page numbers across the run, in list order (0 = unknown). */
  pages: number[];
  /** The entries, in the order of `nums`. */
  items: T[];
}

/** Group a source list for printing, so the printed numbers always ascend.
 *
 *  Entries share a heading only when they come from the same source and their numbers
 *  are consecutive ([5] [6] [7]); any other entry starts a new heading. (Grouping by
 *  source alone would pull later numbers forward and print them out of order.) An
 *  entry without a `bracketNum` is numbered `fallbackStart + position + 1`, as the
 *  lists number such entries. The list is ordered by number here (stable), whatever
 *  order it arrives in. */
export function groupConsecutiveSources<T extends { docName: string; bracketNum?: number; pageNum?: number }>(
  list: readonly T[] | null | undefined,
  fallbackStart = 0,
): SourceListGroup<T>[] {
  const numbered = (list ?? [])
    .map((item, i) => ({ item, n: item.bracketNum ?? fallbackStart + i + 1 }))
    .sort((a, b) => a.n - b.n);
  const groups: SourceListGroup<T>[] = [];
  for (const { item, n } of numbered) {
    const docName = item.docName ?? "";
    const last = groups[groups.length - 1];
    if (last && last.docName === docName && n === last.nums[last.nums.length - 1] + 1) {
      last.nums.push(n);
      last.items.push(item);
    } else {
      groups.push({ docName, nums: [n], pages: [], items: [item] });
    }
  }
  for (const g of groups) {
    g.pages = [...new Set(g.items.map((c) => c.pageNum).filter((p): p is number => !!p))];
  }
  return groups;
}

/** The PDF modes, as lib/report.ts names them. */
export type SourceListMode = "brief" | "full" | "evaluation";

/** Every numbered source list a PDF mode prints, already grouped for printing:
 *  - `keyEvidence`: the top three cited sources (brief and full);
 *  - `references` / `data`: the cited literature and the cited LEADS-derived records
 *    (full and evaluation), each its own section.
 *  Lists a mode does not print are empty. Each list reads in ascending display number. */
export function buildSourceListing(
  citations: ReportCitation[] | undefined,
  mode: SourceListMode,
): {
  keyEvidence: SourceListGroup<ReturnType<typeof selectTopEvidence>[number]>[];
  references: SourceListGroup<ReportCitation>[];
  data: SourceListGroup<ReportCitation>[];
} {
  const none: ReportCitation[] = [];
  // Brief and full print each record's facts, not the instructions written for the answer
  // model. The evaluation copy (used in the expert evaluation) keeps the record text unchanged.
  const shown = mode === "evaluation" ? citations : citations?.map((c) => ({ ...c, text: readerText(c.text) }));
  const { references, data } = mode === "brief" ? { references: none, data: none } : splitCitedSources(shown);
  return {
    keyEvidence: mode === "evaluation" ? [] : groupConsecutiveSources(selectTopEvidence(shown, 3)),
    references: groupConsecutiveSources(references),
    data: groupConsecutiveSources(data, references.length),
  };
}

// Forecast numbers (fail-soft; drives the always-present table)
export interface ForecastTable {
  pessimistic: number;
  expected: number;
  optimistic: number;
  /** UI-matching labels ("pessimistic · 90th") - which percentile is the worst case
   *  depends on the threshold's direction. */
  pessimisticLabel: string;
  optimisticLabel: string;
  /** Percentiles on the left (pessimistic) and right (optimistic) outlook cards, in the
   *  order they are drawn; the middle card is the mean. */
  cardPercentiles: [number, number];
  /** True when a value falls on the wrong side of the decision threshold. */
  breaches: (v: number) => boolean;
  units: string;
  threshold?: { value: number; label: string; direction?: "below" | "above" };
  horizonDays: number | null;
}
export function buildForecastTable(chart: ReportChart | null | undefined): ForecastTable | null {
  const fc = chart?.forecast;
  if (!fc?.length) return null;
  const last = fc[fc.length - 1];
  if (!Number.isFinite(last.mean)) return null;
  // "pessimistic" is the worst case for this threshold's direction, as the on-screen
  // panel (InsightPanel) computes it: p10 for a "below" threshold (hypoxia, where low
  // is bad) and p90 for an "above" threshold (a bloom limit, where high is bad).
  const lo = last.p10 ?? last.lower;
  const hi = last.p90 ?? last.upper;
  const dir = chart?.threshold?.direction;
  const pessimistic = dir === "above" ? hi : lo;
  const optimistic = dir === "above" ? lo : hi;
  const pessimisticLabel = dir === "above" ? "pessimistic · 90th" : dir === "below" ? "pessimistic · 10th" : "lower · 10th";
  const optimisticLabel = dir === "above" ? "optimistic · 10th" : dir === "below" ? "optimistic · 90th" : "upper · 90th";
  const cardPercentiles: [number, number] = dir === "above" ? [90, 10] : [10, 90];
  // Horizon is the number of forecast days, not the span between the first and last
  // point (N-1 for N daily points), so the outlook header matches the chart heading.
  const horizonDays: number | null = fc.length > 0 ? fc.length : null;
  return { pessimistic, expected: last.mean, optimistic, pessimisticLabel, optimisticLabel, cardPercentiles,
           units: chart?.units ?? "", threshold: chart?.threshold, horizonDays,
           breaches: (v: number) => !!chart?.threshold && (dir === "above" ? v > chart.threshold.value : dir === "below" ? v < chart.threshold.value : false) };
}

/** "90th percentile / mean / 10th percentile": the outlook caption, in the order the
 *  cards are drawn. For an "above" threshold (a bloom limit) the 90th comes first. */
export function outlookCardOrder(ft: Pick<ForecastTable, "cardPercentiles">): string {
  const [left, right] = ft.cardPercentiles;
  return `${left}th percentile / mean / ${right}th percentile`;
}

/** Return the human-readable exceedance-probability clause from the banner, verbatim.
 *  Never recomputed client-side (no ensemble here). The banner prints ensemble member
 *  counts ("0 of 221 members ...", with no "%"), so a count is accepted; the percentage
 *  and "peaks at" / "stays under" forms are also accepted. */
export function deriveExceedanceProb(forecastClause: string | null): string | null {
  if (!forecastClause) return null;
  return /peaks at|stays under|<\s*1%|\d+%|\d+ of \d+ members/.test(forecastClause) ? forecastClause : null;
}

// Forecast window (what the chart draws, on the report's own clock)

export type ForecastWindow = {
  /** First and last day of the full FLARE run. */
  from: string | null;
  to: string | null;
  /** Days in the run, and how many of them the chart actually plots (the chart drops
   *  any forecast day at or before the latest observation). */
  runDays: number;
  drawnDays: number;
};

const isoDay = (t: unknown): string | null => {
  const d = new Date(t as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Describe the forecast window the reader is looking at.
 *
 *  The chart draws only the days strictly after the latest observation, so `drawnDays`
 *  is smaller than `runDays` when the first forecast days predate the newest reading.
 *
 *  Everything here is derived from the run's own dates, so a current run and a lagging
 *  one are described by the same code, and the reader compares the printed window
 *  against the report date. No freshness verdict is asserted.
 */
export function buildForecastWindow(chart: ReportChart | null | undefined): ForecastWindow | null {
  const f = chart?.forecast;
  if (!f?.length) return null;
  const s = chart?.sensor;
  const latest = s?.length ? isoDay(s[s.length - 1].t) : null;
  const drawn = latest ? f.filter((p) => (isoDay(p.t) ?? "") > latest) : f;
  return {
    from: isoDay(f[0].t),
    to: isoDay(f[f.length - 1].t),
    runDays: f.length,
    drawnDays: drawn.length,
  };
}

/** One-line window label reused by the chart caption and the outlook header, so the
 *  two can never disagree about which days the reader is looking at. */
export function forecastWindowLabel(w: ForecastWindow | null): string | null {
  if (!w || !w.from || !w.to) return null;
  return `${w.from} to ${w.to}`;
}

// Data freshness
export function buildFreshness(chart: ReportChart | null | undefined): {
  latestSensor: string | null;
  forecastWindow: string | null;
} {
  const day = (t: unknown): string | null => {
    const d = new Date(t as string);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const s = chart?.sensor;
  const f = chart?.forecast;
  // Full-profile charts leave `sensor` null and carry the traces in depthSeries; take the
  // newest day across those traces so the report still states its latest observation date.
  const multiLatest = (chart?.depthSeries ?? [])
    .map((sr) => (sr.points.length ? day(sr.points[sr.points.length - 1].t) : null))
    .filter((d): d is string => !!d)
    .sort()
    .pop() ?? null;
  return {
    latestSensor: s?.length ? day(s[s.length - 1].t) : multiLatest,
    forecastWindow: f?.length ? `${day(f[0].t) ?? "?"} to ${day(f[f.length - 1].t) ?? "?"}` : null,
  };
}
