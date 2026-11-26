"use client";

import { useState } from "react";
import Icon from "./Icon";

// Evidence group of a source, from the fixed header each LEADS reader writes at the start of an evidence item.
const TOOL_OUTPUT_PREFIXES = ["DATA RECENCY ANCHOR", "DEPTH AVAILABILITY", "OPERATIONAL FRAMING",
  "FORECAST SKILL RECORD", "DECISION CONSTRAINT EVALUATION", "Seasonal climatological baseline"];
const GROUP_LABEL = { sensor: "Sensor", forecast: "Ensemble forecast (FLARE)", tool_output: "Tool outputs", literature: "Literature" } as const;
type EvidenceGroup = keyof typeof GROUP_LABEL;
function evidenceGroup(text: string, sourceType?: string): EvidenceGroup {
  if (sourceType === "literature") return "literature";
  if (text.startsWith("Sensor observation at")) return "sensor";
  if (text.startsWith("FLARE")) return "forecast";
  if (TOOL_OUTPUT_PREFIXES.some((p) => text.startsWith(p))) return "tool_output";
  return "literature";
}

interface CitationCardProps {
  n: number; text: string; docName?: string; chunkIndex?: number;
  pageNum?: number; rerankScore?: number;
  method?: "dense"|"sparse"|"hybrid"; highlighted?: boolean;
  sourceType?: "literature" | "sensor" | "forecast";
}

function cleanDocumentTitle(name?: string) {
  if (!name) return "";
  return name.replace(/\.[^/.]+$/, "").trim();
}

// Humanize machine source labels (e.g. "FLARE FCRE DO_mgL_mean") into plain
// language for end users. Literature titles pass through unchanged.
const SITE_NAMES: Record<string, string> = { FCRE: "Falling Creek", FCR: "Falling Creek", BVRE: "Beaverdam", BVR: "Beaverdam" };
const VAR_NAMES: Record<string, string> = {
  DO_mgL_mean: "dissolved oxygen", Temp_C_mean: "water temperature",
  Chla_ugL_mean: "chlorophyll-a", fDOM_QSU_mean: "fDOM",
  Turbidity_FNU_mean: "turbidity", Bloom_binary_mean: "bloom likelihood",
};
export function humanizeSource(name: string): string {
  if (!name) return name;
  const tokens = name.trim().split(/\s+/);
  const kind = tokens[0]?.toUpperCase();
  if (kind === "FLARE" || kind === "VERA") {
    let site = "", v = "";
    for (const t of tokens.slice(1)) {
      if (SITE_NAMES[t.toUpperCase()]) site = SITE_NAMES[t.toUpperCase()];
      else if (VAR_NAMES[t]) v = VAR_NAMES[t];
    }
    // Only transform the machine "FLARE/VERA <SITE> <VAR>" pattern; leave already
    // human-readable names (e.g. "VERA recency snapshot") untouched.
    if (v) {
      const lead = kind === "FLARE" ? "FLARE forecast" : "Sensor";
      return [lead, site, v].filter(Boolean).join(" · ");
    }
  }
  return name;
}

export default function CitationCard({ n, text, docName, pageNum, rerankScore, highlighted, sourceType }: CitationCardProps) {
  const [open, setOpen] = useState(highlighted ?? false);

  const scorePct   = rerankScore != null ? Math.min(100, Math.round(rerankScore * 100)) : null;
  const cleanTitle = cleanDocumentTitle(docName);
  const isLiterature = sourceType === "literature" || (!!docName && docName !== `Source ${n}`);
  const primaryLabel = humanizeSource(isLiterature ? (cleanTitle || docName || `Source ${n}`) : (docName ?? `Source ${n}`));
  const group = evidenceGroup(text ?? "", sourceType);
  const secondaryLabel = group === "literature" && pageNum != null && pageNum > 0 ? `Indexed paper · p.${pageNum}` : null;

  // Colour the [N] chip by evidence group so a reader sees at a glance whether a
  // citation is a sensor reading, a paper, or a forecast or tool output. The number
  // matches the [N] in the answer.
  const cat: "sensor" | "lit" | "ops" = group === "sensor" ? "sensor" : group === "literature" ? "lit" : "ops";
  const chip = {
    sensor: { fg: "#2c6a41", bg: "#edf3ec", bd: "#cfe1d2" },
    lit:    { fg: "#2a4a7a", bg: "#eef1f6", bd: "#d3dcec" },
    ops:    { fg: "#7a5f1f", bg: "#f3efe6", bd: "#e6dcc6" },
  }[cat];
  const barColor = scorePct == null ? "#c9c7bf" : scorePct >= 70 ? "#3f7d54" : scorePct >= 35 ? "#7a6a3f" : "#b4453a";
  // Always-present text label for the evidence type, so the category never depends on
  // the chip colour alone (WCAG 1.4.1 - colour is a redundant accent, not the only cue).
  const typeLabel = secondaryLabel ?? GROUP_LABEL[group];

  return (
    <div
      onClick={() => setOpen((o) => !o)}
      style={{
        background: "#fff",
        border: `1px solid ${highlighted ? chip.fg : open ? "var(--rule-strong)" : "var(--rule)"}`,
        borderRadius: 10,
        overflow: "hidden",
        cursor: "pointer",
        boxShadow: highlighted ? `0 0 0 3px ${chip.bg}` : "none",
        transition: "border-color 0.2s ease",
      }}
    >
      {/* Header row */}
      <div style={{ padding: "9px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        {/* [N] chip - colour-coded by evidence type, number matches the answer's [N] */}
        <div style={{
          width: 24, height: 24, borderRadius: 7, flexShrink: 0,
          background: chip.bg, color: chip.fg, border: `1px solid ${chip.bd}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12.5, fontWeight: 600, fontFamily: "var(--sans)", fontVariantNumeric: "tabular-nums",
        }}>{n}</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "#1a1a18", fontFamily: "var(--sans)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {primaryLabel}
          </div>
          <div style={{ fontSize: 12.5, color: "#54544e", marginTop: 1, fontFamily: "var(--sans)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {typeLabel}
          </div>
        </div>

        <span style={{ color: "#76766f", flexShrink: 0, lineHeight: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s ease", display: "inline-block" }}><Icon name="chevronDown" size={15} /></span>
      </div>

      {/* Relevance bar - flat track, colour by band */}
      {scorePct != null && (
        <div style={{ padding: "0 12px 9px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, height: 5, borderRadius: 3, overflow: "hidden", background: "#eeece5" }}>
            <div style={{ width: `${scorePct}%`, height: "100%", borderRadius: 3, background: barColor }} />
          </div>
          <span style={{ fontSize: 12.5, fontFamily: "var(--sans)", fontVariantNumeric: "tabular-nums", flexShrink: 0, color: "#54544e", width: 36, textAlign: "right" }}>{scorePct}%</span>
        </div>
      )}

      {/* Expanded excerpt */}
      {open && (
        <div style={{ padding: "11px 13px 13px", fontSize: 14, color: "#3d3d38", lineHeight: 1.7, borderTop: "1px solid var(--rule)", background: "var(--paper)" }}>
          <div style={{ fontSize: 12, color: "#54544e", fontFamily: "var(--sans)", fontWeight: 600, letterSpacing: "0.08em", marginBottom: 6 }}>
            SOURCE EXCERPT
          </div>
          {text?.slice(0, 600)}{(text?.length ?? 0) > 600 ? "…" : ""}
        </div>
      )}
    </div>
  );
}
