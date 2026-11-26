"use client";

import { useState } from "react";

const C = {
  s1:  "rgba(120,113,108,0.04)",
  b:   "rgba(120,113,108,0.12)",
  am:  "#02436e",
  amD: "rgba(2,67,110,0.08)",
  cy:  "#3f7d54",
  cyD: "rgba(63,125,84,0.08)",
  gr:  "#3f7d54",
  grD: "rgba(63,125,84,0.08)",
  rd:  "#b4453a",
  rdD: "rgba(180,69,58,0.08)",
  mu:  "#76766f",
  di:  "#6c6c65",
  tx:  "#1a1a18",
};

const STEPS = [
  { id: "route",        label: "Query Router",       sub: "Adaptive mode selection",          icon: "◇" },
  { id: "expand",       label: "Query expansion",    sub: "Multi-variant generation",         icon: "◈" },
  { id: "retrieve",     label: "Dense + Sparse",     sub: "Hybrid lexical + vector",          icon: "◎" },
  { id: "fuse",         label: "Fusion",             sub: "Score list merging",               icon: "⊕" },
  { id: "guardrail",    label: "Layer 2 guardrail",  sub: "Pre-LLM presence gate",            icon: "▣" },
  { id: "rerank",       label: "Reranking",          sub: "Cross-encoder pass",               icon: "▲" },
  { id: "gap",          label: "Gap Analysis",       sub: "Find missing aspects",             icon: "⌁" },
  { id: "retrieve2",    label: "Targeted Retry",     sub: "Focused fallback retrieval",       icon: "↺" },
  { id: "gate",         label: "Evidence gate",      sub: "Retrieval quality check",          icon: "◉" },
  { id: "synthesize",   label: "Synthesis",          sub: "Streaming generation",             icon: "✦" },
  { id: "verify",       label: "Claim Verification", sub: "Per-claim faithfulness",           icon: "◆" },
  { id: "guardrail-l3", label: "Layer 3 guardrail",  sub: "Post-LLM deterministic audit",     icon: "▥" },
];

interface StepState { status: "running"|"done"|"streaming"; data?: Record<string, unknown>; }
interface PipelinePanelProps { steps: Record<string, StepState>; }

function StepNode({ id, label, sub, icon, status, data, isLast }: {
  id: string; label: string; sub: string; icon: string; isLast: boolean;
  status?: "running"|"done"|"streaming";
  data?: Record<string, unknown>;
}) {
  const [showVariants, setShowVariants] = useState(false);
  const [showL3Checks, setShowL3Checks] = useState(false);
  const run  = status === "running";
  const done = status === "done" || status === "streaming";

  const queries = done && id === "expand" && Array.isArray(data?.queries)
    ? (data.queries as string[]) : [];
  const cacheHit = data?.cached === true;
  const verdict =
    done && id === "gate" && typeof data?.verdict === "string"
      ? (data.verdict as "correct" | "ambiguous" | "incorrect")
      : null;
  const verdictColor =
    verdict === "correct" ? C.gr : verdict === "incorrect" ? C.rd : C.am;
  const verdictBg =
    verdict === "correct" ? C.grD : verdict === "incorrect" ? C.rdD : C.amD;

  // Layer 2 / Layer 3 guardrail state - pulled from SSE step payloads.
  const l2Verdict =
    done && id === "guardrail" && typeof data?.verdict === "string"
      ? (data.verdict as "passed" | "refused")
      : null;
  const l3Verdict =
    done && id === "guardrail-l3" && typeof data?.verdict === "string"
      ? (data.verdict as "passed" | "warning")
      : null;
  const l3Adherence =
    done && id === "guardrail-l3" && typeof data?.adherencePct === "number"
      ? (data.adherencePct as number)
      : null;
  const l3Checks =
    done && id === "guardrail-l3" && Array.isArray(data?.checks)
      ? (data.checks as Array<{ name: string; status: "passed" | "failed" | "skipped"; detail: string }>)
      : [];

  // Flat nodes, no coloured glow.
  const nodeGlow = "none";

  const nodeBg = done
    ? `linear-gradient(145deg, rgba(63,125,84,0.15) 0%, rgba(63,125,84,0.05) 100%)`
    : run
    ? `linear-gradient(145deg, rgba(26,26,24,0.18) 0%, rgba(26,26,24,0.06) 100%)`
    : `linear-gradient(145deg, rgba(120,113,108,0.06) 0%, rgba(120,113,108,0.02) 100%)`;

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "7px 0", position: "relative" }}>
      {/* Connector line */}
      {!isLast && (
        <div style={{
          position: "absolute", left: 12, top: 30, width: 2, bottom: -7,
          background: done
            ? `linear-gradient(180deg, ${C.cy}50, ${C.cy}15)`
            : run
            ? `repeating-linear-gradient(180deg, ${C.am}50 0px, ${C.am}15 8px, transparent 8px, transparent 16px)`
            : "rgba(120,113,108,0.10)",
          borderRadius: 1,
          animation: run ? "connectorFlow 0.6s linear infinite" : "none",
        }} />
      )}

      {/* Node icon (slight perspective tilt) */}
      <div style={{
        width: 26, height: 26, borderRadius: 8, flexShrink: 0, zIndex: 1,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12,
        background: nodeBg,
        border: `1px solid ${done ? C.cy + "50" : run ? C.am + "50" : "rgba(255,255,255,0.08)"}`,
        color: done ? C.cy : run ? C.am : C.mu,
        boxShadow: nodeGlow,
        transition: "all 0.4s ease",
        animation: run ? "glowPulse 1.4s ease-in-out infinite" : done ? "glowPulseCyan 3s ease-in-out infinite" : "none",
        transform: run ? "scale(1.08) perspective(60px) rotateX(5deg)" : "perspective(60px) rotateX(5deg)",
      }}>
        {done ? "✓" : icon}
      </div>

      {/* Label + metadata */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 600,
          color: done ? C.cy : run ? C.am : C.mu,
          transition: "color 0.35s",
          display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
        }}>
          {label}

          {/* Running dots */}
          {run && (
            <span style={{ display: "inline-flex", gap: 2 }}>
              {[0,1,2].map((j) => (
                <span key={j} style={{ width: 3, height: 3, borderRadius: "50%", background: C.am, display: "inline-block", animation: `pulse 0.9s ${j * 0.2}s infinite` }} />
              ))}
            </span>
          )}

          {/* Expand variants toggle */}
          {done && id === "expand" && queries.length > 1 && (
            <span onClick={(e) => { e.stopPropagation(); setShowVariants((v) => !v); }}
              style={{ fontSize: 12, color: `${C.cy}90`, fontFamily: "monospace", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>
              +{queries.length - 1} {showVariants ? "▲" : "▼"}
            </span>
          )}

          {/* Gate confidence */}
          {done && id === "gate" && (
            <span style={{ fontSize: 12, color: verdictColor, fontFamily: "monospace", background: verdictBg, padding: "1px 5px", borderRadius: 3 }}>
              {verdict === "correct" ? "enough" : verdict === "ambiguous" ? "thin" : "done"}
            </span>
          )}

          {/* Rerank stats */}
          {done && id === "rerank" && (
            <span style={{ fontSize: 12, color: `${C.cy}80`, fontFamily: "monospace" }}>
              {String(data?.selected ?? 0)} selected
            </span>
          )}

          {/* Layer 2 guardrail verdict */}
          {done && id === "guardrail" && l2Verdict && (
            <span style={{
              fontSize: 12, fontFamily: "monospace",
              color: l2Verdict === "passed" ? C.gr : C.rd,
              background: l2Verdict === "passed" ? C.grD : C.rdD,
              padding: "1px 5px", borderRadius: 3,
            }}>
              {l2Verdict}
              {l2Verdict === "passed" && Array.isArray(data?.groundingSensorVars) && (data.groundingSensorVars as unknown[]).length > 0 &&
                ` · ${(data.groundingSensorVars as string[]).length} sensor + ${Array.isArray(data?.groundingForecastVars) ? (data.groundingForecastVars as string[]).length : 0} forecast`}
            </span>
          )}

          {/* Layer 3 guardrail adherence */}
          {done && id === "guardrail-l3" && l3Verdict && (
            <span
              onClick={(e) => { e.stopPropagation(); setShowL3Checks((v) => !v); }}
              style={{
                fontSize: 12, fontFamily: "monospace", cursor: l3Checks.length ? "pointer" : "default",
                color: l3Verdict === "passed" ? C.gr : C.am,
                background: l3Verdict === "passed" ? C.grD : C.amD,
                padding: "1px 5px", borderRadius: 3,
              }}
              title={l3Checks.length ? "Click to expand per-check details" : undefined}
            >
              {l3Adherence != null ? `${l3Adherence}% adherence` : l3Verdict}
              {l3Checks.length > 0 && ` · ${l3Checks.filter((c) => c.status === "passed").length}/${l3Checks.filter((c) => c.status !== "skipped").length} checks ${showL3Checks ? "▲" : "▼"}`}
            </span>
          )}

          {/* Claim verification */}
          {done && id === "verify" && (
            <span style={{ fontSize: 12, fontFamily: "monospace",
              color: data?.checkedBy !== "word-overlap" && Number(data?.pct ?? 100) >= 80 ? C.gr : C.am,
              background: data?.checkedBy !== "word-overlap" && Number(data?.pct ?? 100) >= 80 ? C.grD : C.amD,
              padding: "1px 5px", borderRadius: 3 }}>
              {data?.checkedBy === "word-overlap"
                ? "not checked"
                : `${String(data?.supported ?? 0)}/${String(data?.total ?? 0)} verified · ${String(data?.pct ?? 100)}%`}
            </span>
          )}

          {/* Retrieve counts */}
          {done && id === "retrieve" && (
            <span style={{ fontSize: 12, color: `${C.cy}80`, fontFamily: "monospace", background: C.cyD, padding: "1px 5px", borderRadius: 3 }}>
              {String(data?.literature ?? 0)} literature · {String(data?.sensor ?? 0)} sensor · {String(data?.forecast ?? 0)} forecast
            </span>
          )}

          {/* Query router mode */}
          {done && id === "route" && typeof data?.queryMode === "string" && (
            <span style={{ fontSize: 12, color: `${C.cy}80`, fontFamily: "monospace", background: C.cyD, padding: "1px 5px", borderRadius: 3 }}>
              {String(data.queryMode)}
            </span>
          )}

          {/* Cache badge */}
          {cacheHit && (
            <span style={{ fontSize: 12, color: C.cy, fontFamily: "monospace", background: C.cyD, padding: "1px 5px", borderRadius: 3 }}>
              cache
            </span>
          )}
        </div>

        <div style={{ fontSize: 12, color: C.di, marginTop: 1, fontFamily: "var(--sans)" }}>{sub}</div>

        {done && id === "gate" && typeof data?.reason === "string" && (
          <div style={{ marginTop: 5, fontSize: 12, color: `${verdictColor}B0`, fontFamily: "var(--sans)", lineHeight: 1.4 }}>
            {String(data.reason)}
          </div>
        )}

        {done && id === "gap" && Array.isArray(data?.gaps) && (data.gaps as unknown[]).length > 0 && (
          <div style={{ marginTop: 5, fontSize: 12, color: `${C.cy}B0`, fontFamily: "var(--sans)", lineHeight: 1.4 }}>
            {(data.gaps as string[]).join(" | ")}
          </div>
        )}

        {done && id === "retrieve2" && Array.isArray(data?.fallbackQueries) && (data.fallbackQueries as unknown[]).length > 0 && (
          <div style={{ marginTop: 5, fontSize: 12, color: `${C.cy}B0`, fontFamily: "var(--sans)", lineHeight: 1.4 }}>
            {(data.fallbackQueries as string[]).join(" | ")}
          </div>
        )}

        {/* Layer 2 - on refusal, list the triggered conditions so the user can
            see what was missing. */}
        {done && id === "guardrail" && l2Verdict === "refused" && Array.isArray(data?.triggeredConditions) && (data.triggeredConditions as unknown[]).length > 0 && (
          <div style={{ marginTop: 5, fontSize: 12, color: `${C.rd}C0`, fontFamily: "var(--sans)", lineHeight: 1.4 }}>
            {(data.triggeredConditions as string[]).join(" · ")}
          </div>
        )}

        {/* Layer 3 - expandable, colour-coded per-check breakdown. */}
        {done && id === "guardrail-l3" && showL3Checks && l3Checks.length > 0 && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
            {l3Checks.map((c, i) => {
              const color = c.status === "passed" ? C.gr : c.status === "failed" ? C.rd : C.mu;
              const bg    = c.status === "passed" ? C.grD : c.status === "failed" ? C.rdD : "rgba(163,163,155,0.08)";
              const glyph = c.status === "passed" ? "✓" : c.status === "failed" ? "✕" : "−";
              return (
                <div key={i} style={{
                  fontSize: 12, color, fontFamily: "monospace",
                  background: bg, border: `1px solid ${color}30`,
                  borderRadius: 4, padding: "3px 7px", lineHeight: 1.4,
                }}>
                  <span style={{ fontWeight: 700, marginRight: 6 }}>{glyph}</span>
                  <span style={{ fontWeight: 600 }}>{c.name}</span>
                  <span style={{ opacity: 0.75 }}> — {c.detail}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Query variants */}
        {showVariants && queries.length > 0 && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
            {queries.map((q, i) => (
              <div key={i} style={{
                fontSize: 12, color: i === 0 ? C.am : `${C.cy}90`, fontFamily: "monospace",
                background: i === 0 ? C.amD : "rgba(34,211,238,0.05)",
                border: `1px solid ${i === 0 ? C.am + "30" : C.cy + "20"}`,
                borderRadius: 4, padding: "2px 7px",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {i === 0 ? "original: " : `v${i}: `}{q}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PipelinePanel({ steps }: PipelinePanelProps) {
  const cacheHit = Object.values(steps).some((step) => step.data?.cached === true);

  return (
    <div style={{
      borderTop: `1px solid rgba(120,113,108,0.10)`,
      padding: "12px 14px 14px",
      background: "#fff",
      flexShrink: 0,
      position: "relative",
      overflow: "hidden",
    }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 11 }}>
        <div style={{ fontSize: 11.5, color: C.di, letterSpacing: "0.24em", fontFamily: "var(--sans)", fontWeight: 700 }}>
          RAG PIPELINE
        </div>
        {cacheHit && (
          <div style={{ fontSize: 12, color: C.cy, fontFamily: "var(--sans)", background: C.cyD, padding: "2px 8px", borderRadius: 999, border: `1px solid ${C.cy}35` }}>
            Cache hit
          </div>
        )}
      </div>

      {(() => {
        // Operational decisions fire `guardrail` (Layer 2) and `guardrail-l3`
        // (Layer 3); an informational question fires `guardrail` only when it is refused
        // as out of scope. Hide those rows when no event has arrived so an informational
        // pipeline doesn't show permanently-gray "stalled" steps.
        const optional = new Set(["guardrail", "guardrail-l3"]);
        const visible = STEPS.filter((s) => !optional.has(s.id) || steps[s.id]);
        return visible.map((s, i) => (
          <StepNode key={s.id} {...s}
            isLast={i === visible.length - 1}
            status={steps[s.id]?.status}
            data={steps[s.id]?.data}
          />
        ));
      })()}
    </div>
  );
}
