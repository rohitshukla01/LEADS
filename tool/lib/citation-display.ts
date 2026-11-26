// Display numbering for an answer's citations; pure (no DOM, no pipeline imports).
//
// Every retrieved item is numbered by its slot in the synthesis prompt (`bracketNum`,
// 1..N) and the answer cites only some of them, so the markers a reader sees run
// [3][9][10] ... [16]. For display only, the cited items are renumbered 1..n in the
// order the displayed text first cites them, and the markers are rewritten to match.
// The stored message, the streamed answer, the claim verifier and the eval traces all
// keep the pipeline's numbers: nothing here is written back, and it runs at render
// time, so a saved conversation is renumbered the same way when it is reopened.
//
// Display numbers are assigned in four tiers:
//   1. numbers cited in the displayed text (banner included), by first appearance;
//   2. items flagged `citedInAnswer` whose marker is not in the displayed text;
//   3. numbers in `alsoCited` (the claim verifier's matches) not numbered above;
//   4. every remaining item - retrieved but not cited - so no two items share a number.
// Tiers 2-4 follow the pipeline's number. Tiers 1-3 are "cited". A marker whose
// numbers name no item is left exactly as written; a marker naming at least one item is
// rewritten with each number mapped (unknown numbers inside it stay as they are, and a
// comma group keeps the comma form).
//
// While an answer streams, its citation list has not arrived yet (it comes with the
// final event), so no number is known. With `assumeKnown`, every marker number in the
// text counts as a citation index and tier 1 numbers them as above; whenever each marker
// names a real citation, the numbers match the final view, so they do not change when
// the answer completes.
//
// Applying it to its own output changes nothing (the markers already read 1..n in
// order of appearance), so a path that renumbers an already-renumbered message is safe.

/** The citation fields this module reads. The app's Citation and the report's
 *  ReportCitation are both structurally assignable to it. */
export interface CitationLike {
  bracketNum?: number | null;
  citedInAnswer?: boolean | null;
}

export interface NumberedCitation<C> {
  citation: C;
  /** Display number, 1-based. */
  n: number;
  /** The pipeline's number (bracketNum, or array position + 1 when absent). */
  original: number;
  /** Cited by the answer (tiers 1-3). */
  cited: boolean;
}

export interface CitationDisplay<C> {
  /** The text with its citation markers rewritten to display numbers. */
  text: string;
  /** Every citation, in input order, with its display number. */
  all: NumberedCitation<C>[];
  /** The cited citations, ordered by display number. */
  cited: NumberedCitation<C>[];
  /** Citations retrieved but not cited. */
  uncitedCount: number;
  /** Display number for a pipeline number; null when no citation carries it. */
  displayNumber: (original: number) => number | null;
  /** Rewrite the markers in another display string (e.g. a claim) with the same map. */
  rewrite: (s: string) => string;
}

// Same marker grammar as the pipeline's canonical parser (lib/leads/citation-brackets.ts):
// "[12]", "[4, 6, 7, 15]", "[ 7 , 8 ]". Kept local so this display module imports nothing
// from the pipeline; scripts/check-citation-display.ts asserts the two parse identically.
// A RegExp is built per call so no `lastIndex` is shared between calls.
const MARKER_SRC = "\\[\\s*(\\d+(?:\\s*,\\s*\\d+)*)\\s*\\]";

function markerNumbers(group: string): number[] {
  return group
    .split(/\s*,\s*/)
    .map((p) => Number.parseInt(p, 10))
    .filter(Number.isFinite);
}

function originalNumber(c: CitationLike | null | undefined, index: number): number {
  const b = c?.bracketNum;
  return typeof b === "number" && Number.isFinite(b) ? b : index + 1;
}

/** Rewrite every citation marker in `text` through `map` (pipeline -> display number).
 *  Markers that name no mapped number are returned verbatim. */
export function rewriteCitationMarkers(text: string, map: ReadonlyMap<number, number>): string {
  if (!text || map.size === 0) return text ?? "";
  return text.replace(new RegExp(MARKER_SRC, "g"), (whole: string, group: string) => {
    const nums = markerNumbers(group);
    if (!nums.some((n) => map.has(n))) return whole;
    return `[${nums.map((n) => map.get(n) ?? n).join(", ")}]`;
  });
}

/** Number one answer's citations for display. `text` is the answer exactly as displayed
 *  (banner included); `alsoCited` adds pipeline numbers that count as cited even without
 *  a marker in the text; `assumeKnown` treats every marker number in the text as a
 *  citation index (for an answer still streaming, before its citations arrive).
 *  Fail-soft: missing text or citations yield the text unchanged and empty lists. */
export function numberCitationsForDisplay<C extends CitationLike>(
  text: string | null | undefined,
  citations: readonly C[] | null | undefined,
  opts: { alsoCited?: Iterable<number | null | undefined> | null; assumeKnown?: boolean } = {},
): CitationDisplay<C> {
  const body = typeof text === "string" ? text : "";
  const list = Array.isArray(citations) ? citations : [];
  const originals = list.map((c, i) => originalNumber(c, i));
  const known = new Set(originals);
  const map = new Map<number, number>();
  const assign = (n: number) => {
    if (known.has(n) && !map.has(n)) map.set(n, map.size + 1);
  };
  const ascending = (ns: Iterable<number>) => [...new Set(ns)].sort((a, b) => a - b);

  // 1. Cited in the displayed text, by first appearance.
  for (const match of body.matchAll(new RegExp(MARKER_SRC, "g"))) {
    for (const n of markerNumbers(match[1])) {
      if (opts.assumeKnown) known.add(n);
      assign(n);
    }
  }
  // 2. Flagged as cited, marker not in the displayed text.
  ascending(originals.filter((_, i) => list[i]?.citedInAnswer === true)).forEach(assign);
  // 3. Cited by another signal (the claim verifier's matches).
  const extra: number[] = [];
  for (const n of opts.alsoCited ?? []) if (typeof n === "number" && Number.isFinite(n)) extra.push(n);
  ascending(extra).forEach(assign);
  const citedNumbers = map.size;
  // 4. Retrieved, not cited.
  ascending(originals).forEach(assign);

  const all: NumberedCitation<C>[] = list.map((citation, i) => {
    const original = originals[i];
    const n = map.get(original) ?? original;
    return { citation, n, original, cited: n <= citedNumbers };
  });
  const cited = all.filter((x) => x.cited).sort((a, b) => a.n - b.n);

  return {
    text: rewriteCitationMarkers(body, map),
    all,
    cited,
    uncitedCount: all.length - cited.length,
    displayNumber: (original: number) => map.get(original) ?? null,
    rewrite: (s: string) => rewriteCitationMarkers(s, map),
  };
}

/** A copy of `m` whose content and citations carry display numbers: content markers
 *  rewritten, each citation's `bracketNum` set to its display number and
 *  `citedInAnswer` set to whether it is cited. Citations stay in their input order.
 *  `m` itself is never modified. */
export function renumberMessageForDisplay<M extends { content: string; citations?: CitationLike[] | null }>(
  m: M,
  opts: { alsoCited?: Iterable<number | null | undefined> | null } = {},
): { message: M; uncitedCount: number } {
  if (!Array.isArray(m.citations)) return { message: m, uncitedCount: 0 };
  const view = numberCitationsForDisplay(m.content, m.citations, opts);
  return {
    message: {
      ...m,
      content: typeof m.content === "string" ? view.text : m.content,
      citations: view.all.map((x) => ({ ...x.citation, bracketNum: x.n, citedInAnswer: x.cited })),
    },
    uncitedCount: view.uncitedCount,
  };
}

/** The sentence printed under a numbered source list. */
export function citationNumberingNote(uncitedCount: number): string {
  const base = "Sources are numbered in the order they are cited";
  const k = Number.isFinite(uncitedCount) ? Math.max(0, Math.floor(uncitedCount)) : 0;
  if (k === 0) return `${base}.`;
  return `${base}; ${k} further retrieved ${k === 1 ? "source was" : "sources were"} not cited.`;
}
