"use client";

/**
 * Step 1 of the LEADS interaction flow: the two-mode planner profile.
 *
 * Captures persona, reservoir and decision. The decision field switches mode: an
 * operational decision (guardrailed) or "just asking" (informational, open synthesis).
 * For operational decisions the depth is derived from decision × persona via the
 * guardrail's `depth_scope`, and a rule preview reads `rules_by_persona` so the operator
 * sees the constraints, units and data cadence before typing a question.
 *
 * Operational decisions are manager-only; researchers use informational mode, where
 * depth, variables and channels are inferred from the question text (router.ts). The
 * form offers two personas; the `public` persona exists in the types but is not offered,
 * and the researcher rules in guardrails.ts are not exposed here.
 *
 * A decision is offered only when it has a `rules_by_persona` rule for the selected
 * reservoir, which gates hypoxia out of BVR (no oxygenation system). The rule preview
 * maps variable codes, cadence classes and depth_scope to plain language.
 */

import { useEffect, useMemo, useState } from "react";
import {
  PERSONA_DECISIONS,
  getGuardrail,
  getPersonaRule,
  resolveScopeDepths,
  type DecisionKey,
  type Persona,
  type PersonaRule,
} from "@/lib/leads/guardrails";

export type Reservoir = "fcr" | "bvr";
export type Depth = "epilimnion" | "metalimnion" | "hypolimnion";

export interface UserProfile {
  persona: Persona;
  reservoir: Reservoir;
  /** Derived from decision × persona (depth_scope) for operational decisions, or
   *  a surface default for informational mode (the server overrides it from any
   *  depth named in the question). */
  depth: Depth;
  decision: DecisionKey;
  summary: string;
}

export interface UserProfilePanelProps {
  onConfirm: (profile: UserProfile) => void;
  initial?: Partial<Omit<UserProfile, "summary">>;
}

const PERSONA_OPTIONS: { value: Persona; label: string }[] = [
  { value: "manager", label: "Reservoir / Utility Manager" },
  { value: "researcher", label: "Researcher" },
];

const RESERVOIR_OPTIONS: { value: Reservoir; label: string }[] = [
  { value: "fcr", label: "FCR — Falling Creek Reservoir" },
  { value: "bvr", label: "BVR — Beaverdam Reservoir" },
];

const DECISION_OPTIONS: { value: DecisionKey; label: string }[] = [
  { value: "hypoxia_management", label: "Hypoxia management (HOx)" },
  { value: "algal_management", label: "Algal management" },
  { value: "water_extraction", label: "Water extraction" },
  { value: "flow_management", label: "Flow management" },
  { value: "none", label: "Just asking — informational (no guardrail)" },
];

const C = {
  bg: "#faf9f6",
  s1: "rgba(120,113,108,0.10)",
  s2: "rgba(120,113,108,0.16)",
  b: "rgba(120,113,108,0.20)",
  am: "#02436e",   // LEADS brand navy-teal (visual only)
  amD: "rgba(26,26,24,0.12)",
  cy: "#3f7d54",
  tx: "#1a1a18",
  mu: "#54544e",
  di: "#e7e5e0",
};

const mono = "var(--sans)";   // form labels use the app text face (Geist)

const OP = { "<": "<", "<=": "≤", ">": ">", ">=": "≥" } as const;

/** Plain-language names for the raw sensor / sample variable codes, so the
 *  operator never sees a column name like `DO_mgL_mean` in the UI. */
const VARIABLE_LABEL: Record<string, string> = {
  DO_mgL_mean: "Dissolved oxygen",
  DOsat_percent_mean: "Dissolved-oxygen saturation",
  Chla_ugL_mean: "Surface chlorophyll-a",
  TotalConc_ugL_sample: "Chlorophyll-a (surface sampler)",
  TotalConcCM_ugL_sample: "Chlorophyll-a (full-profile sampler)",
  Temp_C_mean: "Temperature",
};
const varLabel = (v: string): string => VARIABLE_LABEL[v] ?? v;

/** Plain-language data-source descriptions, by cadence class. */
const SOURCE_CLASS_LABEL: Record<string, string> = {
  continuous: "daily sensor",
  fluoroprobe: "profile sampler (~weekly)",
  lab: "lab sample (weekly in season; paused in winter)",
  forecast: "FLARE forecast",
  derived: "derived value",
};

/** Editorial layer: short expert descriptors + the "why" behind each guardrail.
 *  The hard facts (depths, thresholds, cadence, season) stay data-driven from
 *  guardrails.ts; this map only adds plain-language rationale on top. Reservoir
 *  blurbs are keyed by reservoir; guardrail reasoning is keyed by decision (the
 *  reasoning holds across reservoirs - only the numbers differ). */
const RESERVOIR_BLURB: Record<Reservoir, string> = {
  fcr: "Falling Creek Reservoir (FCR) — a temperate drinking-water supply reservoir in Vinton, Virginia (Western Virginia Water Authority), fitted with an engineered hypolimnetic oxygenation system.",
  bvr: "Beaverdam Reservoir (BVR) — a temperate, eutrophic upstream supply reservoir in Vinton, Virginia (Western Virginia Water Authority).",
};

type GuardrailRationale = { what: string };
const DECISION_RATIONALE: Partial<Record<DecisionKey, GuardrailRationale>> = {
  algal_management: {
    what: "Mitigate algal blooms — which can release toxins, deplete oxygen, and harm aquatic ecosystems, human health, and drinking-water supplies — using chlorophyll-a as the biomass proxy.",
  },
  hypoxia_management: {
    what: "Protect deep-water (hypolimnetic) oxygen during stratification — informing oxygenation-system operation before the deep water becomes hypoxic.",
  },
  water_extraction: {
    what: "Choose the withdrawal depth that delivers the best raw water to the plant, guided by the dissolved-oxygen profile across candidate depths.",
  },
  flow_management: {
    what: "Use inflow and flushing to disrupt or dilute a developing surface bloom before it concentrates.",
  },
};

/** "03-01" -> "March 1" for human-readable seasonal windows. */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function formatMmdd(mmdd: string): string {
  const [mm, dd] = mmdd.split("-").map((x) => parseInt(x, 10));
  if (!mm || !dd || mm < 1 || mm > 12) return mmdd;
  return `${MONTHS[mm - 1]} ${dd}`;
}

/** Plain-language phrase for where the rule is evaluated, by depth_scope. */
function depthScopeLabel(reservoir: Reservoir, decision: DecisionKey, rule: PersonaRule): string {
  const meters = resolveScopeDepths(reservoir, decision, rule.depth_scope);
  const m = meters.map((x) => `${x} m`).join(", ");
  switch (rule.depth_scope) {
    case "surface":
      return `surface water (epilimnion, ${m})`;
    case "profile_zone":
      return `deep water (hypolimnion, ${m})`;
    case "full_profile":
      return "the full water column (LEADS checks every depth)";
  }
}

/** Representative depth zone to stamp on the profile (cosmetic for operational -
 *  the server derives the real depths from depth_scope; informational defaults to
 *  surface and the server overrides from any depth named in the question). */
function deriveDepthZone(reservoir: Reservoir, decision: DecisionKey, persona: Persona): Depth {
  const rule = getPersonaRule(reservoir, decision, persona);
  if (!rule) return "epilimnion";
  return rule.depth_scope === "profile_zone" ? "hypolimnion" : "epilimnion";
}

function buildSummary(p: Omit<UserProfile, "summary">): string {
  const reservoirLabel = RESERVOIR_OPTIONS.find((o) => o.value === p.reservoir)!.label;
  const personaLabel = PERSONA_OPTIONS.find((o) => o.value === p.persona)!.label;
  const rule = getPersonaRule(p.reservoir, p.decision, p.persona);

  if (p.decision === "none" || !rule) {
    return (
      `You are a ${personaLabel} working on ${reservoirLabel}, asking informationally. ` +
      `LEADS will synthesize the literature plus any sensor/forecast context the question implies — ` +
      `depth, variables, and channels are inferred from the question text (e.g. "chl-a at 5 m"). ` +
      `No operational guardrail is enforced and no operational action is recommended.`
    );
  }

  const guardrail = getGuardrail(p.reservoir, p.decision);
  return (
    `You are a ${personaLabel} working on ${reservoirLabel}. Decision: ${guardrail.label}, ` +
    `under the guardrails above. Forecast horizon is inferred per question (default 7 d). ` +
    `If required data is missing or too stale for its cadence, LEADS abstains rather than guesses.`
  );
}

export default function UserProfilePanel({ onConfirm, initial }: UserProfilePanelProps) {
  const [persona, setPersona] = useState<Persona>(initial?.persona ?? "manager");
  const [reservoir, setReservoir] = useState<Reservoir>(initial?.reservoir ?? "fcr");
  const [decision, setDecision] = useState<DecisionKey>(
    initial?.decision ?? (persona === "manager" ? "hypoxia_management" : "none"),
  );

  // Today's MM-DD, resolved only after mount. The seasonal note below depends on
  // the date, and the server (UTC) and the browser (local) can disagree near
  // midnight - so the server and the first client render both show nothing, and
  // the note appears once the real local date is known. No hydration mismatch.
  const [todayMmdd, setTodayMmdd] = useState<string | null>(null);
  useEffect(() => {
    const n = new Date();
    setTodayMmdd(`${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`);
  }, []);

  const decisionDisabled = persona !== "manager";
  // A decision is offered only when (a) the persona may run it and (b) it has a
  // real operational rule for this reservoir. (b) gates out BVR hypoxia: BVR has
  // no oxygenation system, so its hypoxia guardrail is an out-of-scope stub with
  // no persona rule (guardrails.ts HYPOXIA_BVR).
  const allowedDecisions = useMemo(
    () =>
      new Set(
        PERSONA_DECISIONS[persona].filter(
          (d) => d === "none" || !!getPersonaRule(reservoir, d, persona),
        ),
      ),
    [persona, reservoir],
  );
  const effectiveDecision: DecisionKey = decisionDisabled
    ? "none"
    : allowedDecisions.has(decision)
      ? decision
      : "none";

  const rule = useMemo(
    () => getPersonaRule(reservoir, effectiveDecision, persona),
    [reservoir, effectiveDecision, persona],
  );
  const derivedDepth = useMemo(
    () => deriveDepthZone(reservoir, effectiveDecision, persona),
    [reservoir, effectiveDecision, persona],
  );
  const summary = useMemo(
    () => buildSummary({ persona, reservoir, depth: derivedDepth, decision: effectiveDecision }),
    [persona, reservoir, derivedDepth, effectiveDecision],
  );

  function handlePersonaChange(next: Persona) {
    setPersona(next);
    if (next === "manager") {
      if (decision === "none") setDecision("hypoxia_management");
    } else {
      setDecision("none");
    }
  }

  function handleReservoirChange(next: Reservoir) {
    setReservoir(next);
    // If the current operational decision doesn't exist at the new reservoir
    // (e.g. hypoxia at BVR - no oxygenation system), fall back to a decision
    // that is valid at both reservoirs.
    if (persona === "manager" && decision !== "none" && !getPersonaRule(next, decision, persona)) {
      setDecision("algal_management");
    }
  }

  function handleConfirm() {
    onConfirm({ persona, reservoir, depth: derivedDepth, decision: effectiveDecision, summary });
  }

  const isOperational = effectiveDecision !== "none" && !!rule;
  const rationale = isOperational ? DECISION_RATIONALE[effectiveDecision] : undefined;

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleConfirm();
        }
      }}
      style={{
        background: "transparent",
        border: "none",
        borderRadius: 0,
        padding: "6px 10px 10px",
        fontFamily: mono,
        color: C.tx,
        maxWidth: 720,
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: C.am, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>
          Step 1 / 3 — User Profile
        </div>
        <h2 style={{ margin: "6px 0 0", fontFamily: "var(--serif)", fontSize: 24, fontWeight: 400, letterSpacing: "-0.01em" }}>
          Tell LEADS who you are and what you&apos;re deciding
        </h2>
      </header>

      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Persona">
          <Select
            value={persona}
            onChange={(v) => handlePersonaChange(v as Persona)}
            options={PERSONA_OPTIONS}
          />
        </Field>

        <Field label="Reservoir" hint={RESERVOIR_BLURB[reservoir]}>
          <Select
            value={reservoir}
            onChange={(v) => handleReservoirChange(v as Reservoir)}
            options={RESERVOIR_OPTIONS}
          />
        </Field>

        <Field label="Mode / Decision" hint={rationale?.what}>
          <Select
            value={effectiveDecision}
            onChange={(v) => setDecision(v as DecisionKey)}
            options={DECISION_OPTIONS.filter((o) => allowedDecisions.has(o.value))}
            disabled={decisionDisabled}
          />
        </Field>

      </div>

      {/* Single consolidated Guardrails box: depth + the exact constraint(s) +
          season/persistence. Informational mode shows a one-line note. */}
      {isOperational && rule ? (
        <section
          style={{
            marginTop: 16,
            padding: 14,
            background: C.s2,
            border: `1px solid ${C.b}`,
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 11.5, letterSpacing: 1, textTransform: "uppercase", color: C.am, marginBottom: 8 }}>
            Guardrails
          </div>
          <div style={{ fontSize: 13, color: C.tx, marginBottom: 6 }}>
            Depth: <strong>{depthScopeLabel(reservoir, effectiveDecision, rule)}</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: C.tx }}>
            {rule.constraints.map((c, i) => (
              <li key={i}>
                <strong>
                  {varLabel(c.variable)} {OP[c.op]} {c.value} {c.units}
                </strong>{" "}
                <span style={{ color: C.mu }}>
                  · from {SOURCE_CLASS_LABEL[c.source_class] ?? c.source_class}
                  {c.forecastable ? " · forecast available" : " · current readings only (no forecast)"}
                </span>
              </li>
            ))}
          </ul>
          {(() => {
            // The seasonal note is shown only while the rule is outside its seasonal
            // window, where it is the only warning that this decision returns no
            // operational verdict (constraint-eval gates on the window before the
            // threshold is checked); the persistence note is shown whenever the rule has
            // one. The date comparison, including wrap-around windows, is done locally so
            // this stays display-only.
            const w = rule.seasonal_window;
            const outOfSeason =
              !!w && todayMmdd != null &&
              !(w.start_mmdd <= w.end_mmdd
                ? todayMmdd >= w.start_mmdd && todayMmdd <= w.end_mmdd
                : todayMmdd >= w.start_mmdd || todayMmdd <= w.end_mmdd);
            const persistence = rule.temporal_persistence_days;
            if (!outOfSeason && !persistence) return null;
            return (
              <div style={{ marginTop: 8, fontSize: 12, color: outOfSeason ? "#8a6d1f" : C.mu }}>
                {outOfSeason && w
                  ? `Outside the operational season (${formatMmdd(w.start_mmdd)} – ${formatMmdd(w.end_mmdd)}) — no operational threshold is enforced for this decision today.`
                  : ""}
                {persistence ? `${outOfSeason ? " " : ""}Triggers only if sustained ≥ ${persistence} days.` : ""}
              </div>
            );
          })()}
        </section>
      ) : (
        <div style={{ marginTop: 14, fontSize: 12, color: C.mu, fontStyle: "italic" }}>
          Informational mode — no guardrail. Depth and variables are inferred from your question.
        </div>
      )}

      <section
        style={{
          marginTop: 16,
          padding: 14,
          background: C.s1,
          border: `1px solid ${C.b}`,
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 11.5, letterSpacing: 1, textTransform: "uppercase", color: C.am, marginBottom: 6 }}>
          Profile summary — confirm before proceeding
        </div>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: C.tx }}>{summary}</p>
      </section>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button
          type="button"
          onClick={handleConfirm}
          style={{
            background: C.am,
            color: "white",
            border: "none",
            borderRadius: 9,
            padding: "10px 18px",
            fontFamily: mono,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            letterSpacing: 0,
          }}
        >
          Confirm profile → Planning
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 12, color: C.mu, marginBottom: 4, letterSpacing: 0.3 }}>{label}</div>
      {children}
      {hint ? (
        <div style={{ fontSize: 11.5, color: C.mu, marginTop: 4, fontStyle: "italic" }}>{hint}</div>
      ) : null}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{
        width: "100%",
        padding: "9px 11px",
        fontFamily: mono,
        fontSize: 14,
        color: C.tx,
        background: disabled ? C.amD : "white",
        border: "1px solid var(--rule-strong)",
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
