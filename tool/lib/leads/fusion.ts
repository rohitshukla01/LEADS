import type { LeadsChannel, LeadsEvidence } from "./types";

export interface LeadsFusionResult {
  evidence: LeadsEvidence[];
  retrievalSummary: Record<LeadsChannel, number>;
  retrievalConfidence: number;
}

export function fuseEvidence(groups: Record<LeadsChannel, LeadsEvidence[]>): LeadsFusionResult {
  const flattened = (Object.entries(groups) as Array<[LeadsChannel, LeadsEvidence[]]>).flatMap(
    ([channel, evidence]) =>
      evidence.map((item, index) => ({
        ...item,
        score: Math.max(
          0.1,
          item.score +
            (channel === "sensor" ? 0.06 : 0) +
            (channel === "forecast" ? 0.04 : 0) -
            index * 0.01
        ),
      }))
  );

  const sorted = flattened.sort((left, right) => right.score - left.score);

  // Diversity constraint: reserve up to 8 literature slots so high-scoring
  // forecast/sensor evidence does not crowd out scientific grounding.
  // Non-literature still gets 16 − litSlots slots, so it is never starved.
  // Literature items are taken from the top of their own ranked list and
  // injected before the final slice, then the whole pool is re-sorted so
  // scoring order is preserved within the combined set.
  const litItems = sorted.filter((e) => e.channel === "literature");
  const nonLitItems = sorted.filter((e) => e.channel !== "literature");

  // Near-duplicate suppression. Chunk overlap in the corpus can produce two
  // snippets from one paper that restate each other almost verbatim (Jaccard
  // ≈ 0.68), so a marker string like [4][5][6] would imply independent supports
  // that are really one source.
  //
  // Only same-document repeats are dropped: two different papers making the same
  // point is independent corroboration and must survive. The higher-scoring chunk
  // wins (litItems is score-sorted), and the freed slot goes to the next-best
  // chunk, which is often a different paper, so source diversity improves without
  // being forced at the cost of relevance.
  const NEAR_DUP = 0.6;
  const bagOf = (t: string) => new Set((t ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter += 1;
    return inter / (a.size + b.size - inter);
  };
  const keptLit: typeof litItems = [];
  const keptBags: Array<{ doc: string; bag: Set<string> }> = [];
  for (const item of litItems) {
    const doc = item.provenance.docName ?? item.title ?? "";
    const bag = bagOf(item.text);
    if (keptBags.some((k) => k.doc === doc && jaccard(k.bag, bag) >= NEAR_DUP)) continue;
    keptLit.push(item);
    keptBags.push({ doc, bag });
  }

  const litSlots = Math.min(keptLit.length, 8);
  const nonLitSlots = Math.min(nonLitItems.length, 16 - litSlots);
  const evidence = [...nonLitItems.slice(0, nonLitSlots), ...keptLit.slice(0, litSlots)]
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
  const retrievalSummary = {
    sensor: groups.sensor?.length ?? 0,
    literature: groups.literature?.length ?? 0,
    forecast: groups.forecast?.length ?? 0,
  };
  const retrievalConfidence =
    evidence.reduce((sum, item) => sum + item.score, 0) / Math.max(evidence.length, 1);

  return { evidence, retrievalSummary, retrievalConfidence };
}

export interface PromptContextOptions {
  /** Packet body per evidence item, by position; an absent entry falls back to item.text.
   *  evidence-budget.ts passes the verbatim literature passages here. */
  bodies?: ReadonlyArray<string | undefined>;
  /** Use the short SCOPE note (verbatim passages trigger it far more often than one
   *  extracted sentence does, and every char of it counts against the packet budget). */
  compactScopeNote?: boolean;
}

export function evidenceToPromptContext(evidence: LeadsEvidence[], options: PromptContextOptions = {}): string {
  return evidence
    .map((item, index) => {
      const body = options.bodies?.[index] ?? item.text;
      const citationLabel =
        item.channel === "literature"
          ? `${item.provenance.docName ?? item.title} · page ${item.provenance.pageNum ?? 0}`
          : item.channel === "sensor"
          ? `${item.provenance.siteId?.toUpperCase() ?? item.title} · ${item.provenance.variable ?? "sensor"} · ${item.provenance.timestamp ?? "unknown time"}`
          : item.title;

      // Label the evidence type explicitly so the synthesiser does not group literature
      // with sensor entries, e.g. citing a journal article under a claim about recent
      // sensor readings.
      const kind =
        item.channel === "literature"
          ? "LITERATURE"
          : item.channel === "sensor"
          ? "SENSOR OBSERVATION"
          : "FORECAST";
      // Anchor first-person self-references to their own document. Beside other studies
      // in the packet, a phrase such as "during our study" has no owner, and the
      // synthesiser can attach its periods or durations to whichever study the paragraph
      // is about. A system-prompt rule sits far from the ambiguous phrase, so this note
      // travels with the snippet instead. It is appended to the model's packet only; the
      // excerpt printed for the reader never carries it.
      const selfRef = item.channel === "literature" &&
        /\b(?:our|the present|this)\s+(?:study|work|analysis|dataset|survey|sampling|experiment)\b|\bwe\s+(?:analyz|examin|sampl|measur|collect|estimat|observ|report|found|conduct)/i.test(body ?? "");
      const source = item.provenance.docName ?? item.title;
      const anchor = !selfRef
        ? ""
        : options.compactScopeNote
        ? `\n[SCOPE: "our study"/"we" here means ${source} only; do not attach its periods, durations, sample sizes or site conditions to another source.]`
        : `\n[SCOPE: "our study" / "we" in this excerpt refers to ${source} and to NO other source. Any period, duration, sample size or site condition it describes belongs to that source alone — do not let it describe a different study named nearby. If you use this detail, name its source.]`;
      return `[${index + 1}] ${kind} — ${citationLabel}\n${body}${anchor}`;
    })
    .join("\n\n---\n\n");
}
