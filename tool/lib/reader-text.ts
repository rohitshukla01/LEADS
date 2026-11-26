// The text of an evidence item as a reader sees it. Pure; imports nothing.
//
// A few of the records LEADS computes before the answer is written also carry
// instructions for the answer model: the operational framing (orchestrator.ts), and an
// opening or closing clause of the constraint evaluation (orchestrator.ts), the data
// recency and depth records (sensor-public.ts) and the forecast skill record
// (skill/forecast-skill.ts). The model and the claim checker read every record whole, and
// the evaluation records keep it whole. The evidence cards, the decision report and an
// answer written without a model print readerText(), which keeps every fact and drops the
// instructions. Any other text is returned unchanged.

const FRAMING_PREFIX = /^OPERATIONAL FRAMING \([^)]*\):\s*/;

/** The decision and its lever: the framing's first two sentences, as the guardrail
 *  (guardrails.ts) words them. The rest of the framing is instructions to the model. */
function framingForReader(text: string): string {
  const body = text.replace(FRAMING_PREFIX, "");
  const kept = /^DECISION CONTEXT:.*?\.(?=\s|$)(?:\s+Operational lever:.*?\.(?=\s|$))?/.exec(body);
  return kept ? kept[0] : "Operating rules for this decision.";
}

export function readerText(text: string): string {
  if (!text) return text ?? "";
  if (FRAMING_PREFIX.test(text)) return framingForReader(text);
  return text
    .replace(
      "DECISION CONSTRAINT EVALUATION (deterministic, computed by LEADS — treat as authoritative for the operational verdict):",
      "DECISION CONSTRAINT EVALUATION (deterministic, computed by LEADS):",
    )
    .replace(`DATA RECENCY ANCHOR — use this to determine what counts as "current" sensor data. `, "DATA RECENCY — ")
    .replace(" and MUST NOT be presented as the latest reading.", ".")
    .replace(
      " State this plainly to the user: there is NO observation at that depth; do NOT substitute another depth's value as if it were the requested one; if useful, point to the depths that ARE measured.",
      "",
    )
    .replace(/: treat it as weaker evidence than climatology on (?:those days|that day) and say so\./, ".");
}
