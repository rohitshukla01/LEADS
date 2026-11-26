/**
 * Canonical parser for the answer's inline citation markers.
 *
 * The synthesis model writes citations two ways and both are legitimate:
 *   - repeated singles   "[4][6][7][15]"
 *   - a comma-grouped set "[4, 6, 7, 15]"
 *
 * Both forms must be recognised: otherwise a grouped citation leaves its sentence
 * uncited in the citation-presence score (which can trigger a retry), its evidence
 * items unflagged as `citedInAnswer`, and the verifier without them. The pipeline
 * modules import this definition; lib/citation-display.ts, which imports nothing,
 * keeps a copy of the same grammar.
 *
 * The exported helpers build their own RegExp per call rather than sharing a
 * module-level /g instance - a shared global regex carries `lastIndex` between
 * calls and would intermittently skip matches.
 */

/** `[12]`, `[4, 6, 7, 15]`, or `[ 7 , 8 ]` - a bracket holding one or more
 *  comma-separated numbers, tolerant of padding whitespace. Requires at least one
 *  digit, so prose brackets like `[see note]` are never matched. */
const BRACKET_SRC = "\\[\\s*(\\d+(?:\\s*,\\s*\\d+)*)\\s*\\]";

/** Every citation number in `text`, in order of appearance, groups expanded.
 *  Duplicates are preserved - callers that want a set can build one. */
export function bracketNumbers(text: string): number[] {
  const out: number[] = [];
  if (!text) return out;
  for (const match of text.matchAll(new RegExp(BRACKET_SRC, "g"))) {
    for (const part of match[1].split(/\s*,\s*/)) {
      const n = Number.parseInt(part, 10);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

/** True when `text` contains at least one citation marker (either form). */
export function hasCitation(text: string): boolean {
  return !!text && new RegExp(BRACKET_SRC).test(text);
}
