/**
 * Alias matching: does a text name a reservoir or a water-quality variable?
 *
 * Shared by every consumer of SITE_ALIASES / VARIABLE_ALIASES - the planner
 * (router.ts), the forecast channel's variable fallback (forecast.ts), the
 * literature concept boost (literature.ts) and the Layer-3 answer audit
 * (layer3-validation.ts) - so one set of rules applies everywhere.
 *
 * Plain substring matching (`text.includes(alias)`) lets short aliases match inside
 * ordinary words: "do" inside "does", "dose", "random", "document"; "ions" inside
 * "questions" and "conditions"; "temp" inside "temporal"; "ccr" inside "accretion".
 * A "How does …" question would then pull in dissolved oxygen, whose forecast rows
 * displace the variable actually asked about, and an answer saying "chlorophyll-a
 * does not exceed 20 µg/L" would pass the Layer-3 check that DO had been reported.
 *
 * Rules
 *  1. Aliases longer than 4 characters match as substrings ("oxygen" in
 *     "oxygenation", "bloom" in "blooms").
 *  2. Shorter aliases match only as a whole word, optionally followed by a plural
 *     "s" or by digits ("temps", "FCR50").
 *  3. "temp" also matches as a prefix, so misspellings resolve ("temprature"), but
 *     not the tempo-/templ-/tempt- families ("temporal", "template").
 *  4. "do", and the DO-saturation phrases that start with it, must read as the
 *     abbreviation rather than the English verb - see isDissolvedOxygenAt.
 *  5. A variable's own id stem ("do_mgl", "chla_ugl", "temp_c") matches as a
 *     substring, so sensor column names such as "RDO_mgL_9" resolve.
 *
 * Guarded by scripts/check-alias-matching.ts.
 */
import { SITE_ALIASES, VARIABLE_ALIASES } from "./config";

const WHOLE_WORD_MAX_LENGTH = 4;
const DO_ABBREVIATION = "do";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PREFIX_ALIASES: Record<string, RegExp> = {
  temp: /(?:^|[^a-z0-9])temp(?![olt])/,
};

/** Start offsets of every match of an alias in lower-cased text, under rules 1-3. */
function termOffsets(lower: string, term: string): number[] {
  const prefix = PREFIX_ALIASES[term];
  const re = prefix
    ? new RegExp(prefix.source, "g")
    : term.length > WHOLE_WORD_MAX_LENGTH
      ? new RegExp(escapeRegExp(term), "g")
      : new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:s|\\d+)?(?=[^a-z0-9]|$)`, "g");
  const out: number[] = [];
  for (const m of lower.matchAll(re)) {
    const lead = m[0].length - m[0].replace(/^[^a-z0-9]/, "").length;
    out.push((m.index ?? 0) + lead);
  }
  return out;
}

/** Rules 1-3 for an alias against lower-cased text. */
export function mentionsTerm(lower: string, term: string): boolean {
  return termOffsets(lower, term).length > 0;
}

// Rule 4: "do" the abbreviation vs "do" the verb
//
// The verb occupies predictable slots: after a wh-word ("what do"), after a
// subject or "to" ("we do", "to do"), after an auxiliary with a subject in between
// ("should managers do", "how did the model do"), and at the start of a yes/no
// question followed by its subject ("Do levels exceed …?"). The abbreviation sits
// in noun slots: after a copula, preposition or modifier ("is do low", "effect on
// do", "hypolimnetic do"), as the subject of a change verb ("will do fall below
// 2"), before a measurement ("do at 9 m", "do < 2 mg/L", "do trend") and in terse
// queries ("fcr do forecast"). Capitalised "DO" in otherwise mixed-case text is the
// abbreviation outright.

const WH_WORDS = new Set(["what", "how", "why", "when", "where", "which", "who", "whom", "whose"]);
const SUBJECTS_AND_INFINITIVE = new Set(["to", "not", "we", "you", "they", "i", "he", "she", "it", "that", "us"]);
const AUXILIARIES = new Set(["will", "would", "can", "could", "should", "shall", "may", "might", "must", "does", "did", "do"]);
const COPULAS = new Set(["is", "are", "was", "were", "be", "been", "being", "has", "have", "had"]);
const PREPOSITIONS = new Set([
  "of", "in", "on", "about", "for", "at", "with", "from", "into", "regarding", "vs", "versus", "than", "between", "like",
]);
const DO_MODIFIERS = new Set([
  "low", "high", "surface", "bottom", "deep", "deepwater", "hypolimnetic", "epilimnetic", "metalimnetic",
  "mean", "average", "avg", "daily", "minimum", "maximum", "min", "max", "observed", "measured",
  "forecasted", "predicted", "modelled", "modeled", "the", "current", "latest",
  "fcr", "bvr", "ccr", "fcre", "bvre", "ccre",
]);
const SITE_MODIFIERS = new Set(["fcr", "bvr", "ccr", "fcre", "bvre", "ccre"]);
const DETERMINERS = new Set(["the", "a", "an", "this", "that", "our", "their", "its", "his", "her"]);
const TO_TAKING = new Set(["related", "relate", "relates", "linked", "compared", "relative", "sensitive", "happens", "happened", "happen", "due", "respond", "responds", "response", "responses", "contribute", "contributes", "sensitivity", "tied", "coupled", "connected", "similar", "close", "attributable"]);
// A transitive verb right before "do" takes it as its object: "can you show do at fcr".
const VERBS_TAKING_DO = new Set([
  "show", "shows", "plot", "plots", "compare", "compares", "give", "list", "display", "report", "see", "check",
  "monitor", "measure", "map", "graph", "chart", "explain", "describe", "predict", "predicts", "affect", "affects",
  "drive", "drives", "control", "controls", "influence", "influences", "track", "estimate", "analyze", "analyse",
  "me", "get", "gets", "pull", "download", "send", "summarize", "summarise", "visualize", "visualise", "raise", "raises",
  "improve", "improves", "increase", "increases", "reduce", "reduces", "lower", "lowers", "boost", "boosts", "restore",
  "maintain", "keep", "keeps", "impact", "impacts", "change", "changes", "alter", "alters", "simulate", "simulates",
  "include", "need", "want", "provide", "fetch", "compute", "calculate", "quantify", "assess", "evaluate", "review",
  "watch", "deplete", "depletes", "consume", "consumes", "cause", "causes", "expect", "expects", "bring", "brings",
]);
const DEGREE_ADVERBS = new Set(["how", "so", "too", "as"]);
const EMPHATIC_SUBJECTS = new Set(["we", "you", "they", "i", "he", "she"]);
const CLAUSE_JOINERS = new Set(["and", "or", "but"]);
const CHANGE_VERB_WORDS =
  "fall|falls|fell|drop|drops|dropped|decline|declines|declined|decrease|decreases|decreased|increase|increases|increased|rise|rises|rose|change|changes|changed|stay|stays|remain|remains|recover|recovers|reach|reaches|exceed|exceeds|vary|varies|go|goes|get|gets|dip|dips|sink|sinks|respond|responds|evolve|evolves|compare|compares|look|looks|behave|behaves|start|starts|begin|begins|continue|continues|become|becomes|hit|hits|approach|approaches|return|returns|be";
const CHANGE_VERB = new RegExp(`^\\s*(?:${CHANGE_VERB_WORDS})\\b`);
const MEASUREMENT_TAIL =
  /^\s*(?:<|>|≤|≥|=|\d|mg\b|%|below\b|above\b|(?:under|over)\s+\d|at\s+\d|levels?\b|concentrations?\b|conc\b|values?\b|readings?\b|profiles?\b|trends?\b|trajectory\b|dynamics\b|depletion\b|minim|maxim|sat\b|saturation\b|data\b|forecasts?\b|sensor\b)/;
// After a clause start "do" is usually the auxiliary of a yes/no question ("Do
// levels exceed ...?"), so only tails that cannot begin its subject count as nouns.
const CLAUSE_INITIAL_NOUN_TAIL =
  /^\s*(?:$|[?.!,;:)/(&+@\]]|-\s*(?:sat\b|doc\b|\d)|ppm\b|and\b|vs\b|versus\b|or\b|at\b|in\b|on\b|<|>|≤|≥|=|\d|mg\b|%|below\b|above\b|trends?\b|trajectory\b|profiles?\b|depletion\b|minim|maxim|sat\b|saturation\b|conc\b|concentration\b|forecast\s+(?:for|at|in|next|over)\b|forecast\s*$|(?:levels?|values?|readings?|data|concentrations?)\s*(?:$|[?.!,]|(?:at|in|for|on)\b)|(?:is|was|has|had|are|were|dropped|fell|rose|declined|increased|decreased|changed|remained|stayed|dipped|status|outlook)\b)/;
// "will do at bvr drop below 2": a site between the auxiliary and the change verb.
const SITE_THEN_CHANGE = new RegExp(
  `^\\s*(?:at|in)\\s+(?:fcre?|bvre?|ccre?|falling creek|beaverdam|carvins cove)\\b[^.?!]{0,30}?\\b(?:${CHANGE_VERB_WORDS})\\b`,
);
const VERB_OBJECT_TAIL = /^\s*(?:it|this|that|something|anything|nothing|more|less|better|worse|so|differently|about|not|you|we|they|i|the|a|an|well|poorly|when|if|while|because)\b/;
// A finite verb straight after "do" makes "do" its subject ("when do hits zero",
// "do dropped below 2"); the auxiliary "do" is followed by its subject, never by this.
const FINITE_VERB_AFTER =
  /^\s*(?:is|was|has|had|falls|fell|drops|dropped|declines|declined|decreases|decreased|increases|increased|rises|rose|changes|changed|stays|stayed|remains|remained|recovers|recovered|reaches|reached|exceeds|exceeded|varies|varied|goes|went|dips|dipped|sinks|sank|hits|starts|started|begins|began|becomes|became|returns|returned)\b/;
// Nouns that "do" can only modify ("fcr do data", "the do levels").
const NOUN_HEAD_TAIL =
  /^\s*(?:levels?|concentrations?|conc|values?|readings?|profiles?|trends?|trajectory|dynamics|depletion|data|sensor|saturation|sat)\b/;

// The grammar check looks at most this far either side of a "do", so its cost stays
// linear in text length (a long pasted text of "… we do …" must not stall a request).
const CONTEXT_WINDOW = 200;

function wordsBefore(lower: string, index: number): { previous: string; beforePrevious: string; clauseStart: boolean; clause: string } {
  const before = lower.slice(Math.max(0, index - CONTEXT_WINDOW), index);
  const clause = before.split(/[.?!;:–—,]|\s-\s/).pop() ?? "";
  const words = clause.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[^a-z0-9']/g, ""));
  return {
    previous: words[words.length - 1] ?? "",
    beforePrevious: words[words.length - 2] ?? "",
    clauseStart: words.length === 0,
    clause,
  };
}

/** Is the whole-word "do" starting at `index` the dissolved-oxygen abbreviation? */
export function isDissolvedOxygenAt(original: string, lower: string, index: number): boolean {
  const token = original.slice(index, index + 2);
  const after = lower.slice(index + 2, index + 2 + CONTEXT_WINDOW);
  // "do not" / "don't" is the verb, including capitalised emphasis ("You DO NOT need …").
  if (/^\s*(?:not\b|n't\b)/.test(after)) return false;
  if (FINITE_VERB_AFTER.test(after)) return true;
  const { previous, beforePrevious, clauseStart, clause } = wordsBefore(lower, index);
  // Case carries the signal in mixed-case text: sentence-initial "Do" is the
  // auxiliary ("Do profiles at FCR show …?"), and "DO" after a subject pronoun is
  // emphasis ("What should we DO about …", "I DO see …"), not the abbreviation.
  if (token === "Do") return false;
  if (token === "DO" && EMPHATIC_SUBJECTS.has(previous)) return false;
  if (token === "DO") {
    const left = /([A-Za-z]+)[^A-Za-z]*$/.exec(original.slice(Math.max(0, index - CONTEXT_WINDOW), index))?.[1] ?? "";
    const right = /^[^A-Za-z]*([A-Za-z]+)/.exec(original.slice(index + 2, index + 2 + CONTEXT_WINDOW))?.[1] ?? "";
    // Mixed-case neighbourhood: capitals are deliberate, so "DO" is the abbreviation.
    // All-caps text carries no case signal and falls through to the grammar below.
    if (/[a-z]/.test(left) || /[a-z]/.test(right)) return true;
  }

  if (previous === "to" && TO_TAKING.has(beforePrevious)) return true; // "related to do", "happens to do"
  if (previous === "it" && COPULAS.has(beforePrevious)) return true;  // "is it do or temperature"
  if (SUBJECTS_AND_INFINITIVE.has(previous)) return false;            // "we do", "to do"
  if (WH_WORDS.has(previous)) return false;                           // "what do", "how do"
  if (AUXILIARIES.has(previous)) return CHANGE_VERB.test(after) || MEASUREMENT_TAIL.test(after) || SITE_THEN_CHANGE.test(after); // "will do fall" vs "can do it"
  if (COPULAS.has(previous)) return true;                             // "is do low", "has do changed"
  if (PREPOSITIONS.has(previous)) return true;                        // "effect on do"
  if (DEGREE_ADVERBS.has(beforePrevious) && DO_MODIFIERS.has(previous)) return false; // "how high do …"
  if (VERBS_TAKING_DO.has(previous) && !DETERMINERS.has(beforePrevious)) return true; // "show do at fcr", not "the plot do"
  if (DO_MODIFIERS.has(previous) && !SITE_MODIFIERS.has(previous)) return true;      // "the do", "low do" even after an auxiliary
  const clauseWords = clause.trim().split(/\s+/).map((w) => w.replace(/[^a-z0-9']/g, ""));
  if (clauseWords.slice(0, -1).some((w) => AUXILIARIES.has(w))) {
    // Auxiliary earlier in the clause with a subject in between: "should managers
    // do ...", "how did the model do ...", unless "do" heads the subject ("will
    // hypolimnetic do fall ...").
    return CHANGE_VERB.test(after) || NOUN_HEAD_TAIL.test(after);
  }
  if (DO_MODIFIERS.has(previous)) return true;                        // "hypolimnetic do", "fcr do"
  if (clauseStart || CLAUSE_JOINERS.has(previous)) return CLAUSE_INITIAL_NOUN_TAIL.test(after);
  // wh-question inversion with no earlier auxiliary: "which variables do you …", "how well do …"
  const whLead = WH_WORDS.has(clauseWords[0]) || (PREPOSITIONS.has(clauseWords[0]) && WH_WORDS.has(clauseWords[1] ?? ""));
  if (whLead) return MEASUREMENT_TAIL.test(after) || CHANGE_VERB.test(after) || /^\s*to\s/.test(after);
  if (VERB_OBJECT_TAIL.test(after)) return false;
  return true;                                                        // terse: "show me do at fcr"
}

function wholeWordIndices(lower: string, phrase: string): number[] {
  const re = new RegExp(`(?:^|[^a-z0-9])(${escapeRegExp(phrase)})(?=[^a-z0-9]|$)`, "g");
  const out: number[] = [];
  for (const m of lower.matchAll(re)) out.push((m.index ?? 0) + m[0].length - m[1].length);
  return out;
}

/** One alias against a text, applying rules 1-4. `original` keeps its case. */
export function mentionsAlias(original: string, lower: string, alias: string): boolean {
  if (alias === DO_ABBREVIATION || alias.startsWith(`${DO_ABBREVIATION} `)) {
    return wholeWordIndices(lower, alias).some((i) => isDissolvedOxygenAt(original, lower, i));
  }
  return mentionsTerm(lower, alias);
}

function idStem(variable: string): string {
  return variable.toLowerCase().replace(/_(mean|sample)$/, "");
}

function variableTerms(variable: string): string[] {
  return [...(VARIABLE_ALIASES[variable] ?? []), idStem(variable)];
}

/** Does the text name this variable (rules 1-5)? */
export function mentionsVariable(text: string, variable: string): boolean {
  const lower = text.toLowerCase();
  return variableTerms(variable).some((alias) => mentionsAlias(text, lower, alias));
}

/** Every VARIABLE_ALIASES key the text names, in config order. */
export function variablesMentioned(text: string): string[] {
  return Object.keys(VARIABLE_ALIASES).filter((variable) => mentionsVariable(text, variable));
}

/** Every SITE_ALIASES key the text names, in config order. */
export function sitesMentioned(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.entries(SITE_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => mentionsTerm(lower, alias)))
    .map(([site]) => site);
}

/** Every mention of the variable (start offset and matched alias length), for
 *  callers that inspect the surrounding text (e.g. "is a number reported next to it?"). */
export function variableMentions(text: string, variable: string): Array<{ index: number; length: number }> {
  const lower = text.toLowerCase();
  const found = new Map<number, number>();
  for (const alias of variableTerms(variable)) {
    const offsets = alias === DO_ABBREVIATION || alias.startsWith(`${DO_ABBREVIATION} `)
      ? wholeWordIndices(lower, alias).filter((i) => isDissolvedOxygenAt(text, lower, i))
      : termOffsets(lower, alias);
    for (const i of offsets) found.set(i, Math.max(found.get(i) ?? 0, alias.length));
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([index, length]) => ({ index, length }));
}
