// Verbatim literature passages (switch LEADS_LIT_VERBATIM, default "on").
//
// With "off"
// Literature retrieval reduces every retrieved chunk to one extracted sentence
// (literature.ts extractBestClaim, at most 500 chars), and for the top-ranked items an
// LLM rewrites that sentence into a one-sentence claim (distillLiteratureEvidence). That
// text (LeadsEvidence.text) is what the answer model reads, what the claim verifier
// judges against, and what the UI card and the PDF print as the source excerpt.
//
// With "on"
//   - The whole retrieved chunk is carried on the evidence item (LeadsEvidence.verbatimText,
//     see attachVerbatimPassages). It is attached after rerank and nothing that ranks,
//     de-duplicates or selects evidence reads it, so the retrieved set and its order are
//     the same in both modes. Summary nodes (raptorLevel > 0) never get one.
//   - The answer model's literature packet carries that chunk, at most
//     LITERATURE_ITEM_CHAR_CAP chars (evidence-budget.ts trims literature first when the
//     packet is over its limit; forecast, sensor and other deterministic records are never
//     cut).
//   - The claim verifier judges against the same packet text (verification.ts).
//   - The printed excerpt (LeadsCitation.text) is a quotation: whole sentences copied from
//     the text the model read, chosen by word overlap with the answer sentences that cite
//     it, at most LITERATURE_QUOTE_CHAR_CAP chars (pickVerbatimQuote). Running page
//     headers, journal running heads and publisher stamps are never quoted; figure and
//     table captions only when the passage has no other quotable sentence. A passage with
//     no quotable sentence at all prints its opening text (passageExcerpt), flagged
//     LeadsCitation.verbatim = false. LeadsCitation.modelText keeps the text the model read.
//
// The paper's benchmark runs used "off".
//
// Everything below the flag is pure string processing: no I/O, no model calls.

import { bracketNumbers } from "./citation-brackets";
import type { LeadsEvidence } from "./types";

export type LitVerbatimMode = "on" | "off";

/** Read at call time so an eval harness can set it after import. "off", "0", "false" and
 *  "no" (any case) turn the switch off; unset, empty or anything else reads as "on". */
export function litVerbatimMode(): LitVerbatimMode {
  const raw = (process.env.LEADS_LIT_VERBATIM ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no" ? "off" : "on";
}

/** Largest literature passage placed in the answer model's packet. The largest verbatim
 *  chunk in the corpus is 2,499 chars (90th percentile 1,871), so a chunk is cut only when
 *  the packet budget has to trim literature. */
export const LITERATURE_ITEM_CHAR_CAP = 2_500;

/** Largest printed quotation. The UI card shows the first 600 chars of a citation. */
export const LITERATURE_QUOTE_CHAR_CAP = 600;

/** A start or end sentence of a quotation needs at least this many chars and words. */
const MIN_QUOTE_SENTENCE_CHARS = 30;
const MIN_QUOTE_SENTENCE_WORDS = 5;

/** Length of the fallback quotation when no answer sentence shares a word with the passage. */
const LEAD_QUOTE_CHARS = 300;

/** Score lost per printed char, so a sentence joins the quotation only when it adds support. */
const LENGTH_PENALTY_PER_CHAR = 0.005;

/** Weight of words that occur only in the item's extracted sentence (LeadsEvidence.text),
 *  relative to words from the answer sentences that cite the item. */
const RETRIEVAL_TEXT_WEIGHT = 0.35;

// Passage text

/** Control characters PDF extraction leaves in the indexed text (NUL, bullet glyphs such
 *  as U+000F). Newline is kept: blank lines separate paragraphs. */
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/**
 * The indexed chunk as the packet carries it: control characters become spaces,
 * whitespace inside a paragraph collapses to single spaces, and paragraphs (blank-line
 * separated blocks, which is how page furniture such as running heads and page numbers is
 * laid out in the indexed text) stay separated by one blank line. No word is changed.
 */
export function verbatimPassage(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Whitespace-insensitive form (control characters count as whitespace), for substring
 *  comparisons against the indexed chunk. */
export function collapseWhitespace(text: string | null | undefined): string {
  return (text ?? "").replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/**
 * Sets LeadsEvidence.verbatimText on verbatim literature chunks when the switch is on.
 * Summary nodes (provenance.raptorLevel > 0) and items without a retrieved passage are
 * returned unchanged, as is everything when the switch is off.
 */
export function attachVerbatimPassages(evidence: LeadsEvidence[], mode: LitVerbatimMode): LeadsEvidence[] {
  if (mode !== "on") return evidence;
  return evidence.map((item) => {
    if (item.channel !== "literature" || (item.provenance.raptorLevel ?? 0) > 0 || !item.fullText) return item;
    const passage = verbatimPassage(item.fullText);
    return passage ? { ...item, verbatimText: passage } : item;
  });
}

// Segmentation

export type PassageUnitKind = "text" | "caption" | "noise";

export interface PassageUnit {
  /** Offsets into the segmented text; text.slice(start, end) === this.text. */
  start: number;
  end: number;
  text: string;
  /** Index of the blank-line separated block the sentence sits in. */
  block: number;
  kind: PassageUnitKind;
  /** Begins a sentence: a capital letter, or an opening quote/bracket before one. A unit
   *  that opens on a numeral is, in the indexed text, almost always a continuation, a
   *  footnote or an affiliation line ("23 Department of …"), so it never opens a quote. */
  startsSentence: boolean;
  /** Ends with . ! or ? (closing quotes/brackets allowed), and not on an abbreviation
   *  such as "et al." or an initial. */
  endsSentence: boolean;
  /** Long enough to open or close a quotation. */
  substantial: boolean;
}

/** A section heading run into the first sentence of its paragraph ("Abstract Freshwater
 *  lakes ..."). The heading words are left out of the sentence, so a quotation starts at the
 *  sentence itself. The capital after the heading keeps "Results from our study …" whole. */
const GLUED_HEADING =
  /^(?:plain language summary|key points|highlights|abstract|summary|introduction|background|conclusions?|methods|discussion)(?:\s*[:.—–-]\s*|\s+)(?=["'“‘(]?[A-Z])/i;

/** Heading of a list whose items are complete statements without a final full stop. */
const LIST_HEADING = /^(?:key points|highlights|key findings)\s*:?$/i;

/** Tokens that end in a period without ending the sentence. Initials ("C.E."), "e.g." and
 *  "i.e." are matched by the dotted-letters rule in isAbbreviation. */
const ABBREVIATIONS = new Set([
  "al", "fig", "figs", "eq", "eqs", "ca", "approx", "vs", "cf", "no", "nos", "vol", "pp",
  "ref", "refs", "sp", "spp", "st", "dr", "mr", "mrs", "ms", "resp", "var", "inc", "ltd",
  "co", "dept", "univ", "tab", "suppl", "ed", "eds", "et", "jan", "feb", "mar", "apr",
  "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

function isAbbreviation(textEndingInPeriod: string): boolean {
  const token = /(\S+)\.$/.exec(textEndingInPeriod)?.[1] ?? "";
  const core = token.replace(/^[("'“‘[]+/, "");
  if (!core) return false;
  if (/^[A-Za-z](?:\.[A-Za-z])*$/.test(core)) return true;
  return ABBREVIATIONS.has(core.toLowerCase());
}

const SENTENCE_END = /[.!?]["'”’)\]]*$/;

function endsSentence(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!SENTENCE_END.test(trimmed)) return false;
  const bare = trimmed.replace(/["'”’)\]]+$/, "");
  return !(bare.endsWith(".") && isAbbreviation(bare));
}

/**
 * Page furniture that PDF extraction leaves inside the text. A sentence matching any of
 * these is never quoted.
 */
const NOISE_PATTERNS: RegExp[] = [
  // Journal running heads: "Water Research 288 (2026) 124722", "water research 67 (2014) 129".
  /\b[a-z][a-z.&:,' -]{2,60}\s\d{1,4}\s?\(\d{4}\)\s?\d{1,6}/i,
  // "Water 2019 , 11 , 222" and "Earth Syst. Sci. Data, 17, 3141-3165, 2025".
  /\b\d{4} , \d{1,3} , \d{1,6}\b/,
  /\b\d{1,3}, \d{1,6}[-–]\d{1,6}, \d{4}\b/,
  // Author running heads: "Smith et al. / Water Research …", "M. Golub et al.: The ISIMIP …",
  // "SMITH ET AL."
  /\bet al\. ?[/:]/i,
  /\b[A-Z]{2,}(?: [A-Z]{2,})* ET AL\b/,
  // DOIs and links.
  /\bdoi\b|\b10\.\d{4,9}\/|https?:\/\/|www\./i,
  // Publisher download stamps: "21698961, 2023, 1, See the wiley.com/terms-and-conditions) on".
  /\b\d{8}, \d{4}, \d{1,3},|terms-and-conditions|onlinelibrary|wiley\.com/i,
  // Front matter and page furniture.
  /\bavailable online\b|\bcontents lists available\b|\bjournal homepage\b|\bdownloaded from\b|©|\bcopyright\b|\ball rights reserved\b|\bcreative commons\b|\bcorresponding author\b|\be-?mail\b/i,
  /\b(?:received|accepted|published|revised)(?: in revised form)?:? \d{1,2} [A-Z][a-z]+ \d{4}/i,
  /^key ?words\b/i,
  /^(?:funding|acknowledg(?:e)?ments?|author contri ?butions?|conflicts? of interest|competing interests?|data availability|open research|orcid)\b/i,
  /\bsupporting information\b.*\b(?:online|found|available)\b/i,
  /\bthis is a preprint\b/i,
];

/** Figure and table captions. A delimited label starts one anywhere ("Fig. 3 e Dissolved
 *  ...", "Figure 2. ...", "Table 1: ..."); at the start of a paragraph a label followed by a
 *  capitalised word does too ("Fig. 1 Bathymetry map …", "FIGURE 7 Non-parametric …").
 *  A plain reference such as "Figure 3 shows …" stays running text. */
const CAPTION_LABEL =
  /^(?:figs?\.?|f ?i ?g ?u ?r ?e ?s?|tables?|supplementary (?:fig(?:ure)?s?|tables?)\.?|extended data fig(?:ure)?\.?)\s*S?\d+[a-z]?/i;
const CAPTION_START = new RegExp(`${CAPTION_LABEL.source}\\s*(?:[.:|–—-]|e\\s)`, "i");
const CAPTION_BLOCK_START = new RegExp(`${CAPTION_LABEL.source}\\s*(?:[.:|–—-]|e\\s|\\(|["'“‘]?[A-Z])`, "i");

function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(text));
}

function isSubstantial(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  const visible = text.replace(/\s+/g, "");
  const letters = (visible.match(/[A-Za-z]/g) ?? []).length;
  return (
    text.length >= MIN_QUOTE_SENTENCE_CHARS &&
    words >= MIN_QUOTE_SENTENCE_WORDS &&
    letters >= visible.length * 0.6
  );
}

/** Sentence boundaries inside one block: terminal punctuation, whitespace, then a capital
 *  or an opening quote/bracket before one, unless the period closes an abbreviation. A
 *  numeral after a full stop does not start a sentence ("… Fig. 2. 3 mm", "... 2014. 2015
 *  (Table 3), ..." are extraction breaks far more often than new sentences). */
function splitBlock(block: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /[.!?]["'”’)\]]*\s+/g;
  let from = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) {
    const punctEnd = match.index + match[0].trimEnd().length;
    const nextStart = match.index + match[0].length;
    if (!/^["'“‘([]?[A-Z]/.test(block.slice(nextStart))) continue;
    const head = block.slice(from, punctEnd);
    const bare = head.replace(/["'”’)\]]+$/, "");
    if (bare.endsWith(".") && isAbbreviation(bare)) continue;
    out.push({ start: from, end: punctEnd });
    from = nextStart;
  }
  if (from < block.length) out.push({ start: from, end: block.length });
  return out;
}

/** Splits a passage into sentences, keeping offsets and the block each one sits in. */
export function segmentPassage(text: string): PassageUnit[] {
  const units: PassageUnit[] = [];
  const blockRe = /\n\s*\n/g;
  const blocks: Array<{ start: number; text: string }> = [];
  let from = 0;
  let sep: RegExpExecArray | null;
  while ((sep = blockRe.exec(text))) {
    blocks.push({ start: from, text: text.slice(from, sep.index) });
    from = sep.index + sep[0].length;
  }
  blocks.push({ start: from, text: text.slice(from) });

  let inList = false;
  blocks.forEach((block, blockIndex) => {
    const lead = block.text.length - block.text.trimStart().length;
    const body = block.text.trim();
    if (!body) return;
    const base = block.start + lead;
    const captionBlock = CAPTION_BLOCK_START.test(body);
    // Items under a "Key Points:" heading are whole statements that carry no full stop;
    // the list ends at the first block that is not such an item (a heading, a label).
    const listHeading = LIST_HEADING.test(body);
    const listItem = inList && !listHeading && /^["'“‘(]?[A-Z]/.test(body) && isSubstantial(body);
    inList = listHeading || listItem;
    const spans = splitBlock(body);
    spans.forEach((span, spanIndex) => {
      let raw = body.slice(span.start, span.end);
      let offset = span.start;
      if (spanIndex === 0) {
        const heading = GLUED_HEADING.exec(raw);
        if (heading && heading[0].length < raw.length) {
          raw = raw.slice(heading[0].length);
          offset += heading[0].length;
        }
      }
      const trimmedStart = raw.length - raw.trimStart().length;
      const unitText = raw.trim();
      if (!unitText) return;
      const start = base + offset + trimmedStart;
      const kind: PassageUnitKind = isNoise(unitText)
        ? "noise"
        : captionBlock || CAPTION_START.test(unitText)
        ? "caption"
        : "text";
      const lastInListItem = listItem && spanIndex === spans.length - 1;
      units.push({
        start,
        end: start + unitText.length,
        text: unitText,
        block: blockIndex,
        kind,
        startsSentence: /^["'“‘([]?[A-Z]/.test(unitText),
        endsSentence: endsSentence(unitText) || (lastInListItem && !SENTENCE_END.test(unitText)),
        substantial: isSubstantial(unitText),
      });
    });
  });
  return units;
}

// Packet clipping

/**
 * A contiguous part of `text` of at most `cap` chars, for the answer model's packet. Text
 * within the cap is returned whole. Otherwise the clip starts at the first sentence of
 * running text (leading page furniture is skipped) and ends at the last sentence end that
 * fits; with no sentence end inside the cap it ends at a word boundary.
 */
export function clipPassage(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const units = segmentPassage(text);
  if (units.length === 0) return text.slice(0, cap).trimEnd();
  // First sentence of running text: a heading block ("Water temperature and dissolved
  // oxygen") has no sentence end in it and is skipped.
  let first = units.findIndex(
    (u, i) =>
      u.kind === "text" &&
      u.startsSentence &&
      u.substantial &&
      units.slice(i).some((v) => v.block === u.block && v.endsSentence)
  );
  if (first < 0) first = 0;
  const start = units[first].start;
  let end = -1;
  for (let j = first; j < units.length; j += 1) {
    if (units[j].end - start > cap) break;
    if (units[j].endsSentence) end = units[j].end;
  }
  if (end > start) return text.slice(start, end);
  const window = text.slice(start, start + cap);
  const space = window.lastIndexOf(" ");
  return (space > cap * 0.5 ? window.slice(0, space) : window).trimEnd();
}

/**
 * The printed excerpt for a passage that has no sentence pickVerbatimQuote may quote (a
 * fragment, a table, front matter): its opening text, whitespace collapsed, cut at a word
 * boundary and marked with "…" when longer than `cap` (the mark included). Still copied
 * from the passage, never reworded; callers flag it as not a whole-sentence quotation.
 */
export function passageExcerpt(passage: string | null | undefined, cap: number = LITERATURE_QUOTE_CHAR_CAP): string {
  const flat = collapseWhitespace(passage);
  if (flat.length <= cap) return flat;
  const window = flat.slice(0, cap - 1);
  const space = window.lastIndexOf(" ");
  return `${(space > cap * 0.5 ? window.slice(0, space) : window).trimEnd()}…`;
}

// Quotation

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "from", "have", "has",
  "had", "not", "but", "its", "their", "they", "them", "these", "those", "which", "while",
  "when", "where", "than", "then", "also", "both", "each", "such", "into", "over", "under",
  "between", "during", "after", "before", "about", "more", "most", "less", "other", "some",
  "can", "may", "might", "could", "would", "should", "will", "been", "being", "there",
  "here", "our", "your", "his", "her", "all", "any", "only", "very", "within", "without",
  "through", "per", "via", "how", "what", "who", "whom", "whose", "why", "does", "did",
  "done", "use", "used", "using", "one", "two", "however", "thus", "therefore", "because",
  "since", "although", "though", "whether", "either", "neither", "upon", "onto", "out",
  "off", "own", "same", "too", "just", "now", "yet", "you", "she", "him",
]);

/** Crude stem: the first six letters, so "hypolimnion"/"hypolimnetic" and
 *  "stratified"/"stratification" match. */
function stem(word: string): string {
  return word.length > 6 ? word.slice(0, 6) : word;
}

/** Content words and numbers of a text, citation markers removed. Also used by
 *  citation-align.ts, so quotation and alignment read words the same way. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  const cleaned = (text ?? "").replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, " ").toLowerCase();
  for (const raw of cleaned.match(/[a-z0-9]+(?:\.\d+)?/g) ?? []) {
    const numeric = /\d/.test(raw);
    if (!numeric && (raw.length < 3 || STOPWORDS.has(raw))) continue;
    out.add(numeric ? raw : stem(raw));
  }
  return out;
}

/** The answer's sentences that carry the marker [bracketNum], single or comma-grouped. A
 *  marker set after the sentence's full stop ("… declined. [3]") stays with its sentence. */
export function citingSentences(response: string | null | undefined, bracketNum: number): string {
  const out: string[] = [];
  for (const line of (response ?? "").split(/\n+/)) {
    const merged: string[] = [];
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      if (merged.length > 0 && /^(?:\[\s*\d+(?:\s*,\s*\d+)*\s*\][\s.,;:]*)+$/.test(part.trim())) {
        merged[merged.length - 1] += ` ${part}`;
      } else {
        merged.push(part);
      }
    }
    for (const sentence of merged) {
      if (bracketNumbers(sentence).includes(bracketNum)) out.push(sentence.trim());
    }
  }
  return out.join(" ");
}

interface QuoteSpan {
  start: number;
  end: number;
  first: number;
}

/** Every run of whole sentences inside one block that may be printed: it opens and closes
 *  on substantial sentences with a proper start and end, holds no page furniture, stays
 *  within `cap`, and is running text (or, when `allowCaptions`, caption text). */
function quoteSpans(units: PassageUnit[], cap: number, allowCaptions: boolean): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  const allowed = (u: PassageUnit) => u.kind === "text" || (allowCaptions && u.kind === "caption");
  for (let i = 0; i < units.length; i += 1) {
    const open = units[i];
    if (!allowed(open) || !open.startsSentence || !open.substantial) continue;
    for (let j = i; j < units.length; j += 1) {
      const close = units[j];
      if (close.block !== open.block || !allowed(close)) break;
      if (close.end - open.start > cap) break;
      if (close.endsSentence && close.substantial) spans.push({ start: open.start, end: close.end, first: i });
    }
  }
  return spans;
}

/**
 * A verbatim quotation from `passage` supporting `answerSupport` (the answer sentences
 * that cite the passage): the run of whole sentences, at most `cap` chars, with the best
 * word overlap, less a small per-char cost so a sentence is added only when it adds
 * support. Words from `retrievalText` (the item's extracted sentence) count at a lower
 * weight, as a tie-breaker and for uncited items. Running text is preferred; caption
 * sentences are used only when the passage has no running text that can be quoted. With
 * no overlap at all, the opening sentences of the running text are returned.
 *
 * The result is always text.slice(start, end) of `passage`, starting at a sentence start
 * and ending at a sentence end. Returns null when nothing in the passage qualifies.
 */
export function pickVerbatimQuote(
  passage: string | null | undefined,
  answerSupport: string | null | undefined,
  retrievalText?: string | null,
  cap: number = LITERATURE_QUOTE_CHAR_CAP
): string | null {
  const text = passage ?? "";
  if (!text.trim()) return null;
  const units = segmentPassage(text);
  let spans = quoteSpans(units, cap, false);
  if (spans.length === 0) spans = quoteSpans(units, cap, true);
  if (spans.length === 0) return null;

  const answerTokens = contentTokens(answerSupport ?? "");
  const retrievalTokens = contentTokens(retrievalText ?? "");
  const weights = new Map<string, number>();
  for (const token of retrievalTokens) weights.set(token, (/\d/.test(token) ? 2 : 1) * RETRIEVAL_TEXT_WEIGHT);
  for (const token of answerTokens) weights.set(token, /\d/.test(token) ? 2 : 1);

  let best: { span: QuoteSpan; score: number; overlap: number } | null = null;
  if (weights.size > 0) {
    for (const span of spans) {
      const tokens = contentTokens(text.slice(span.start, span.end));
      let overlap = 0;
      for (const token of tokens) overlap += weights.get(token) ?? 0;
      if (overlap <= 0) continue;
      const score = overlap - LENGTH_PENALTY_PER_CHAR * (span.end - span.start);
      const length = span.end - span.start;
      if (
        !best ||
        score > best.score + 1e-9 ||
        (Math.abs(score - best.score) <= 1e-9 &&
          (length < best.span.end - best.span.start ||
            (length === best.span.end - best.span.start && span.start < best.span.start)))
      ) {
        best = { span, score, overlap };
      }
    }
  }
  if (best) return text.slice(best.span.start, best.span.end);

  // No shared word: the opening sentences of the running text, up to LEAD_QUOTE_CHARS
  // (or the shortest span from the first opening sentence when even that is longer).
  const firstOpen = Math.min(...spans.map((s) => s.first));
  const fromFirst = spans.filter((s) => s.first === firstOpen).sort((a, b) => a.end - b.end);
  const fitting = fromFirst.filter((s) => s.end - s.start <= LEAD_QUOTE_CHARS);
  const lead = fitting.length > 0 ? fitting[fitting.length - 1] : fromFirst[0];
  return text.slice(lead.start, lead.end);
}
