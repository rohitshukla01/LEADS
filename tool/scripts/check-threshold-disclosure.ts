/**
 * Threshold-disclosure gate (decision records must say where a threshold comes from,
 * how long a persistence trigger is, and what the check did not evaluate).
 *
 *   npx tsx scripts/check-threshold-disclosure.ts
 *
 * Offline: no network, no model calls. It drives the pure constraint evaluator
 * (lib/leads/constraint-eval.ts) with synthetic records for every reservoir × decision ×
 * persona rule in lib/leads/guardrails.ts, and reads prompt text from source. Checks:
 *  1. Provenance: every evaluated record that states a threshold ends with
 *     THRESHOLD_PROVENANCE exactly once, including all three persistence branches
 *     (sustained / indeterminate / not sustained).
 *  2. Persistence wording: the flow addenda and required_response_elements state the
 *     window as "at least N consecutive days", with N read from the rules'
 *     temporal_persistence_days (the number the code enforces); no "one week" phrasing.
 *  3. Not evaluated: a rule with `not_evaluated` appends the deterministic
 *     "Not evaluated: …" line and carries a display-only scopeNote; a rule without it
 *     carries neither. Exactly the water-extraction rules (both personas, both
 *     reservoirs) set `not_evaluated`.
 *  4. Prompt exception and generality: the water-extraction addenda and generator rule 11
 *     allow relaying the "Not evaluated:" line, and no prompt text names the
 *     not-evaluated content itself (it must reach the model only via the record).
 *  5. Display wiring: the shared scope-line helper reads the step data, and both the
 *     answer bubble and the PDF call it.
 *  6. Year-round rules: no rule carries a seasonal window, and every rule is evaluated
 *     (applicable) on dates throughout the year.
 *  7. Banner wording: the operational-check line states the reading, the threshold and
 *     the threshold status in the rule's direction, then whether the rule is met; the
 *     hypoxia chart line uses the same name for the threshold.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  RESERVOIR_DECISION_GUARDRAILS,
  getPersonaRule,
  type DecisionKey,
  type Persona,
  type PersonaRule,
} from "../lib/leads/guardrails";
import {
  evaluateConstraints,
  notEvaluatedLine,
  THRESHOLD_PROVENANCE,
  type ConstraintEvaluation,
  type ConstraintObservation,
} from "../lib/leads/constraint-eval";
import { buildCheckScopeLine } from "../lib/report-content";
import { buildOperationalVerdictBanner } from "../lib/leads/orchestrator";
import { planLeadsQuery } from "../lib/leads/router";
import type { LeadsReservoir } from "../lib/leads/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const ROOT = join(__dirname, "..");
const RESERVOIRS: LeadsReservoir[] = ["fcr", "bvr"];
const PERSONAS: Persona[] = ["manager", "researcher", "public"];
const DECISIONS = Object.keys(RESERVOIR_DECISION_GUARDRAILS.fcr) as DecisionKey[];
const FIXTURE_DATE = "2026-07-15T12:00:00Z"; // fixture as-of date (no rule has a seasonal window)
const LATEST = "2026-07-14";

function addDays(iso: string, d: number): string {
  return new Date(Date.parse(iso + "T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10);
}

/** Daily records for every constraint variable at three depths over `days` days ending
 *  LATEST, valued `offset` units past the threshold in the direction that meets (+) or
 *  fails (-) the condition. */
function records(rule: PersonaRule, days: number, offset: number, latest = LATEST): ConstraintObservation[] {
  const out: ConstraintObservation[] = [];
  for (const c of rule.constraints) {
    const meets = c.op.startsWith(">") ? 1 : -1;
    for (let i = 0; i < days; i++) {
      for (const depthM of [1.6, 5, 9]) {
        out.push({ variable: c.variable, depthM, datetime: `${addDays(latest, -i)} 12:00:00`, observation: c.value + meets * offset });
      }
    }
  }
  return out;
}

type Cell = { reservoir: LeadsReservoir; decision: DecisionKey; persona: Persona; rule: PersonaRule };
const cells: Cell[] = [];
for (const reservoir of RESERVOIRS)
  for (const decision of DECISIONS)
    for (const persona of PERSONAS) {
      const rule = getPersonaRule(reservoir, decision, persona);
      if (rule) cells.push({ reservoir, decision, persona, rule });
    }
const tag = (c: Cell) => `${c.reservoir}/${c.decision}/${c.persona}`;
check("persona rules found", cells.length > 0, `${cells.length} rules`);

// 1. Provenance on every evaluated record
console.log("\n[1] threshold provenance");
for (const cell of cells) {
  const scenarios: [string, ConstraintEvaluation][] =
    cell.rule.temporal_persistence_days != null
      ? [
          ["sustained", evaluateConstraints(cell.rule, records(cell.rule, cell.rule.temporal_persistence_days + 3, 5), FIXTURE_DATE)],
          ["indeterminate", evaluateConstraints(cell.rule, records(cell.rule, 2, 5), FIXTURE_DATE)],
          ["not sustained", evaluateConstraints(cell.rule, records(cell.rule, cell.rule.temporal_persistence_days + 3, -5), FIXTURE_DATE)],
        ]
      : [["evaluated", evaluateConstraints(cell.rule, records(cell.rule, 3, 1), FIXTURE_DATE)]];
  for (const [label, r] of scenarios) {
    check(`${tag(cell)} ${label}: applicable`, r.applicable);
    check(`${tag(cell)} ${label}: provenance exactly once`, count(r.summary, THRESHOLD_PROVENANCE) === 1);
    if (r.applicable && r.kind === "persistence") {
      const want = label === "sustained" ? [true, false] : label === "indeterminate" ? [false, true] : [false, false];
      check(`${tag(cell)} ${label}: verdict`, r.sustained === want[0] && r.indeterminate === want[1],
        `sustained=${r.sustained} indeterminate=${r.indeterminate}`);
      // The provenance closes the threshold-bearing part of the record (only the
      // optional Not-evaluated line may follow it).
      const tail = r.summary.slice(r.summary.indexOf(THRESHOLD_PROVENANCE) + THRESHOLD_PROVENANCE.length).trim();
      check(`${tag(cell)} ${label}: provenance ends the record`, tail === "" || tail === notEvaluatedLine(cell.rule));
    }
  }
}

// 2. Persistence wording from temporal_persistence_days
console.log("\n[2] persistence-window wording");
const ONE_WEEK = /more than one week|beyond one week|[>≥]\s*1[- ]?(?:wk|week)/i;
for (const reservoir of RESERVOIRS) {
  for (const decision of DECISIONS) {
    const g = RESERVOIR_DECISION_GUARDRAILS[reservoir][decision];
    const days = Array.from(new Set(Object.values(g.rules_by_persona ?? {})
      .map((r) => r?.temporal_persistence_days).filter((d): d is number => d != null)));
    const text = [g.system_prompt_addendum, ...g.required_response_elements].join(" ");
    check(`${reservoir}/${decision}: no "one week" phrasing`, !ONE_WEEK.test(text));
    if (days.length === 0) continue;
    for (const d of days) {
      const phrase = `at least ${d} consecutive days`;
      check(`${reservoir}/${decision}: addendum states "${phrase}"`, g.system_prompt_addendum.includes(phrase));
      check(`${reservoir}/${decision}: required elements state "${phrase}"`,
        g.required_response_elements.filter((e) => e.includes(phrase)).length >= 2);
    }
  }
}
const guardrailSrc = readFileSync(join(ROOT, "lib/leads/guardrails.ts"), "utf8");
check("guardrails.ts source has no \"one week\" persistence phrasing", !ONE_WEEK.test(guardrailSrc));

// 3. Not-evaluated line + scope note
console.log("\n[3] not-evaluated disclosure");
const withNotEvaluated = cells.filter((c) => (c.rule.not_evaluated ?? []).length > 0).map(tag).sort();
const expected = RESERVOIRS.flatMap((r) => (["manager", "researcher"] as Persona[]).map((p) => `${r}/water_extraction/${p}`)).sort();
check("not_evaluated is set on exactly the departures (water extraction, both personas)",
  JSON.stringify(withNotEvaluated) === JSON.stringify(expected), withNotEvaluated.join(", "));
for (const cell of cells) {
  const items = cell.rule.not_evaluated ?? [];
  const r = evaluateConstraints(cell.rule, records(cell.rule, (cell.rule.temporal_persistence_days ?? 3) + 3, 1), FIXTURE_DATE);
  const empty = evaluateConstraints(cell.rule, [], FIXTURE_DATE);
  if (items.length) {
    const line = notEvaluatedLine(cell.rule) ?? "";
    check(`${tag(cell)}: entries have label + reason`, items.every((n) => n.label.trim() && n.reason.trim()));
    check(`${tag(cell)}: line lists every entry`, line.startsWith("Not evaluated: ") && items.every((n) => line.includes(`${n.label} (${n.reason})`)));
    check(`${tag(cell)}: record ends with the line (once)`, r.summary.endsWith(line) && count(r.summary, "Not evaluated:") === 1);
    check(`${tag(cell)}: no-data record still discloses it`, empty.summary.endsWith(line));
    check(`${tag(cell)}: scopeNote = "Check used … only. " + line`,
      !!r.scopeNote && /^Check used .+ only\. /.test(r.scopeNote) && r.scopeNote.endsWith(line), r.scopeNote ?? "(none)");
  } else {
    check(`${tag(cell)}: no Not-evaluated line, no scopeNote`, !r.summary.includes("Not evaluated:") && r.scopeNote === undefined);
  }
}

// 4. Prompt exception + generality
console.log("\n[4] prompt exception + generality");
const generatorSrc = readFileSync(join(ROOT, "lib/leads/generator.ts"), "utf8");
const rule11 = generatorSrc.split("\n").find((l) => l.includes("11. NO SCAFFOLDING")) ?? "";
check("generator rule 11 present", rule11.length > 0);
check("generator rule 11 allows relaying the 'Not evaluated:' line", /exception[^"]*'Not evaluated:'/i.test(rule11));
for (const reservoir of RESERVOIRS) {
  const a = RESERVOIR_DECISION_GUARDRAILS[reservoir].water_extraction.system_prompt_addendum;
  check(`${reservoir}/water_extraction: configuration prohibition kept`, a.includes("Never write a sentence about which constraints the rule does or does not contain"));
  check(`${reservoir}/water_extraction: exception allows relaying 'Not evaluated:'`, /exception[^.]*'Not evaluated:' line/i.test(a));
}
// The content must reach the model only through the deterministic record, never as
// a prompt rule naming the unevaluated constraints.
const promptTexts = [
  ...RESERVOIRS.flatMap((r) => DECISIONS.map((d) => RESERVOIR_DECISION_GUARDRAILS[r][d].system_prompt_addendum)),
  generatorSrc.slice(generatorSrc.indexOf("const LEADS_SYSTEM_PROMPT"), generatorSrc.indexOf("function extractText")),
].join("\n").toLowerCase();
for (const n of cells.flatMap((c) => c.rule.not_evaluated ?? [])) {
  check(`no prompt text names "${n.label}"`, !promptTexts.includes(n.label.toLowerCase()));
}

// 5. Display wiring (UI + PDF read the same step field)
console.log("\n[5] display wiring");
const scopeCell = cells.find((c) => (c.rule.not_evaluated ?? []).length > 0);
if (scopeCell) {
  const note = evaluateConstraints(scopeCell.rule, [], FIXTURE_DATE).scopeNote ?? "";
  check("buildCheckScopeLine returns the step's scopeNote",
    buildCheckScopeLine({ "guardrail-eval": { status: "done", data: { scopeNote: note } } }) === note && note.length > 0);
}
check("buildCheckScopeLine is null without a scopeNote",
  buildCheckScopeLine(undefined) === null && buildCheckScopeLine({ "guardrail-eval": { status: "done", data: {} } }) === null);
const orchestratorSrc = readFileSync(join(ROOT, "lib/leads/orchestrator.ts"), "utf8");
check("orchestrator forwards scopeNote on the guardrail-eval step", /scopeNote:\s*constraintEval\.scopeNote/.test(orchestratorSrc));
check("answer bubble passes the scope line", /<AnswerText[^>]*scopeNote=\{buildCheckScopeLine\(m\.pipeline\)\}/.test(readFileSync(join(ROOT, "app/page.tsx"), "utf8")));
check("PDF prints the scope line", count(readFileSync(join(ROOT, "lib/report.ts"), "utf8"), "buildCheckScopeLine(m.pipeline)") >= 2);
// Display-only: the scope line must never be streamed into the scored answer text.
check("scope line is not in the streamed displayText", !/displayText\s*=.*scopeNote/.test(orchestratorSrc));

// 6. Year-round rules
console.log("\n[6] year-round rules");
const YEAR_DATES = ["2026-01-15", "2026-02-20", "2026-07-15", "2026-10-04", "2026-11-20", "2026-12-15"];
for (const cell of cells) {
  check(`${tag(cell)}: no seasonal window`, cell.rule.seasonal_window == null);
  const days = (cell.rule.temporal_persistence_days ?? 0) + 3;
  for (const day of YEAR_DATES) {
    const r = evaluateConstraints(cell.rule, records(cell.rule, days, 5, day), `${day}T12:00:00Z`);
    check(`${tag(cell)} ${day}: applicable`, r.applicable && !/operational season/i.test(r.summary));
  }
}
for (const reservoir of RESERVOIRS) {
  const algal = cells.find((c) => c.reservoir === reservoir && c.decision === "algal_management" && c.persona === "manager");
  check(`${reservoir}/algal_management/manager rule found`, !!algal);
  if (!algal) continue;
  for (const day of ["2026-01-15", "2026-10-04", "2026-12-15"]) {
    const below = evaluateConstraints(algal.rule, records(algal.rule, 3, -2.49, day), `${day}T12:00:00Z`);
    const above = evaluateConstraints(algal.rule, records(algal.rule, 3, 5, day), `${day}T12:00:00Z`);
    check(`${tag(algal)} ${day}: below 20 µg/L evaluated, not met`,
      below.applicable && below.kind === "single_zone" && below.allSatisfied === false);
    check(`${tag(algal)} ${day}: above 20 µg/L evaluated, met`,
      above.applicable && above.kind === "single_zone" && above.allSatisfied === true);
    const banner = buildOperationalVerdictBanner(below, "algal_management", null) ?? "";
    check(`${tag(algal)} ${day}: verdict banner shown`, /→ \*\*below threshold\*\*: bloom-control rule not met\./.test(banner), banner.slice(0, 140));
  }
  // The optional seasonal-window feature works if a rule sets one (wrap-around window).
  const winterOnly = { ...algal.rule, seasonal_window: { start_mmdd: "11-01", end_mmdd: "02-28" } };
  check(`${tag(algal)} synthetic Nov–Feb window: inapplicable in July`,
    evaluateConstraints(winterOnly, records(algal.rule, 3, 5, "2026-07-15"), "2026-07-15T12:00:00Z").applicable === false);
  check(`${tag(algal)} synthetic Nov–Feb window: applicable in January`,
    evaluateConstraints(winterOnly, records(algal.rule, 3, 5, "2026-01-15"), "2026-01-15T12:00:00Z").applicable === true);
}

// 7. Banner wording
console.log("\n[7] banner wording");
const bannerFor = (reservoir: LeadsReservoir, decision: DecisionKey, offset: number) => {
  const cell = cells.find((c) => c.reservoir === reservoir && c.decision === decision && c.persona === "manager");
  if (!cell) return null;
  return buildOperationalVerdictBanner(evaluateConstraints(cell.rule, records(cell.rule, 3, offset), FIXTURE_DATE), decision, null);
};
const wording: [LeadsReservoir, DecisionKey, number, RegExp][] = [
  ["fcr", "algal_management", 5, /; bloom threshold 20 µg\/L → \*\*threshold exceeded\*\*: bloom-control rule met\.$/],
  ["fcr", "algal_management", -5, /; bloom threshold 20 µg\/L → \*\*below threshold\*\*: bloom-control rule not met\.$/],
  ["fcr", "algal_management", 0, /→ \*\*at threshold\*\*: bloom-control rule not met\.$/],
  ["fcr", "hypoxia_management", 2, /; HOx threshold 4 mg\/L → \*\*below threshold\*\*: HOx-activation rule met\.$/],
  ["fcr", "hypoxia_management", -2, /; HOx threshold 4 mg\/L → \*\*above threshold\*\*: HOx-activation rule not met\.$/],
  ["fcr", "hypoxia_management", 0, /→ \*\*at threshold\*\*: HOx-activation rule met\.$/],
];
for (const [reservoir, decision, offset, re] of wording) {
  const b = bannerFor(reservoir, decision, offset) ?? "";
  check(`${reservoir}/${decision} offset ${offset}: ${re.source.slice(0, 40)}…`, re.test(b), b);
}
check("banner does not say 'indicated'", wording.every(([r, d, o]) => !/indicated/.test(bannerFor(r, d, o) ?? "")));
// The chart's threshold line uses the banner's name for the same value.
const hoxChart = planLeadsQuery(
  "What is the current hypolimnetic dissolved oxygen at Falling Creek Reservoir (FCR), what is the risk of it falling below the HOx threshold over the next 7 days, and should we operate the HOx system?",
  { persona: "manager", reservoir: "fcr", depth: "hypolimnion", decision: "hypoxia_management", summary: "" } as any,
).chart?.threshold?.label ?? "";
check("hypoxia chart line reads 'HOx threshold 4 mg/L'", hoxChart === "HOx threshold 4 mg/L", hoxChart);
const bloomChart = planLeadsQuery(
  "What is the current surface chlorophyll-a at Falling Creek Reservoir (FCR), what is the bloom risk over the next 7 days, and should we plan an algaecide treatment?",
  { persona: "manager", reservoir: "fcr", depth: "epilimnion", decision: "algal_management", summary: "" } as any,
).chart?.threshold?.label ?? "";
check("algal chart line reads 'Bloom threshold 20 µg/L'", bloomChart === "Bloom threshold 20 µg/L", bloomChart);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
