"use client";

// LEADS decision report: client-side jsPDF assembler.
//
// Packages data already on an assistant message into a PDF in one of three modes:
//   Brief      = page 1 (verdict, confidence+freshness, forecast table+chart, top evidence)
//   Full       = brief + forecast skill figure + appendix (full response, references +
//                operational data, provenance, reproduce code, glossary/thresholds)
//   Evaluation = the printed copy for expert scoring (described below).
// Every section is wrapped so one failure cannot abort the save; the chart image is
// best-effort (skipped when null; the numbers table already carries the values).

import { buildReproduceSnippet } from "./reproduce";
// Forecast skill: the evaluation copy's section and the full report's compact figure.
import {
  getForecastSkill, skillClass, skillGapPhrase, skillUnscoredNote, skillVerdict, fmtSkillDate, fmtSkillPct,
  skillDepthLabel, CRPSS_SIGN_NOTE, SKILL_META, SKILL_RECORD_THROUGH, SKILL_SCORED_SCOPE, SKILL_VARIABLE_LABEL,
  type ForecastSkill, type SkillClass,
} from "@/lib/skill/forecast-skill";
import { skillScale } from "@/lib/skill/skill-plot";
import {
  parseVerdict, stripBanner, buildSourceListing, buildForecastTable, deriveExceedanceProb,
  buildFreshness, sanitizePdfText, citeFromDocName, roundLongDecimals,
  buildForecastWindow, forecastWindowLabel, buildCheckScopeLine, literatureExcerptNote, excerptLimit,
  upperKeepMicro, reportContextParts, chartIdentity, buildAlignmentAdvisory, outlookCardOrder,
  DISCLAIMER, GLOSSARY, THRESHOLDS, FLARE_MODEL, SYNTHESIS_MODEL,
  claimCheckMissing,
  type ReportMessage, type ReportProfile,
} from "./report-content";
import { renumberMessageForDisplay, citationNumberingNote } from "./citation-display";
import { tidyAnswerText } from "./answer-tidy";

// Evaluation mode: the printed copy used in the expert evaluation. It is a
// separate mode so the brief that managers receive keeps its own layout.
//
// Contents, in on-screen order: question · answer (verdict callout, then the full
// answer) · chart with data freshness · forecast outlook · forecast skill · profile
// advisory · references + operational data, with the threshold-source and numbering
// notes · disclaimer.
// Omitted on purpose: the trust score (a machine confidence shown next to an
// answer a human is about to score anchors the rating), the per-claim verification
// list, the reproduce code, and the glossary.
export type ReportMode = "brief" | "full" | "evaluation";
export interface ReportInput {
  question: string;
  message: ReportMessage;
  /** The live profile - only a fallback for messages saved without their own
   *  `message.profile` (see reportContextParts). */
  profile?: ReportProfile | null;
  chartSvg?: SVGSVGElement | null;
  generatedAt: Date;
}

// Serialize an on-screen SVG to a PNG data URL; null on any failure or timeout.
async function svgToPngDataUrl(svg: SVGSVGElement | null | undefined, scale = 2): Promise<string | null> {
  if (!svg || typeof window === "undefined") return null;
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    // Hover marks (tooltip, hairline, linked-day ring) are on-screen state, never figure content.
    clone.querySelectorAll("[data-transient]").forEach((n) => n.remove());
    const vb = svg.viewBox?.baseVal;
    const w = (vb && vb.width) || svg.clientWidth || 860;
    const h = (vb && vb.height) || svg.clientHeight || 260;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
    bg.setAttribute("width", String(w)); bg.setAttribute("height", String(h));
    bg.setAttribute("fill", "#ffffff");
    clone.insertBefore(bg, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
    return await new Promise<string | null>((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), 1500);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          const ctx = canvas.getContext("2d");
          if (!ctx) { clearTimeout(timer); resolve(null); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          clearTimeout(timer);
          resolve(canvas.toDataURL("image/png"));
        } catch { clearTimeout(timer); resolve(null); }
      };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  } catch { return null; }
}

export async function downloadDecisionReport(input: ReportInput, mode: ReportMode): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  // Citations carry display numbers from here on (lib/citation-display.ts): the cited
  // sources read 1..n in the order the answer cites them, in the banner, the answer
  // text and every source list below, and the lists are ordered by those numbers. The
  // verifier's matches count as cited, as in the on-screen evidence panel, so the
  // screen and the PDF agree on the cited set, its numbers and the uncited count. The
  // message itself is not modified; it keeps the pipeline's numbers. The renumbered
  // text is then tidied as on screen (lib/answer-tidy.ts: citation runs ascending,
  // "skilful"); banner lines still match the original, so parseVerdict/stripBanner agree.
  const { message: shown, uncitedCount } = renumberMessageForDisplay(input.message, {
    alsoCited: (input.message.claims ?? []).map((cl) => cl?.bracketNum),
  });
  const m = { ...shown, content: tidyAnswerText(shown.content) };
  const sourcesNote = citationNumberingNote(uncitedCount);

  const pageW = 210, margin = 18, contentW = pageW - margin * 2;
  let y = margin;
  const addPage = () => { doc.addPage(); y = margin; };
  const checkPage = (needed = 8) => { if (y + needed > 285) addPage(); };
  const safe = (fn: () => void) => { try { fn(); } catch { /* section is fail-soft */ } };

  // Every string drawn into the PDF goes through sanitizePdfText so out-of-CP1252
  // characters (e.g. the "→" in the operational-check banner) never render as garbage.
  type TextOpts = Parameters<typeof doc.text>[3];
  const put = (s: string, x: number, yy: number, opts?: TextOpts) => doc.text(sanitizePdfText(s), x, yy, opts);
  const split = (s: string, w: number): string[] => doc.splitTextToSize(sanitizePdfText(s), w) as string[];

  const header = (label: string, r: number, g: number, b: number) => {
    checkPage(14);
    doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.setTextColor(r, g, b);
    put(label, margin, y); y += 4;
    doc.setDrawColor(r, g, b); doc.setLineWidth(0.3); doc.line(margin, y, margin + contentW, y); y += 5;
    doc.setFont("helvetica", "normal"); doc.setTextColor(30, 30, 30);
  };
  const para = (text: string, size = 10, lineH = 5) => {
    doc.setFontSize(size);
    for (const ln of split(text, contentW)) { checkPage(); put(ln, margin, y); y += lineH; }
  };
  // One grey line under a literature list whose excerpts are all verbatim quotations
  // (literatureExcerptNote); nothing when any excerpt is not flagged verbatim.
  const drawLiteratureNote = (items: ReadonlyArray<{ docName?: string; verbatim?: boolean }>) => {
    const note = literatureExcerptNote(items);
    if (!note) return;
    checkPage(8);
    doc.setFont("helvetica", "normal"); doc.setTextColor(120, 120, 120);
    para(note, 7.2, 3.4);
    y += 1;
  };

  // Render an answer body as clean text: turn whole-line **bold headers** into real
  // bold, and strip any remaining inline markdown markers so no literal "**" shows.
  const renderResponseBody = (body: string, size = 10, lineH = 5.5) => {
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\t+/g, "  ");
      const boldHeader = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
      if (boldHeader) {
        const label = boldHeader[1].replace(/\s*:\s*$/, "") + ":";
        doc.setFont("helvetica", "bold"); doc.setFontSize(size); doc.setTextColor(26, 26, 24);
        for (const ln of split(label, contentW)) { checkPage(); put(ln, margin, y); y += lineH; }
        doc.setFont("helvetica", "normal"); doc.setTextColor(30, 30, 30);
        continue;
      }
      const clean = line.replace(/\*\*/g, "").replace(/`/g, "").replace(/^\s*#+\s*/, "");
      if (clean.trim() === "") { y += lineH * 0.5; continue; }
      doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(30, 30, 30);
      for (const ln of split(clean, contentW)) { checkPage(); put(ln, margin, y); y += lineH; }
    }
  };

  // Profile-question advisory: the amber callout the UI draws under the chart
  // (app/page.tsx). Drawn in every mode, at the same point as on screen (after the
  // chart, before the sources).
  const drawAlignmentAdvisory = () => {
    const adv = buildAlignmentAdvisory(m.alignment);
    if (!adv) return;
    const [r, g, b] = adv.hard ? [180, 83, 9] : [146, 112, 10];
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); // set before splitting
    const lines = adv.text ? split(adv.text, contentW - 12) : [];
    const boxH = lines.length * 4.2 + 9;
    checkPage(boxH + 5);
    doc.setFillColor(253, 247, 236); doc.setDrawColor(236, 200, 150); doc.setLineWidth(0.3);
    doc.roundedRect(margin, y, contentW, boxH, 2, 2, "FD");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(r, g, b);
    put(upperKeepMicro(adv.title), margin + 6, y + 5);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    let ly = y + 9.5;
    for (const ln of lines) { put(ln, margin + 6, ly); ly += 4.2; }
    y += boxH + 6;
    doc.setTextColor(30, 30, 30);
  };

  // -- SKILL SECTION START ------------------------------------------------------
  // Forecast skill as a native dot-and-interval figure, the screen card's encoding in
  // monochrome: one column per forecast day 1..min(H, 21), the 95% CI as a grey line, a
  // filled dot (more skilful), an open dot (not distinguishable) or a grey square (less
  // skilful), the zero line, and every day's value (paper cannot hover). Values use an ASCII
  // minus because the PDF fonts have no U+2212. Days past 21 are named once, after the verdict.
  const skillFigureHeight = (sk: ForecastSkill, plotH: number) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    const v = split(`${skillVerdict(sk.days)}${sk.unscored ? ` ${skillUnscoredNote(sk.horizon)}` : ""}`, contentW).length;
    doc.setFontSize(7.5);
    const c = split(skillCaption(sk), contentW).length;
    return v * 4 + 2 + plotH + 1 + 7.4 + c * 3.6 + 2;
  };
  const skillCaption = (sk: ForecastSkill) =>
    `Dot: skill (CRPSS) of past FLARE forecasts (${SKILL_META.model}) vs climatology at ${SKILL_SCORED_SCOPE}, each past forecast counted once, ` +
    `${fmtSkillDate(sk.coverage.from)} to ${SKILL_RECORD_THROUGH}; line: 95% CI. ${CRPSS_SIGN_NOTE}` +
    ` This is the model's past track record, not a score for today's forecast.`; // days past 21: stated once, with the verdict
  const drawSkillFigure = (sk: ForecastSkill, plotH: number) => {
    const X = margin, W = contentW;
    // verdict sentence above the plot
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(26, 26, 24);
    for (const ln of split(`${skillVerdict(sk.days)}${sk.unscored ? ` ${skillUnscoredNote(sk.horizon)}` : ""}`, W)) { put(ln, X, y + 3); y += 4; }
    y += 2;
    const days = sk.days, D = days.length, slots = Math.max(D, 3), c = (1 + D) / 2;
    const padL = 15, padR = 2, padT = 2;   // room for the rotated y-axis title
    const iw = W - padL - padR, sp = iw / slots;
    const beside = sp >= 14;
    const padB = beside ? 10 : 13.5;
    const ih = plotH - padT - padB, top = y + padT, bottom = top + ih;
    const xAt = (d: number) => X + padL + iw * ((d - c) / slots + 0.5);
    const { ticks, yLo, yHi } = skillScale(days);
    const yAt = (v: number) => top + ((yHi - v) / ((yHi - yLo) || 1)) * ih;
    const tick = (v: number) => (v < 0 ? `-${Math.abs(v)}` : String(v));   // plain numbers; the axis title carries the unit
    // axes as on a paper figure: left and bottom spines, outward ticks, no gridlines
    doc.setDrawColor(26, 26, 24); doc.setLineWidth(0.25);
    doc.line(X + padL, yAt(yHi), X + padL, bottom);
    doc.line(X + padL, bottom, X + W - padR, bottom);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7);
    for (const t of ticks) {
      doc.setDrawColor(26, 26, 24); doc.setLineWidth(0.25); doc.line(X + padL - 1.1, yAt(t), X + padL, yAt(t));
      doc.setTextColor(51, 51, 47); put(tick(t), X + padL - 1.8, yAt(t) + 0.9, { align: "right" });
    }
    for (const d of days) { doc.line(xAt(d.day), bottom, xAt(d.day), bottom + 1.1); }
    doc.setFont("helvetica", "bold"); doc.setTextColor(26, 26, 24);
    doc.text("CRPSS (%)", X + 2.6, (yAt(yHi) + bottom) / 2, { angle: 90, align: "center" });
    doc.setFont("helvetica", "normal");
    // zero line, only when the axis runs below 0 (otherwise the x axis is the zero line)
    if (yLo < 0) { doc.setDrawColor(110, 110, 110); doc.setLineWidth(0.2); doc.line(X + padL, yAt(0), X + W - padR, yAt(0)); }
    // CI lines, then marks
    doc.setLineCap("round");
    for (const d of days) { doc.setDrawColor(140, 140, 140); doc.setLineWidth(0.3); doc.line(xAt(d.day), yAt(d.hi), xAt(d.day), yAt(d.lo)); }
    doc.setLineCap("butt");
    const mark = (cls: SkillClass, mx: number, my: number) => {
      if (cls === "less") { doc.setFillColor(119, 115, 108); doc.rect(mx - 0.55, my - 0.55, 1.1, 1.1, "F"); }
      else if (cls === "same") { doc.setFillColor(255, 255, 255); doc.setDrawColor(26, 26, 24); doc.setLineWidth(0.25); doc.circle(mx, my, 0.6, "FD"); }
      else { doc.setFillColor(26, 26, 24); doc.circle(mx, my, 0.6, "F"); }
    };
    for (const d of days) mark(skillClass(d), xAt(d.day), yAt(d.crpss));
    // day numbers, values, axis title
    doc.setFontSize(7); doc.setTextColor(51, 51, 47);
    for (const d of days) put(String(d.day), xAt(d.day), bottom + 3.9, { align: "center" });
    const vfs = sp < 7.4 ? 6.2 : 6.8;
    doc.setTextColor(26, 26, 24);
    for (const d of days) {
      const t = fmtSkillPct(d.crpss, true);
      if (beside) { doc.setFontSize(6.8); put(t, xAt(d.day) + 1.6, yAt(d.crpss) + 0.9); }
      else { doc.setFontSize(vfs); put(t, xAt(d.day), bottom + 7.2, { align: "center" }); }
    }
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(26, 26, 24);
    put("Forecast day", X + padL + iw / 2, bottom + (beside ? 7.6 : 11.2), { align: "center" });
    doc.setFont("helvetica", "normal");
    y += plotH + 1;
    // key: one glyph per class present, plus the zero cue
    const KEY: Record<SkillClass, string> = { more: "More skilful", same: "Not distinguishable", less: "Less skilful" };
    let kx = X;
    doc.setFontSize(7); doc.setTextColor(84, 84, 78);
    for (const cls of (["more", "same", "less"] as SkillClass[]).filter((k) => days.some((d) => skillClass(d) === k))) {
      mark(cls, kx + 0.8, y + 1.5); put(KEY[cls], kx + 2.4, y + 2.4); kx += 2.4 + doc.getTextWidth(KEY[cls]) + 5;
    }
    doc.setDrawColor(110, 110, 110); doc.setLineWidth(0.2); doc.line(kx, y + 1.5, kx + 4, y + 1.5);
    doc.setTextColor(84, 84, 78); put("0 = as skilful as climatology", kx + 5.2, y + 2.4);
    y += 7.4; // caption baseline clears the key line
    doc.setFont("helvetica", "normal"); doc.setTextColor(120, 120, 120);
    para(skillCaption(sk), 7.5, 3.6);
  };
  // -- SKILL SECTION END --------------------------------------------------------

  // Evaluation layout, in the on-screen order: question, answer (the operational check
  // as a callout, as in the answer bubble), chart, forecast outlook cards, forecast
  // skill, profile advisory, sources. It uses the app's warm palette instead of the
  // report's blue headings and draws the outlook as three cards, as the panel does.
  //
  // Self-contained and returns early: nothing below it is reached in evaluation mode.
  if (mode === "evaluation") {
    const gray = (v: number) => doc.setTextColor(v, v, v);
    // Upper-cased with the micro sign kept (upperKeepMicro): a plain toUpperCase() turns
    // "µg/L" into a Greek capital Mu, which the PDF text filter drops ("G/L").
    const eyebrow = (label: string) => {
      checkPage(15);
      doc.setFontSize(8); doc.setFont("helvetica", "bold"); doc.setTextColor(79, 78, 71);
      put(upperKeepMicro(label), margin, y); y += 3.6;
      doc.setDrawColor(216, 211, 198); doc.setLineWidth(0.3);
      doc.line(margin, y, margin + contentW, y); y += 5.5;
      doc.setFont("helvetica", "normal"); gray(30);
    };
    // Does a label fit on one eyebrow line? Measured exactly as eyebrow() draws it.
    const eyebrowFits = (label: string) => {
      doc.setFontSize(8); doc.setFont("helvetica", "bold");
      const fits = doc.getTextWidth(sanitizePdfText(upperKeepMicro(label))) <= contentW;
      doc.setFont("helvetica", "normal");
      return fits;
    };

    // Header bar - same brand block, labelled as the evaluation copy.
    safe(() => {
      doc.setFillColor(26, 26, 24); doc.rect(0, 0, pageW, 22, "F");
      doc.setFontSize(15); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
      put("LEADS", margin, 12);
      doc.setFontSize(7); doc.setFont("helvetica", "normal"); doc.setTextColor(185, 185, 185);
      put(reportContextParts(m, input.profile).join("  ·  "), margin, 18);
      put(input.generatedAt.toLocaleString(), pageW - margin, 12, { align: "right" });
      put("Evaluation copy", pageW - margin, 18, { align: "right" });
      y = 30;
    });

    // 1. Question - as the user asked it.
    safe(() => {
      eyebrow("Question");
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); gray(26);
      for (const ln of split(input.question || "(question unavailable)", contentW)) { checkPage(); put(ln, margin, y); y += 6; }
      doc.setFont("helvetica", "normal"); y += 4;
    });

    // 2. The answer, with the operational check drawn as the callout the UI shows.
    safe(() => {
      eyebrow("LEADS response");
      const v = parseVerdict(m.content);
      if (v) {
        // Set the font before splitting: splitTextToSize wraps using the font active
        // at call time, and measuring at the eyebrow's 8pt-normal would overflow the
        // 9.5pt-bold callout.
        doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
        const lines = split(`${v.verdict}${v.forecastClause ? ` ${v.forecastClause}` : ""}`, contentW - 12);
        const boxH = lines.length * 5 + 7;
        checkPage(boxH + 4);
        doc.setFillColor(250, 249, 246); doc.setDrawColor(216, 211, 198); doc.setLineWidth(0.3);
        doc.roundedRect(margin, y - 4, contentW, boxH, 2, 2, "FD");
        doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); gray(26);
        for (const ln of lines) { put(ln, margin + 6, y + 1.5); y += 5; }
        doc.setFont("helvetica", "normal"); y += 7;
      }
      renderResponseBody(stripBanner(m.content), 9.5, 5.2);
      // Scope of the deterministic check, printed under the answer as the UI shows it
      // (only when the rule lists constraints it does not evaluate).
      const scope = buildCheckScopeLine(m.pipeline);
      if (scope) { y += 1; doc.setFont("helvetica", "normal"); gray(110); para(scope, 8, 3.8); }
      y += 4;
    });

    // Single horizon value for both the chart heading and the outlook header, so the
    // document cannot disagree with itself. The plan's horizon wins; the forecast-day
    // count is the fallback.
    const evalHorizon = m.reproduce?.horizon ?? buildForecastTable(m.chart)?.horizonDays ?? null;

    // 3. Chart, under the same heading the panel uses.
    if (input.chartSvg) {
      const png = await svgToPngDataUrl(input.chartSvg);
      if (png) safe(() => {
        // Only name a forecast when one is plotted: evalHorizon falls back to the
        // reproduce snippet's horizon, which defaults to 7 even on informational
        // questions that retrieved no forecast.
        const horizon = (m.chart?.forecast?.length ?? 0) > 0 ? evalHorizon : null;
        const obsHead = horizon ? `Observations -> ${horizon}-day forecast` : "Observations";
        // Name the figure: "<variable> (<units>) · <site> · <depth>". The on-screen title
        // is HTML outside the captured SVG, so the image alone carries none of these. It
        // leads the eyebrow when the line fits, otherwise the caption.
        const ident = chartIdentity(m.chart);
        const identInHead = !!ident && eyebrowFits(`${ident}  ·  ${obsHead}`);
        eyebrow(identInHead ? `${ident}  ·  ${obsHead}` : obsHead);
        const imgW = contentW, imgH = imgW * (260 / 860);
        checkPage(imgH + 10);
        doc.addImage(png, "PNG", margin, y, imgW, imgH);
        y += imgH + 3;
        const fresh = buildFreshness(m.chart);
        const win = buildForecastWindow(m.chart);
        // Describe what is plotted, not what is in the array. Dates come from the run
        // itself, so this reads correctly for a current forecast and a lagging one
        // alike. Wrapped (para, not put) because the line can run past one row.
        const bits = [
          ident && !identInHead ? ident : "",
          fresh.latestSensor ? `Latest sensor reading ${fresh.latestSensor}` : "",
          win
            ? `${win.runDays}-day FLARE run${win.from && win.to ? ` (${win.from} to ${win.to})` : ""}` +
              (win.drawnDays && win.drawnDays < win.runDays
                ? `, ${win.drawnDays} days plotted beyond the last reading`
                : "")
            : "",
          fresh.latestSensor && win ? "the step at the divider is a real model-sensor offset, not a plotting gap" : "",
        ].filter(Boolean);
        doc.setFontSize(7.5); gray(120);
        para(bits.join("  ·  "), 7.5, 3.5);
        y += 5;
      });
    }

    // 4. Forecast outlook - three cards, as on screen (worst/typical/best for this
    //    threshold's direction; a value on the wrong side of the limit prints red).
    safe(() => {
      const ft = buildForecastTable(m.chart);
      if (!ft) return;
      // Keep the heading with its cards: eyebrow() only reserves room for itself, so
      // reserve the whole block (heading + cards + caption) before drawing any of it.
      checkPage(44);
      // Date the header inline so the cards are not read as covering the reader's
      // current week. The dates come from the run. A window label too long for one
      // line falls back to the short form.
      const winLabel = forecastWindowLabel(buildForecastWindow(m.chart));
      const shortHead = `Forecast outlook${evalHorizon ? `  ·  ${evalHorizon}-day` : ""}${ft.threshold ? `  ·  vs ${ft.threshold.value} ${ft.units} threshold` : ""}`;
      const longHead = winLabel
        ? `Forecast outlook${evalHorizon ? `  ·  ${evalHorizon}-day` : ""}  ·  ${winLabel}${ft.threshold ? `  ·  vs ${ft.threshold.value} ${ft.units} threshold` : ""}`
        : shortHead;
      eyebrow(eyebrowFits(longHead) ? longHead : shortHead);
      const gap = 4, cardW = (contentW - gap * 2) / 3, cardH = 17;
      checkPage(cardH + 4);
      ([[ft.pessimisticLabel, ft.pessimistic], ["expected · mean", ft.expected], [ft.optimisticLabel, ft.optimistic]] as [string, number][])
        .forEach(([lab, val], i) => {
          const x = margin + i * (cardW + gap);
          doc.setFillColor(250, 249, 246); doc.setDrawColor(226, 222, 210); doc.setLineWidth(0.3);
          doc.roundedRect(x, y, cardW, cardH, 2, 2, "FD");
          doc.setFontSize(7); gray(124); put(lab.toUpperCase(), x + 3.5, y + 5.5);
          doc.setFont("helvetica", "bold"); doc.setFontSize(14);
          // red = breaches the threshold, blue = safe side (as on screen); neutral ink without a directed threshold
          if (ft.breaches(val)) doc.setTextColor(180, 69, 58); else if (ft.threshold?.direction) doc.setTextColor(47, 110, 181); else gray(26);
          put(val.toFixed(1), x + 3.5, y + 13);
          doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); gray(124);
          put(ft.units, x + 3.5 + doc.getTextWidth(val.toFixed(1)) * 1.7 + 1.5, y + 13);
        });
      y += cardH + 3;
      // The cards use the 10-90 band while the forecast records below quote the wider
      // 2.5-97.5 envelope ("range 1.07-15.14"). Both are correct; unlabelled they look
      // like two different answers for the same forecast. The percentile order follows
      // the cards as drawn (90th first for an "above" threshold).
      doc.setFontSize(7.2); gray(120);
      para(`${outlookCardOrder(ft)} at day ${evalHorizon ?? "end of horizon"}. Ranges quoted in the forecast records below use the wider 2.5-97.5% ensemble envelope.`, 7.2, 3.4);
      y += 5;
    });

    // 5. Forecast skill: the model's track record, needed to weigh calibration. The same
    //    gate as the card and the evidence record (lib/skill/forecast-skill.ts): a 9 m, BVR
    //    or full-profile forecast prints a greyed "not scored" slot; a scored record names
    //    its depth in the eyebrow and prints the dot-and-interval figure.
    // -- SKILL SECTION START --
    safe(() => {
      const site = m.chart?.site, variable = m.reproduce?.variable;
      if (!site || !variable || !(m.chart?.forecast?.length)) return;
      const sk = getForecastSkill(site, variable, m.chart?.depthM, m.chart?.questionHorizon ?? evalHorizon);
      if (!sk) {
        checkPage(30); // heading + the greyed slot, kept together
        eyebrow("Forecast skill  ·  vs climatology");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.5);
        const headLines = split(`Forecast skill: not scored ${skillGapPhrase(site, variable, m.chart?.depthM)}`, contentW - 8);
        const boxH = headLines.length * 4.4 + 6;   // the one line only, as on screen
        doc.setFillColor(246, 245, 241); doc.setDrawColor(216, 211, 198); doc.setLineWidth(0.3);
        doc.roundedRect(margin, y - 1, contentW, boxH, 2, 2, "FD");
        y += 3.5;
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); gray(140);
        for (const ln of headLines) { put(ln, margin + 4, y); y += 4.4; }
        y += 6;
        return;
      }
      const label = SKILL_VARIABLE_LABEL[sk.variable] ?? sk.variable;
      checkPage(skillFigureHeight(sk, 50) + 14); // heading, verdict, figure, key and caption kept together (para() needs 8 mm per line)
      eyebrow(`Forecast skill  ·  ${label}  ·  FCR  ·  ${skillDepthLabel(SKILL_META.depth_m)}  ·  vs climatology`);
      drawSkillFigure(sk, 50);
      y += 5;
    });
    // -- SKILL SECTION END --

    // Profile-question advisory, where the UI draws it (after the chart panel).
    safe(drawAlignmentAdvisory);

    // 6. Sources - literature and operational records, numbered by the answer's [N].
    safe(() => {
      const { references, data } = buildSourceListing(m.citations, mode);
      if (!references.length && !data.length) return;
      const renderList = (groups: typeof references, asCitation: boolean) => {
        // One heading per run of consecutive numbers from the same document: one paper
        // supplying [5], [6], [7] prints as one entry, not three that look like three
        // papers. Same-source numbers that are not consecutive get their own
        // heading, so the printed numbers always ascend (buildSourceListing).
        for (const { docName, nums, pages, items } of groups) {
          checkPage(14);
          doc.setFont("helvetica", "bold"); doc.setFontSize(8); gray(60);
          put(`${nums.map((n) => `[${n}]`).join(" ")}  ${asCitation ? citeFromDocName(docName) : docName}${pages.length ? `  ·  p.${pages.join(", ")}` : ""}`, margin, y);
          y += 4;
          doc.setFont("helvetica", "normal"); gray(90);
          for (const c of items) {
            // Drop the internal "[source: …]" suffix. It is the provenance of the
            // threshold, but it is appended to the end of the probability sentence, so
            // as printed it reads as though the exceedance percentage itself were a
            // model assumption rather than an ensemble count. The threshold's real
            // provenance is stated once, below the list.
            const flat = (c.text ?? "").replace(/\s*\[source:[^\]]*\]/gi, "").replace(/\s+/g, " ").trim();
            // A verbatim quotation is printed exactly as quoted: no decimal rounding.
            const t = c.verbatim ? flat : roundLongDecimals(flat);
            // Literature snippets are clipped at 400 characters unless they are verbatim
            // quotations, which excerptLimit prints whole. LEADS-derived data records are
            // short, structured, and put their statistics at the end, so they get a
            // 560-character budget that reaches it. Longer text is cut on a sentence
            // boundary when one falls in the last 40% of the budget.
            const limit = asCitation ? excerptLimit(c, 400) : 560;
            let shown = t;
            if (t.length > limit) {
              const cut = t.slice(0, limit);
              const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
              shown = (stop > limit * 0.6 ? cut.slice(0, stop + 1) : cut) + "…";
            }
            para(`${items.length > 1 ? `[${nums[items.indexOf(c)]}] ` : ""}${shown}`, 7.6, 3.7);
          }
          y += 2;
        }
      };
      if (references.length) { eyebrow("References (literature cited)"); renderList(references, true); drawLiteratureNote(references.flatMap((g) => g.items)); }
      if (data.length) { eyebrow("Data & evidence (measurements and forecasts cited)"); renderList(data, false); }
      // State once where the decision limit comes from (the guardrail table records
      // no published citation for it) and attribute the exceedance percentage to the
      // ensemble count that produces it.
      const thr = buildForecastTable(m.chart)?.threshold;
      if (thr) safe(() => {
        checkPage(10);
        doc.setFontSize(7.2); gray(120);
        para(`The ${thr.value} ${buildForecastTable(m.chart)?.units ?? ""} decision limit is a LEADS operational guardrail; it carries no published source citation. Exceedance percentages are counted directly from the FLARE ensemble members, not assumed.`, 7.2, 3.4);
        y += 1;
      });
      // The numbers run 1..n in citation order; say so, and how many retrieved
      // sources the answer did not cite.
      checkPage(10);
      doc.setFontSize(7.2); gray(120);
      para(sourcesNote, 7.2, 3.4);
      y += 2;
    });

    // Disclaimer + footer, then done - nothing below this block runs.
    safe(() => {
      checkPage(18);
      doc.setDrawColor(216, 211, 198); doc.setLineWidth(0.2); doc.line(margin, y, margin + contentW, y); y += 4;
      doc.setFont("helvetica", "italic"); doc.setFontSize(7); gray(130);
      for (const ln of split(DISCLAIMER, contentW)) { checkPage(); put(ln, margin, y); y += 3.4; }
      doc.setFont("helvetica", "normal");
    });
    safe(() => {
      const pages = doc.getNumberOfPages();
      for (let p = 1; p <= pages; p++) {
        doc.setPage(p); doc.setFontSize(7); doc.setFont("helvetica", "normal"); gray(150);
        put(`LEADS evaluation copy · ${input.generatedAt.toLocaleString()}`, margin, 293);
        put(`${p} / ${pages}`, pageW - margin, 293, { align: "right" });
      }
    });
    const evalName = (input.question || "report").slice(0, 30).replace(/\W+/g, "_");
    doc.save(`LEADS_evaluation_${evalName}.pdf`);
    return;
  }

  // Header bar
  safe(() => {
    doc.setFillColor(26, 26, 24); doc.rect(0, 0, pageW, 22, "F");
    doc.setFontSize(15); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    put("LEADS — Decision Report", margin, 12);
    doc.setFontSize(7); doc.setFont("helvetica", "normal"); doc.setTextColor(185, 185, 185);
    put(reportContextParts(m, input.profile).join("  ·  "), margin, 18);
    put(input.generatedAt.toLocaleString(), pageW - margin, 12, { align: "right" });
    doc.setTextColor(185, 185, 185);
    put(mode === "brief" ? "Decision brief" : "Full report", pageW - margin, 18, { align: "right" });
    y = 30;
  });

  // Question
  safe(() => { header("QUESTION", 34, 150, 200); para(input.question || "(question unavailable)", 11, 6); y += 3; });

  // Verdict (BLUF)
  safe(() => {
    const v = parseVerdict(m.content);
    header("VERDICT", 180, 69, 58);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11.5); doc.setTextColor(26, 26, 24);
    const verdict = v?.verdict || (stripBanner(m.content).split(/(?<=[.!?])\s/)[0] || "See the full response below.");
    for (const ln of split(verdict, contentW)) { checkPage(); put(ln, margin, y); y += 6; }
    doc.setFont("helvetica", "normal");
    const exc = deriveExceedanceProb(v?.forecastClause ?? null);
    if (exc) { doc.setTextColor(90, 90, 90); para(exc, 9, 5); }
    // Scope of the deterministic check behind the verdict (same words as the UI line).
    const scope = buildCheckScopeLine(m.pipeline);
    if (scope) { doc.setTextColor(110, 110, 110); para(scope, 8.5, 4.5); }
    y += 3;
  });

  // Confidence & freshness
  safe(() => {
    header("CONFIDENCE & DATA FRESHNESS", 34, 150, 200);
    const parts: string[] = [];
    if (m.confidence) parts.push(claimCheckMissing(m.claims) ? "Trust score: not given (no model checked the claims)" : `Trust score: ${(m.confidence.overall * 100).toFixed(1)}%`);
    const fresh = buildFreshness(m.chart);
    if (fresh.latestSensor) parts.push(`Latest sensor reading: ${fresh.latestSensor}`);
    if (fresh.forecastWindow) parts.push(`Forecast window: ${fresh.forecastWindow}`);
    para(parts.length ? parts.join("\n") : "(confidence data unavailable)", 9, 5);
    y += 2;
  });

  // Forecast numbers table (always, when a forecast exists)
  safe(() => {
    const ft = buildForecastTable(m.chart);
    if (!ft) return;
    header(`FORECAST${ft.horizonDays ? `  ·  ${ft.horizonDays}-day` : ""}`, 47, 111, 158);
    const row = (a: string, b: string) => {
      checkPage(); doc.setFontSize(9);
      doc.setTextColor(90, 90, 90); put(a, margin, y);
      doc.setTextColor(26, 26, 24); put(b, margin + 58, y); y += 5;
    };
    // Same direction-aware labels as the outlook cards: for an "above" threshold
    // (bloom) the pessimistic value is the 90th percentile, not the 10th.
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    row(cap(ft.pessimisticLabel), `${ft.pessimistic.toFixed(1)} ${ft.units}`);
    row("Expected · mean", `${ft.expected.toFixed(1)} ${ft.units}`);
    row(cap(ft.optimisticLabel), `${ft.optimistic.toFixed(1)} ${ft.units}`);
    if (ft.threshold) row(ft.threshold.label || "Threshold", `${ft.threshold.value} ${ft.units} (${ft.threshold.direction ?? ""})`);
    y += 3;
  });

  // Chart image (best-effort; the numbers above already carry the values)
  if (input.chartSvg) {
    const png = await svgToPngDataUrl(input.chartSvg);
    if (png) safe(() => {
      const imgW = contentW, imgH = imgW * (260 / 860);
      checkPage(imgH + 10);
      doc.addImage(png, "PNG", margin, y, imgW, imgH);
      y += imgH + 3;
      // Name the figure (variable, units, site, depth): the on-screen title is HTML
      // outside the captured SVG, so the image alone carries none of them.
      const ident = chartIdentity(m.chart);
      if (ident) { doc.setFont("helvetica", "normal"); doc.setTextColor(120, 120, 120); para(ident, 7.5, 3.5); }
      y += 3;
    });
  }

  // Forecast skill under the chart (full report only; the brief stays one page)
  // -- SKILL SECTION START --
  if (mode === "full") safe(() => {
    const site = m.chart?.site, variable = m.reproduce?.variable;
    if (!site || !variable || !(m.chart?.forecast?.length)) return;
    const sk = getForecastSkill(site, variable, m.chart?.depthM, m.chart?.questionHorizon ?? m.reproduce?.horizon);
    if (!sk) return;
    const label = SKILL_VARIABLE_LABEL[sk.variable] ?? sk.variable;
    checkPage(skillFigureHeight(sk, 40) + 10); // kept together, including the last caption line
    doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(79, 78, 71);
    put(upperKeepMicro(`Forecast skill  ·  ${label}  ·  FCR  ·  ${skillDepthLabel(SKILL_META.depth_m)}  ·  vs climatology`), margin, y + 1);
    y += 4;
    drawSkillFigure(sk, 40);
    y += 3;
  });
  // -- SKILL SECTION END --

  // Profile-question advisory (as on screen, under the chart)
  safe(drawAlignmentAdvisory);

  // Top evidence (brief/full only; the evaluation copy prints the full reference list)
  safe(() => {
    // The three top-ranked cited sources (pipeline order picks them), printed in
    // ascending display number; consecutive numbers from one source share a heading.
    const { keyEvidence } = buildSourceListing(m.citations, mode);
    if (!keyEvidence.length) return;
    header("KEY EVIDENCE", 120, 100, 200);
    for (const { docName, nums, pages, items } of keyEvidence) {
      checkPage(14);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
      put(`${nums.map((n) => `[${n}]`).join(" ")}  ${docName}${pages.length ? `  ·  p.${pages.join(", ")}` : ""}`, margin, y); y += 4;
      doc.setFont("helvetica", "normal"); doc.setTextColor(60, 60, 60);
      items.forEach((e, i) => {
        para(`${items.length > 1 ? `[${nums[i]}] ` : ""}${e.snippet}${!e.verbatim && e.snippet.length >= 220 ? "…" : ""}`, 8, 4);
      });
      y += 2;
    }
    // The full report prints the note under its REFERENCES list instead.
    if (mode === "brief") drawLiteratureNote(keyEvidence.flatMap((g) => g.items));
  });

  // Appendix (full report only): full response, sources, provenance, reproduce
  // code, glossary.
  if (mode === "full") {
    safe(() => { const b = stripBanner(m.content); if (!b) return; header("FULL RESPONSE", 34, 150, 200); renderResponseBody(b, 10, 5.5); y += 3; });

    safe(() => {
      // Only the sources the answer actually cited (matches the count + [N] numbers in
      // the prose), split into literature references vs operational LEADS-derived data.
      // Each list prints in ascending display number; consecutive numbers from one
      // source share a heading (buildSourceListing).
      const { references, data } = buildSourceListing(m.citations, mode);
      if (!references.length && !data.length) return;

      const renderSources = (groups: typeof references) => {
        for (const { docName, nums, pages, items } of groups) {
          checkPage(12);
          doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(80, 80, 80);
          put(`${nums.map((n) => `[${n}]`).join(" ")}  ${docName}${pages.length ? `  ·  p.${pages.join(", ")}` : ""}`, margin, y); y += 4;
          doc.setFont("helvetica", "normal"); doc.setTextColor(70, 70, 70);
          items.forEach((c, i) => {
            const t = (c.text ?? "").replace(/\s+/g, " ");
            const limit = excerptLimit(c, 300);
            para(`${items.length > 1 ? `[${nums[i]}] ` : ""}${t.slice(0, limit)}${t.length > limit ? "…" : ""}`, 8, 4);
          });
          y += 2;
        }
      };

      if (references.length) {
        header("REFERENCES (literature cited)", 120, 100, 200);
        renderSources(references);
        drawLiteratureNote(references.flatMap((g) => g.items));
      }
      if (data.length) {
        header("DATA & EVIDENCE (operational, LEADS-derived)", 120, 100, 200);
        renderSources(data);
      }
      checkPage(8);
      doc.setFont("helvetica", "normal"); doc.setTextColor(120, 120, 120);
      para(sourcesNote, 7.5, 3.6);
      y += 3;
    });

    safe(() => {
      header("PROVENANCE & AUDIT", 90, 90, 90);
      const fresh = buildFreshness(m.chart);
      const c = m.confidence;
      const lines = [
        `Forecast model: FLARE ${FLARE_MODEL}`,
        `Synthesis model: ${SYNTHESIS_MODEL} (default)`,
        m.chart?.threshold ? `Guardrail threshold: ${m.chart.threshold.label} (${m.chart.threshold.value} ${m.chart.units}, ${m.chart.threshold.direction ?? ""})` : "",
        fresh.latestSensor ? `Latest sensor date: ${fresh.latestSensor}` : "",
        fresh.forecastWindow ? `Forecast window: ${fresh.forecastWindow}` : "",
        m.faithfulness ? `Citation coverage: ${m.faithfulness.pct}% (${m.faithfulness.cited}/${m.faithfulness.total} sentences cited)` : "",
        c && claimCheckMissing(m.claims) ? "Claim check: no model checked the claims, so there is no trust breakdown" :
        c ? `Trust breakdown — grounding ${c.grounding.toFixed(2)}, verifier ${c.verifierConfidence.toFixed(2)}, policy ${c.policyAdherence.toFixed(2)}, coverage ${c.channelCoverage.toFixed(2)}` : "",
      ].filter(Boolean).join("\n");
      para(lines, 8.5, 5);
      y += 3;
    });

    safe(() => {
      if (!m.reproduce) return;
      header("REPRODUCE (Python — public VERA + FLARE data)", 90, 90, 90);
      doc.setFont("helvetica", "italic"); doc.setFontSize(8); doc.setTextColor(110, 110, 110);
      para("Runnable script — pulls the same public VERA + FLARE data; no API keys, no LEADS internals.", 8, 4);
      y += 1;
      // Compact monospace so the full script stays to ~1 page instead of sprawling.
      doc.setFont("courier", "normal"); doc.setFontSize(6.4); doc.setTextColor(45, 45, 45);
      for (const ln of split(buildReproduceSnippet(m.reproduce, "python"), contentW)) { checkPage(); put(ln, margin, y); y += 2.9; }
      doc.setFont("helvetica", "normal");
      y += 3;
    });

    safe(() => {
      header("GLOSSARY & THRESHOLDS", 90, 90, 90);
      GLOSSARY.forEach((g) => {
        checkPage(12);
        // Term on its own line, definition full-width below - no column overlap for
        // long terms (e.g. "pessimistic / expected / optimistic").
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(50, 50, 50);
        put(`${g.term}`, margin, y); y += 4;
        doc.setFont("helvetica", "normal"); doc.setTextColor(90, 90, 90);
        for (const ln of split(g.def, contentW)) { checkPage(); put(ln, margin, y); y += 3.9; }
        y += 2.5;
      });
      y += 1;
      THRESHOLDS.forEach((t) => { checkPage(); doc.setFontSize(8); doc.setTextColor(90, 90, 90); put(`${t.name}: ${t.rule}`, margin, y); y += 4; });
      y += 3;
    });
  }

  // Disclaimer (brief and full)
  safe(() => {
    checkPage(18);
    doc.setDrawColor(205, 205, 205); doc.setLineWidth(0.2); doc.line(margin, y, margin + contentW, y); y += 4;
    doc.setFont("helvetica", "italic"); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
    for (const ln of split(DISCLAIMER, contentW)) { checkPage(); put(ln, margin, y); y += 3.6; }
    doc.setFont("helvetica", "normal");
  });

  // Footer on every page
  safe(() => {
    const pageCount = doc.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFontSize(7); doc.setFont("helvetica", "normal"); doc.setTextColor(150, 150, 150);
      put(`LEADS decision report · ${input.generatedAt.toLocaleString()}`, margin, 293);
      put(`${p} / ${pageCount}`, pageW - margin, 293, { align: "right" });
    }
  });

  const fnameQ = (input.question || "report").slice(0, 30).replace(/\W+/g, "_");
  doc.save(`LEADS_decision_${fnameQ}.pdf`);
}
