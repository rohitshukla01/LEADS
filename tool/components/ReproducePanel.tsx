"use client";

// Collapsed "R & Python code" panel under an answer. Shows an editable reproduce-code
// snippet (Python or R) with a copy button, built from the answer's plan by
// lib/reproduce.ts. Display-only: the code fetches only public VERA/FLARE data and runs
// on the user's own machine; nothing executes here and no keys are involved, so edits
// have no server-side effect.

import { useMemo, useState, type CSSProperties } from "react";
import { buildReproduceSnippet, type ReproduceParams, type ReproduceLanguage } from "@/lib/reproduce";
import Icon from "./Icon";

const TEXT = "#1a1a18";
const MUTED = "#54544e";
const BORDER = "#eceae4";
const ACCENT = "#02436e";   // LEADS brand navy-teal (visual only)

export default function ReproducePanel({ params }: { params: ReproduceParams }) {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<ReproduceLanguage>("python");
  const [edited, setEdited] = useState<{ python: string | null; r: string | null }>({ python: null, r: null });
  const [copied, setCopied] = useState(false);

  // Regenerated only when the plan params change; per-language user edits are preserved.
  const generated = useMemo(
    () => ({ python: buildReproduceSnippet(params, "python"), r: buildReproduceSnippet(params, "r") }),
    [params],
  );
  const code = edited[lang] ?? generated[lang];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked - no-op */
    }
  };

  const tabStyle = (active: boolean): CSSProperties => ({
    fontSize: 13.5,
    fontFamily: "var(--sans)",
    padding: "4px 12px",
    borderRadius: 6,
    cursor: "pointer",
    border: `1px solid ${active ? ACCENT : BORDER}`,
    background: active ? "rgba(2,67,110,0.07)" : "#fff",
    color: active ? ACCENT : MUTED,
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={{ marginTop: 18, borderTop: "1px solid var(--rule)", background: "transparent", fontFamily: "var(--sans)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "16px 0 2px", background: "transparent", border: "none", cursor: "pointer", fontSize: 14, color: "#1a1a18", textAlign: "left" }}
      >
        <span style={{ color: "#54544e", display: "inline-block", lineHeight: 0, transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}><Icon name="chevronDown" size={15} /></span>
        <span style={{ fontWeight: 600 }}>R &amp; Python code</span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13, color: "#54544e", marginLeft: "auto" }}>public VERA + FLARE data &middot; runs on your machine</span>
      </button>

      {open && (
        <div style={{ padding: "12px 0 2px", background: "transparent" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
            <button onClick={() => setLang("python")} style={tabStyle(lang === "python")}>Python</button>
            <button onClick={() => setLang("r")} style={tabStyle(lang === "r")}>R</button>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "#2c6a41", background: "rgba(63,125,84,0.09)", borderRadius: 20, padding: "3px 9px" }}>public data &middot; no keys</span>
            <button
              onClick={copy}
              style={{ marginLeft: "auto", fontFamily: "var(--sans)", fontSize: 13, fontWeight: 500, color: "#3d3d38", background: "#fff", border: "1px solid var(--rule-strong)", borderRadius: 7, padding: "4px 11px", cursor: "pointer" }}
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>

          <textarea
            value={code}
            onChange={(e) => setEdited((prev) => ({ ...prev, [lang]: e.target.value }))}
            spellCheck={false}
            aria-label={`${lang === "python" ? "Python" : "R"} code`}
            style={{ width: "100%", minHeight: 260, resize: "vertical", boxSizing: "border-box", fontFamily: "var(--mono)", fontSize: 13.5, lineHeight: 1.6, color: TEXT, background: "var(--paper)", border: `1px solid ${BORDER}`, borderRadius: 8, padding: "12px 13px", whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto" }}
          />

          <div style={{ fontSize: 12.5, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>
            Edit the code as needed and run it on your machine. Fetches only the public VERA (sensor) and FLARE (forecast) data; nothing runs on the LEADS server.
          </div>
        </div>
      )}
    </div>
  );
}
