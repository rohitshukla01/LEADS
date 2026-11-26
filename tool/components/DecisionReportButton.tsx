"use client";

// Per-answer "Download decision report (PDF)" control. Display-only and flag-gated
// (NEXT_PUBLIC_LEADS_REPORT_ENABLED, default on; set "false" and the button never
// mounts). It reads only data already on the message and generates the PDF
// client-side (lib/report.ts). Any error surfaces a toast and leaves the answer untouched.

import { useState } from "react";
import Icon from "./Icon";
import { toast } from "sonner";
import { downloadDecisionReport, type ReportMode } from "@/lib/report";
import type { ReportMessage, ReportProfile } from "@/lib/report-content";

const REPORT_ENABLED = process.env.NEXT_PUBLIC_LEADS_REPORT_ENABLED !== "false";
// Adds the "Evaluation copy" mode (the printed copy used in the expert evaluation); set "false" to hide it.
const EVAL_REPORT = process.env.NEXT_PUBLIC_LEADS_EVAL_REPORT !== "false";

const MUTED = "#54544e", BORDER = "#eceae4";
const ACCENT = "#02436e", ACCENT_DEEP = "#013456";   // LEADS brand navy-teal (visual only)

export default function DecisionReportButton({
  message,
  question,
  profile,
}: {
  message: ReportMessage;
  question: string;
  /** Live profile - fallback only; the report prefers the profile stored on the message. */
  profile?: ReportProfile | null;
}) {
  const [mode, setMode] = useState<ReportMode>("brief");
  const [busy, setBusy] = useState(false);

  if (!REPORT_ENABLED) return null;
  if (!message.content) return null; // no report until there is an answer

  const onDownload = async () => {
    setBusy(true);
    try {
      const chartSvg =
        typeof document !== "undefined"
          ? document.querySelector<SVGSVGElement>(`svg[data-report-chart="${message.id}"]`)
          : null;
      await downloadDecisionReport({ question, message, profile, chartSvg, generatedAt: new Date() }, mode);
    } catch {
      toast.error("Could not generate the report. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <div style={{ display: "flex", border: `1px solid ${BORDER}`, borderRadius: 9, overflow: "hidden" }}>
        {(EVAL_REPORT ? (["brief", "full", "evaluation"] as ReportMode[]) : (["brief", "full"] as ReportMode[])).map((mo) => (
          <button
            key={mo}
            type="button"
            onClick={() => setMode(mo)}
            aria-pressed={mode === mo}
            style={{
              fontFamily: "var(--sans)", fontSize: 13.5, padding: "7px clamp(8px, 2.4vw, 13px)", cursor: "pointer",
              border: "none", background: mode === mo ? "rgba(2,67,110,0.07)" : "#fff",
              color: mode === mo ? ACCENT : MUTED, fontWeight: mode === mo ? 600 : 400,
            }}
          >
            {mo === "brief" ? "Brief (1 page)" : mo === "evaluation" ? "Evaluation copy" : "Full report"}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onDownload}
        disabled={busy}
        onMouseEnter={(e) => { e.currentTarget.style.background = ACCENT_DEEP; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = ACCENT; }}
        style={{
          fontFamily: "var(--sans)", fontSize: 14, fontWeight: 600,
          padding: "8px 15px", borderRadius: 9, cursor: busy ? "wait" : "pointer",
          display: "inline-flex", alignItems: "center", gap: 6,
          border: `1px solid ${ACCENT_DEEP}`, background: ACCENT, color: "#fff",
          opacity: busy ? 0.6 : 1, transition: "background 0.15s ease",
        }}
      >
        {busy ? "Generating…" : <><Icon name="download" size={15} stroke={1.9} /> Download decision report (PDF)</>}
      </button>
    </div>
  );
}
