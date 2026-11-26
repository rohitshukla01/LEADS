// Size budget for the evidence block of the synthesis prompt.
//
// LEADS_LIT_VERBATIM "off" (lit-verbatim.ts): the packet is evidenceToPromptContext(evidence)
// and, past LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT chars, it is cut wherever the limit falls,
// records included.
//
// LEADS_LIT_VERBATIM "on": literature items carry their whole retrieved passage, so the
// limit is EVIDENCE_CONTEXT_CHAR_LIMIT and the packet is never cut blindly. Only
// literature passages are shortened: every passage is clipped to the next entry of
// LITERATURE_TRIM_CAPS (whole sentences, see clipPassage) until the packet fits. Sensor
// readings, forecast cards (window summary and peak line included), the skill record, the
// freshness caveat, the constraint evaluation and every other non-literature record are
// always placed whole. If they alone exceed the limit the packet is returned over the
// limit with overLimit set, never cut.
//
// Pure: no I/O. The generator, the verifier and the citations all call it on the same
// evidence array and get the same per-item text (EvidenceContextBudget.bodies).

import { evidenceToPromptContext } from "./fusion";
import { clipPassage, LITERATURE_ITEM_CHAR_CAP, litVerbatimMode, type LitVerbatimMode } from "./lit-verbatim";
import type { LeadsEvidence } from "./types";

/** Packet limit with LEADS_LIT_VERBATIM "off" (~2,000 tokens). */
export const LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT = 8_000;

/** Packet limit with LEADS_LIT_VERBATIM "on" (~5,000 tokens): room for eight literature
 *  passages of corpus-typical length beside a full set of operational records. */
export const EVIDENCE_CONTEXT_CHAR_LIMIT = 20_000;

/** Per-passage literature caps tried in turn until the packet fits. */
export const LITERATURE_TRIM_CAPS: readonly number[] = [LITERATURE_ITEM_CHAR_CAP, 1_800, 1_200, 800, 500, 300];

/** Appended in "off" mode when the packet is cut. */
export const EVIDENCE_TRUNCATION_NOTE = "\n[evidence truncated for brevity]";

export interface EvidenceContextBudget {
  mode: LitVerbatimMode;
  /** The evidence block placed in the synthesis prompt. */
  context: string;
  /** Per evidence item (same positions), the body text placed in the packet. With "off"
   *  this is item.text for every item (the cut, if any, is applied to `context` only). */
  bodies: string[];
  limit: number;
  /** context.length */
  chars: number;
  /** Per-passage literature cap that made the packet fit; null with "off". */
  literatureCap: number | null;
  /** Literature passages shortened below their full length. */
  literatureTrimmed: number;
  /** "on" only: the packet exceeds the limit with every passage at the smallest cap,
   *  because the non-literature records alone are that long. Nothing was cut. */
  overLimit: boolean;
  /** "off" only: the packet was cut at the limit. */
  truncated: boolean;
}

/** Body text for the packet: the verbatim passage (clipped to `cap`) for literature items
 *  that carry one, item.text for everything else. */
function bodiesAt(evidence: LeadsEvidence[], cap: number): string[] {
  return evidence.map((item) =>
    item.channel === "literature" && item.verbatimText ? clipPassage(item.verbatimText, cap) : item.text
  );
}

export function budgetEvidenceContext(
  evidence: LeadsEvidence[],
  mode: LitVerbatimMode = litVerbatimMode()
): EvidenceContextBudget {
  if (mode === "off") {
    let context = evidenceToPromptContext(evidence);
    const truncated = context.length > LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT;
    if (truncated) context = context.slice(0, LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT) + EVIDENCE_TRUNCATION_NOTE;
    return {
      mode,
      context,
      bodies: evidence.map((item) => item.text),
      limit: LEGACY_EVIDENCE_CONTEXT_CHAR_LIMIT,
      chars: context.length,
      literatureCap: null,
      literatureTrimmed: 0,
      overLimit: false,
      truncated,
    };
  }

  let bodies: string[] = [];
  let context = "";
  let cap = LITERATURE_TRIM_CAPS[0];
  for (cap of LITERATURE_TRIM_CAPS) {
    bodies = bodiesAt(evidence, cap);
    context = evidenceToPromptContext(evidence, { bodies, compactScopeNote: true });
    if (context.length <= EVIDENCE_CONTEXT_CHAR_LIMIT) break;
  }
  const literatureTrimmed = evidence.filter(
    (item, i) => item.channel === "literature" && item.verbatimText && bodies[i].length < item.verbatimText.length
  ).length;
  return {
    mode,
    context,
    bodies,
    limit: EVIDENCE_CONTEXT_CHAR_LIMIT,
    chars: context.length,
    literatureCap: cap,
    literatureTrimmed,
    overLimit: context.length > EVIDENCE_CONTEXT_CHAR_LIMIT,
    truncated: false,
  };
}

/** One log line for a verbatim-mode packet: its size, the size the "off" packet would have
 *  had for the same evidence, and the difference in approximate tokens (chars / 4). */
export function describeEvidenceBudget(budget: EvidenceContextBudget, evidence: LeadsEvidence[]): string {
  const offChars = budgetEvidenceContext(evidence, "off").chars;
  const extra = budget.chars - offChars;
  const tokens = (chars: number) => Math.round(chars / 4);
  return (
    `[evidence-budget] lit_verbatim=${budget.mode} context=${budget.chars} chars (~${tokens(budget.chars)} tokens), ` +
    `${extra >= 0 ? "+" : ""}${extra} chars (~${extra >= 0 ? "+" : ""}${tokens(extra)} tokens) vs lit_verbatim=off; ` +
    `limit=${budget.limit} literature_cap=${budget.literatureCap ?? "-"} trimmed=${budget.literatureTrimmed}` +
    (budget.overLimit ? " OVER LIMIT (non-literature records kept whole)" : "")
  );
}
