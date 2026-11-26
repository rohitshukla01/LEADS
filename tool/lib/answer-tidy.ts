/**
 * Display-time tidy of an answer's text: citation runs in ascending order, the one
 * spelling the answer shares with the skill card ("skilful"), and ensemble counts at the
 * edge of the ensemble written as counts ("0 of 221", not "0% (0 of 221)"). Pure and
 * deterministic; it imports nothing and makes no model call.
 *
 * Applied only where an answer is displayed, after display renumbering
 * (lib/citation-display.ts): the answer bubble and claim list (app/page.tsx citationView)
 * and every PDF mode (lib/report.ts). The stored message, cache, session memory, claim
 * check, citation alignment, Layer 3 and the evaluation traces keep the pipeline's text;
 * scripts/check-answer-tidy.ts asserts that no module under lib/leads or app/api imports
 * this file.
 *
 * Why after renumbering: display numbers follow first appearance, so a run that is
 * ascending in pipeline numbers (e.g. [1][3][10][12]) can read [6][2][3][4] once
 * renumbered. Sorting a run on display numbers keeps the order of first appearance -
 * numbers first seen in a run are larger than every earlier one and already ascending -
 * so renumbering the tidied text is a no-op and every chip keeps its card.
 *
 * Setting NEXT_PUBLIC_LEADS_ANSWER_TIDY=false returns the text unchanged.
 */

export const ANSWER_TIDY_ENABLED = process.env.NEXT_PUBLIC_LEADS_ANSWER_TIDY !== "false";

// Same marker grammar as citation-align.ts and citation-display.ts: "[12]", "[4, 6]",
// "[ 7 , 8 ]". A run is adjacent markers, optionally separated by spaces or tabs:
// "[1][2]", "[1] [2]", "[1, 2]". A RegExp is built per call so no lastIndex is shared.
const MARKER_SRC = "\\[\\s*\\d+(?:\\s*,\\s*\\d+)*\\s*\\]";
const RUN_SRC = `${MARKER_SRC}(?:[ \\t]*${MARKER_SRC})*`;

/** The verdict banner (a Markdown blockquote line) is deterministic text: never tidied. */
const BANNER_LINE = /^\s*>/;

/** Quoted text ("…" or “…” on one line) keeps its spelling, e.g. a paper title. */
const QUOTED_SRC = "\"[^\"\\n]*\"|\u201C[^\u201D\\n]*\u201D";

/** Never rewritten by either tidy: a URL or DOI token (to the next whitespace) and an
 *  inline code span. A web address or a code snippet may legitimately contain
 *  "skillful" or bracketed numbers that are not citations. */
const VERBATIM_SRC = "(?:https?:\\/\\/|www\\.|doi:|DOI:)\\S+|`[^`\\n]*`";

/** Apply `fix` to the parts of `line` outside the spans `keepSrc` matches. */
function outside(line: string, keepSrc: string, fix: (s: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(new RegExp(keepSrc, "g"))) {
    const at = m.index ?? 0;
    out += fix(line.slice(last, at)) + m[0];
    last = at + m[0].length;
  }
  return out + fix(line.slice(last));
}

/** Same output form as citation-align.ts formatRun: the comma form when the run had a
 *  comma group, otherwise the run's own separator between bracket markers. */
function formatRun(raw: string, nums: number[]): string {
  if (/\[[^\]]*,/.test(raw)) return `[${nums.join(", ")}]`;
  const sep = /\]([ \t]*)\[/.exec(raw)?.[1] ?? "";
  return nums.map((n) => `[${n}]`).join(sep);
}

/** Sort every run of two or more citation numbers ascending and drop repeats
 *  ([6][2][3][4] -> [2][3][4][6], [3][3] -> [3], [4, 2] -> [2, 4]). A run already in
 *  order without repeats, single markers and non-adjacent markers are returned as is. */
export function tidyCitationRuns(line: string): string {
  if (!line || !line.includes("[")) return line ?? "";
  return outside(line, VERBATIM_SRC, (part) => part.replace(new RegExp(RUN_SRC, "g"), (raw: string) => {
    const nums = [...raw.matchAll(/\d+/g)].map((m) => Number.parseInt(m[0], 10));
    if (nums.length < 2) return raw;
    const sorted = [...new Set(nums)].sort((a, b) => a - b);
    const unchanged = sorted.length === nums.length && sorted.every((n, i) => n === nums[i]);
    return unchanged ? raw : formatRun(raw, sorted);
  }));
}

function fixSkilful(s: string): string {
  return s.replace(/\b([Uu]n)?([Ss])killful(ly|ness)?\b/g, "$1$2kilful$3");
}

/** "skillful" -> "skilful" (also Skillful, skillfully, unskillful, skillfulness), the
 *  spelling of the skill card, the skill record and the PDF key. All-caps words, text
 *  inside quotation marks, URLs and inline code are left as written. */
export function tidySpelling(line: string): string {
  if (!line || !/killful/.test(line)) return line ?? "";
  return outside(line, `${QUOTED_SRC}|${VERBATIM_SRC}`, fixSkilful);
}

// "0% (0 of 221)", "0% of ensemble members (0 of 221)", "100% (221 of 221 members)". Rule 9a
// of the answer prompt forbids 0% and 100% for an ensemble count: a share at the ensemble's
// resolution limit reads as impossible or certain. A RegExp is built per call.
const EDGE_SHARE_SRC =
  "(?<![\\d.,])(0|100)(?:\\.0+)?\\s?%(?:\\s+of\\s+(?:the\\s+)?((?:ensemble\\s+)?members))?\\s*\\((\\d+)\\s+of\\s+(\\d+)(\\s+(?:ensemble\\s+)?members)?\\)";

/** "0% (0 of N)" -> "0 of N" and "100% (N of N)" -> "N of N", keeping any "ensemble
 *  members" noun ("0% of ensemble members (0 of N)" -> "0 of N ensemble members"). Only
 *  the redundant percentage goes; the count is kept as written. A percentage that does not
 *  match its count (e.g. "0% (3 of 221)"), any other percentage, URLs and inline code are
 *  left as written. */
export function tidyMemberCounts(line: string): string {
  if (!line || !line.includes("%")) return line ?? "";
  return outside(line, VERBATIM_SRC, (part) => part.replace(new RegExp(EDGE_SHARE_SRC, "g"),
    (raw: string, pct: string, nounBefore: string | undefined, k: string, n: string, nounAfter: string | undefined) => {
      const consistent = pct === "0" ? Number(k) === 0 : Number(k) === Number(n) && Number(n) > 0;
      if (!consistent) return raw;
      const noun = nounBefore ? ` ${nounBefore.replace(/\s+/g, " ")}` : nounAfter ? nounAfter.replace(/\s+/g, " ") : "";
      return `${k} of ${n}${noun}`;
    }));
}

/** Tidy an answer as displayed, line by line; banner lines in the result match the input.
 *  Missing text yields "". Idempotent. */
export function tidyAnswerText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  if (!ANSWER_TIDY_ENABLED || !text) return text;
  return text
    .split("\n")
    .map((line) => (BANNER_LINE.test(line) ? line : tidyMemberCounts(tidySpelling(tidyCitationRuns(line)))))
    .join("\n");
}
