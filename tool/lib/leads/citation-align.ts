// Citation alignment (switch LEADS_CITATION_ALIGN, default "on").
//
// After the claim verifier has judged the final answer (verification.ts), each answer
// sentence that carries [n] markers pointing at literature sources is compared with the
// verifier claims that came from it (matched by content-word overlap, since the verifier
// returns claim text, not offsets):
//   - when a claim is supported by literature source m and the sentence does not cite m,
//     [m] is added;
//   - a literature marker [n] is removed only when source n is not the verifier's match
//     for any claim of that sentence and its word overlap with the sentence (the share of
//     the sentence's content words found in the text the answer model saw for n) is below
//     WEAK_SUPPORT_THRESHOLD;
//   - a sentence never loses its last marker: when nothing was added and every marker
//     would go, the one with the most overlap stays.
// Markers on deterministic records (sensor, forecast, skill, freshness, constraint and
// framing records: every channel other than literature) are never added or removed, and
// a sentence with no literature marker, or with no verifier claim matched to it, is left
// exactly as written. Only markers change: every other character of the answer is kept.
// A rewritten marker group lists its numbers in ascending order in the group's own form
// ("[2][4]" or "[2, 4]"); groups that do not change still match the original.
//
// The display numbering (lib/citation-display.ts) runs on the aligned text.
//
// "off" returns the answer unchanged. The paper's benchmark runs used "off"
// (reproduce_paper/benchmark/README.md).
//
// Pure string processing: no I/O, no model calls.

import { bracketNumbers } from "./citation-brackets";
import { contentTokens } from "./lit-verbatim";
import type { LeadsChannel } from "./types";

export type CitationAlignMode = "on" | "off";

/** Read at call time so an eval harness can set it after import. "off", "0", "false" and
 *  "no" (any case) turn the switch off; unset, empty or anything else reads as "on". */
export function citationAlignMode(): CitationAlignMode {
  const raw = (process.env.LEADS_CITATION_ALIGN ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no" ? "off" : "on";
}

/** A marker is removable only when less than this share of the sentence's content words
 *  occurs in the source text. */
export const WEAK_SUPPORT_THRESHOLD = 0.15;

/** A claim belongs to the sentence holding the largest share of its content words, and
 *  only when that share is at least this and at least MIN_SHARED_TOKENS words. */
export const CLAIM_SENTENCE_MIN_OVERLAP = 0.5;
const MIN_SHARED_TOKENS = 2;

/** One evidence item, by position (marker [n] is sources[n - 1]). `text` is what the
 *  answer model was shown for it. */
export interface CitationAlignSource {
  channel: LeadsChannel;
  text: string;
}

/** The verifier fields alignment reads (LeadsClaimAssessment is assignable to it). */
export interface CitationAlignClaim {
  text: string;
  supported: boolean;
  /** 1-based marker number of the source the verifier matched, or null. */
  bracketNum?: number | null;
}

export interface CitationAlignChange {
  /** 1-based sentence number in the answer. */
  sentence: number;
  added: number[];
  removed: number[];
}

export interface CitationAlignResult {
  text: string;
  changes: CitationAlignChange[];
}

// Same marker grammar as citation-brackets.ts. A run is adjacent markers, optionally
// separated by spaces or tabs: "[1][2]", "[1] [2]", "[1, 2]".
const MARKER_SRC = "\\[\\s*\\d+(?:\\s*,\\s*\\d+)*\\s*\\]";
const RUN_SRC = `${MARKER_SRC}(?:[ \\t]*${MARKER_SRC})*`;
const MARKER_ONLY = new RegExp(`^(?:${MARKER_SRC}[\\s.,;:]*)+$`);

interface Span {
  start: number;
  end: number;
}

/**
 * Sentence spans of an answer, split the way citingSentences (lit-verbatim.ts) splits it:
 * per line, after . ! or ? followed by whitespace, with a part made only of markers kept
 * with the sentence before it ("… declined. [3]").
 */
export function answerSentenceSpans(response: string): Span[] {
  const spans: Span[] = [];
  for (const line of response.matchAll(/[^\n]+/g)) {
    const base = line.index ?? 0;
    const text = line[0];
    const parts: Span[] = [];
    let from = 0;
    for (const sep of text.matchAll(/(?<=[.!?])\s+/g)) {
      const at = sep.index ?? 0;
      parts.push({ start: from, end: at });
      from = at + sep[0].length;
    }
    parts.push({ start: from, end: text.length });
    let lineSpans = 0;
    for (const part of parts) {
      const piece = text.slice(part.start, part.end);
      if (!piece.trim()) continue;
      if (lineSpans > 0 && MARKER_ONLY.test(piece.trim())) {
        spans[spans.length - 1].end = base + part.end;
        continue;
      }
      spans.push({ start: base + part.start, end: base + part.end });
      lineSpans += 1;
    }
  }
  return spans;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
}

/** Index of the sentence each claim came from, or -1 when none qualifies. */
function claimSentences(claims: CitationAlignClaim[], sentenceTokens: Set<string>[]): number[] {
  return claims.map((claim) => {
    const tokens = contentTokens(claim.text ?? "");
    if (tokens.size === 0) return -1;
    let best = -1;
    let bestShare = 0;
    let bestSentenceShare = 0;
    sentenceTokens.forEach((sentence, index) => {
      const shared = overlapCount(tokens, sentence);
      if (shared < MIN_SHARED_TOKENS) return;
      const share = shared / tokens.size;
      const sentenceShare = sentence.size > 0 ? shared / sentence.size : 0;
      if (
        share > bestShare + 1e-9 ||
        (Math.abs(share - bestShare) <= 1e-9 && sentenceShare > bestSentenceShare + 1e-9)
      ) {
        best = index;
        bestShare = share;
        bestSentenceShare = sentenceShare;
      }
    });
    return bestShare >= CLAIM_SENTENCE_MIN_OVERLAP ? best : -1;
  });
}

interface Run {
  start: number;
  end: number;
  raw: string;
  nums: number[];
}

function formatRun(raw: string, nums: number[]): string {
  if (/\[[^\]]*,/.test(raw)) return `[${nums.join(", ")}]`;
  const sep = /\]([ \t]*)\[/.exec(raw)?.[1] ?? "";
  return nums.map((n) => `[${n}]`).join(sep);
}

/**
 * Aligns the literature markers of `response` with the verifier's matches (see the module
 * comment). `claims` are the verifier's claims for exactly this text; `sources` are the
 * evidence items the markers number, with the text the answer model saw for each.
 * With mode "off", or when nothing qualifies, returns `response` itself and no changes.
 */
export function alignCitations(
  response: string,
  claims: CitationAlignClaim[],
  sources: CitationAlignSource[],
  mode: CitationAlignMode
): CitationAlignResult {
  if (mode !== "on" || !response || claims.length === 0) return { text: response, changes: [] };
  const isLiterature = (n: number) => n >= 1 && n <= sources.length && sources[n - 1]?.channel === "literature";
  if (!sources.some((s) => s.channel === "literature")) return { text: response, changes: [] };

  const spans = answerSentenceSpans(response);
  const sentenceTexts = spans.map((s) => response.slice(s.start, s.end));
  const sentenceTokens = sentenceTexts.map((t) => contentTokens(t));
  const owner = claimSentences(claims, sentenceTokens);
  const sourceTokens = new Map<number, Set<string>>();
  const support = (n: number, sentence: number): number => {
    const tokens = sentenceTokens[sentence];
    if (tokens.size === 0) return 0;
    let src = sourceTokens.get(n);
    if (!src) {
      src = contentTokens(sources[n - 1]?.text ?? "");
      sourceTokens.set(n, src);
    }
    return overlapCount(tokens, src) / tokens.size;
  };

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const changes: CitationAlignChange[] = [];

  spans.forEach((span, s) => {
    const sentence = sentenceTexts[s];
    const runs: Run[] = [...sentence.matchAll(new RegExp(RUN_SRC, "g"))].map((m) => ({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      raw: m[0],
      nums: bracketNumbers(m[0]),
    }));
    const present = [...new Set(runs.flatMap((r) => r.nums))];
    const literature = present.filter(isLiterature);
    if (literature.length === 0) return;
    const mine = claims.filter((_, c) => owner[c] === s);
    if (mine.length === 0) return;

    const matched = new Set(
      mine.map((c) => c.bracketNum).filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    );
    const added = [
      ...new Set(
        mine
          .filter((c) => c.supported && typeof c.bracketNum === "number" && isLiterature(c.bracketNum))
          .map((c) => c.bracketNum as number)
          .filter((n) => !present.includes(n))
      ),
    ].sort((a, b) => a - b);
    const weak = literature.filter((n) => !matched.has(n) && support(n, s) < WEAK_SUPPORT_THRESHOLD);
    let removed = weak;
    if (added.length === 0 && weak.length === present.length) {
      // No alternative from the verifier: keep the marker with the most overlap.
      let keep = weak[0];
      for (const n of weak) if (support(n, s) > support(keep, s) + 1e-9) keep = n;
      removed = weak.filter((n) => n !== keep);
    }
    if (added.length === 0 && removed.length === 0) return;

    // Each added number joins the literature run whose preceding words best match the
    // claim that cites it; ties go to a run losing a marker, then to the later run.
    const candidates = runs.filter((r) => r.nums.some(isLiterature));
    const additions = new Map<Run, number[]>();
    for (const m of added) {
      const claimTokens = contentTokens(
        mine.filter((c) => c.supported && c.bracketNum === m).map((c) => c.text).join(" ")
      );
      let target = candidates[candidates.length - 1];
      let bestScore = -1;
      candidates.forEach((run, r) => {
        const clauseStart = r === 0 ? 0 : candidates[r - 1].end;
        const score = overlapCount(claimTokens, contentTokens(sentence.slice(clauseStart, run.start)));
        const losing = run.nums.some((n) => removed.includes(n));
        const targetLosing = target.nums.some((n) => removed.includes(n));
        if (score > bestScore || (score === bestScore && (losing || !targetLosing))) {
          target = run;
          bestScore = score;
        }
      });
      additions.set(target, [...(additions.get(target) ?? []), m]);
    }

    for (const run of runs) {
      const extra = additions.get(run) ?? [];
      const touched = extra.length > 0 || run.nums.some((n) => removed.includes(n));
      if (!touched) continue;
      const nums = [...new Set([...run.nums.filter((n) => !removed.includes(n)), ...extra])].sort((a, b) => a - b);
      if (nums.length > 0) {
        edits.push({ start: span.start + run.start, end: span.start + run.end, text: formatRun(run.raw, nums) });
      } else {
        // The run is emptied: drop it with the spaces before it ("rises [1]," becomes "rises,").
        const lead = /[ \t]*$/.exec(sentence.slice(0, run.start))?.[0].length ?? 0;
        edits.push({ start: span.start + run.start - lead, end: span.start + run.end, text: "" });
      }
    }
    changes.push({ sentence: s + 1, added, removed: [...removed].sort((a, b) => a - b) });
  });

  if (edits.length === 0) return { text: response, changes: [] };
  let text = response;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return { text, changes };
}

/** One log line per changed sentence: "[citation-align] sentence 3: +[4] -[1]". */
export function describeCitationAlignment(changes: CitationAlignChange[]): string[] {
  return changes.map((change) => {
    const parts = [
      change.added.length > 0 ? `+${change.added.map((n) => `[${n}]`).join("")}` : "",
      change.removed.length > 0 ? `-${change.removed.map((n) => `[${n}]`).join("")}` : "",
    ].filter(Boolean);
    return `[citation-align] sentence ${change.sentence}: ${parts.join(" ")}`;
  });
}
