/**
 * Typesetting gate for the chart panel and the decision-report PDF (display only).
 *
 *   npx tsx scripts/check-report-typesetting.ts
 *
 * Offline: no network, no model calls (the one fetch-based function is run
 * against an in-memory stub). Locks in the deterministic display behaviour:
 *  1. µ-safe upper case - "µg/L" must survive an upper-cased PDF eyebrow.
 *  2. Header from the message - site through one display table, "informational" for
 *     decision "none", depth from what the chart drew, stored profile beats the live one.
 *  3. Figure identity - "<variable> (<units>) · <site> · <depth>" on every printed chart.
 *  4. Outlook caption - percentile order follows the cards actually drawn.
 *  5. Even calendar ticks - equal gaps, latest day labelled, every tick a UTC midnight.
 *  6. N-day window - N days, not N+1: fetch, render-time trim, both reproduce templates.
 *  7. Alignment advisory - built from the message and drawn in every PDF mode.
 */
// Spring-forward night inside the DST test window below. Set before any Date is built.
process.env.TZ = "America/New_York";

import { readFileSync } from "fs";
import { join } from "path";
import {
  sanitizePdfText, upperKeepMicro, reportContextParts, chartIdentity, buildForecastTable,
  outlookCardOrder, buildAlignmentAdvisory, GLOSSARY, type ReportChart, type ReportMessage,
} from "../lib/report-content";
import {
  calendarTicks, trimToTrailingWindow, fetchSensorSeries, siteDisplayName, VARIABLE_META,
} from "../lib/insights";
import { buildReproduceSnippet } from "../lib/reproduce";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}
const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const MICRO = "\u00b5"; // micro sign (CP1252), not Greek small mu U+03BC
const DAY = 86_400_000;
const utc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const reportSrc = src("lib/report.ts");
const panelSrc = src("components/InsightPanel.tsx");
const pageSrc = src("app/page.tsx");

// 1. µ-safe upper case
console.log("\n[1] micro sign in upper-cased PDF labels");
const thr = `vs 20 ${MICRO}g/L threshold`;
check("premise: plain toUpperCase() loses µ through the PDF filter",
  !sanitizePdfText(thr.toUpperCase()).includes(MICRO), sanitizePdfText(thr.toUpperCase()));
check("upperKeepMicro keeps µ and upper-cases the rest",
  upperKeepMicro(thr) === `VS 20 ${MICRO}G/L THRESHOLD`, upperKeepMicro(thr));
check("number and unit keep their space in the PDF (narrow no-break space folded, not deleted)",
  sanitizePdfText("10.76\u202F\u00b5g/L at 1.6\u202Fm, 20\u00a0\u00b5g/L") === "10.76 \u00b5g/L at 1.6 m, 20 \u00b5g/L",
  sanitizePdfText("10.76\u202F\u00b5g/L at 1.6\u202Fm, 20\u00a0\u00b5g/L"));
check("µ survives sanitizePdfText after upperKeepMicro",
  sanitizePdfText(upperKeepMicro(thr)).includes(`${MICRO}G/L`));
const microUnits = Object.values(VARIABLE_META).map((v) => v.units).filter((u) => /^\S?g\/L$/.test(u) && u !== "mg/L");
check("chart units spell micro with U+00B5 (the sign upperKeepMicro protects)",
  microUnits.length > 0 && microUnits.every((u) => u.startsWith(MICRO)), microUnits.join(", "));
check("report.ts: eyebrow draw AND width check both use upperKeepMicro(label)",
  count(reportSrc, "upperKeepMicro(label)") >= 2);
check("report.ts: no upper-casing of a raw eyebrow label or header",
  !/label\.toUpperCase\(\)|longHead\.toUpperCase\(\)/.test(reportSrc));

// 2. Header built from the message
console.log("\n[2] PDF header context");
const msg = (over: Partial<ReportMessage>): ReportMessage => ({ id: 1, content: "x", ...over });
const chart = (over: Partial<ReportChart>): ReportChart => ({
  label: "Dissolved oxygen", units: "mg/L", site: "fcre", depthM: null, sensor: null, forecast: null, ...over,
});
const hdr = (m: ReportMessage, fb?: Parameters<typeof reportContextParts>[1]) => reportContextParts(m, fb).join(" | ");

check("site display table: fcre/bvre/ccre/fcr -> FCR/BVR/CCR/FCR",
  ["fcre", "bvre", "ccre", "fcr"].map(siteDisplayName).join(",") === "FCR,BVR,CCR,FCR");
const h1 = hdr(msg({ profile: { persona: "manager", reservoir: "fcr", decision: "hypoxia_management" }, chart: chart({ depthM: 9 }) }));
check("operational answer: site from chart, decision spaced, depth from depthM", h1 === "FCR | manager | hypoxia management | 9 m", h1);
const h2 = hdr(msg({ profile: { persona: "researcher", reservoir: "fcr", decision: "none" } }));
check("informational, no chart: 'informational', no depth", h2 === "FCR | researcher | informational", h2);
const h3 = hdr(msg({
  profile: { persona: "manager", reservoir: "fcr", decision: "water_extraction" },
  chart: chart({ depthSeries: [{ label: "1.6 m", points: [] }, { label: "5 m", points: [] }, { label: "9 m", points: [] }] }),
}));
check("full-profile chart: depth lists every charted depth", h3 === "FCR | manager | water extraction | 1.6 / 5 / 9 m", h3);
const h4 = hdr(msg({ profile: { persona: "researcher", reservoir: "bvr", decision: "none" } }),
  { persona: "manager", reservoir: "fcr", decision: "hypoxia_management" });
check("profile stored on the message beats the live profile", h4 === "BVR | researcher | informational", h4);
const h5 = hdr(msg({ chart: chart({ site: "bvre", depthM: 1.5 }) }), { persona: "manager", reservoir: "bvr", decision: "algal_management" });
check("live profile is the fallback for messages saved without one", h5 === "BVR | manager | algal management | 1.5 m", h5);
check("header never prints a dropdown placeholder, 'none' or a raw site id",
  ![h1, h2, h3, h4, h5].some((h) => /epilimnion|\bnone\b|FCRE|BVRE/.test(h)));
check("report.ts: both headers (evaluation + brief/full) use reportContextParts",
  count(reportSrc, "reportContextParts(m, input.profile)") === 2 && !reportSrc.includes("depthLabel"));
check("page.tsx: assistant message records its profile at send time",
  /role: "assistant",[^\n]*profile: \{ persona: profile\.persona, reservoir: profile\.reservoir, decision: profile\.decision \}/.test(pageSrc));
check("page.tsx: report does not receive the dropdown's cosmetic depth", !/depthLabel: profile\.depth/.test(pageSrc));

// 3. Figure identity on printed charts
console.log("\n[3] chart identity");
const id1 = chartIdentity(chart({ label: "Chlorophyll-a", units: `${MICRO}g/L`, depthM: 1.6 }));
check("single depth", id1 === `Chlorophyll-a (${MICRO}g/L) · FCR · 1.6 m`, String(id1));
const id2 = chartIdentity(chart({ site: "bvre", depthSeries: [{ label: "1.5 m", points: [] }, { label: "8 m", points: [] }] }));
check("full profile", id2 === "Dissolved oxygen (mg/L) · BVR · 1.5 / 8 m", String(id2));
check("depth unknown -> omitted", chartIdentity(chart({})) === "Dissolved oxygen (mg/L) · FCR");
check("no chart -> null", chartIdentity(null) === null);
check("report.ts: identity printed with the chart in evaluation AND brief/full", count(reportSrc, "chartIdentity(m.chart)") >= 2);
check("InsightPanel: on-screen header uses the same site/depth helpers",
  panelSrc.includes("siteDisplayName(site)") && panelSrc.includes("chartDepthLabel(") && !panelSrc.includes("site.toUpperCase()"));

// 4. Outlook caption follows the drawn card order
console.log("\n[4] outlook caption order");
const fcPt = [{ t: "2026-08-24", mean: 12, lower: 3, upper: 40, p10: 5, p90: 30 }];
for (const dir of ["above", "below", undefined] as const) {
  const ft = buildForecastTable(chart({ forecast: fcPt, threshold: dir ? { value: 20, label: "t", direction: dir } : undefined }))!;
  const [l, r] = ft.cardPercentiles;
  const want = dir === "above" ? "90th percentile / mean / 10th percentile" : "10th percentile / mean / 90th percentile";
  check(`direction ${dir ?? "none"}: caption '${outlookCardOrder(ft)}'`, outlookCardOrder(ft) === want);
  check(`direction ${dir ?? "none"}: caption matches the card labels and values`,
    ft.pessimisticLabel.includes(`${l}th`) && ft.optimisticLabel.includes(`${r}th`) &&
    ft.pessimistic === (l === 90 ? 30 : 5) && ft.optimistic === (r === 90 ? 30 : 5));
}
check("report.ts: no fixed '10th / mean / 90th' caption",
  !reportSrc.includes("10th percentile / mean / 90th percentile at day") && reportSrc.includes("outlookCardOrder(ft)"));
check("report.ts: forecast table reuses the card labels (no fixed '10th pct' / '90th pct')",
  !/"Pessimistic \(10th pct\)"|"Optimistic \(90th pct\)"/.test(reportSrc) &&
  reportSrc.includes("row(cap(ft.pessimisticLabel)") && reportSrc.includes("row(cap(ft.optimisticLabel)"));
const pesGloss = GLOSSARY.find((g) => g.term.startsWith("pessimistic"))?.def ?? "";
check("glossary: pessimistic/optimistic defined for both threshold directions",
  pesGloss.includes("pessimistic is the 10th") && pesGloss.includes("pessimistic is the 90th"), pesGloss);

// 5. Even calendar ticks
console.log("\n[5] date-axis ticks");
// Same tick-count rule as UnifiedChart.
const wantedFor = (spanDays: number) => (spanDays === 0 ? 1 : Math.max(5, Math.min(9, Math.round(spanDays / 6) + 1)));
const even = (ticks: number[]) => ticks.every((t, i) => i < 2 || t - ticks[i - 1] === ticks[1] - ticks[0]);
// Index-based picker, used only to show that the test detects uneven gaps.
const oldTicks = (days: number[], wanted: number) => {
  const n = Math.max(1, Math.min(wanted, days.length));
  return n <= 1 ? [days[0]] : [...new Set(Array.from({ length: n }, (_, k) => days[Math.round((k / (n - 1)) * (days.length - 1))]))];
};
const days8 = Array.from({ length: 8 }, (_, i) => utc("2026-08-16") + i * DAY);
check("premise: an index-based picker spaces an 8-day axis unevenly",
  !even(oldTicks(days8, wantedFor(7))), oldTicks(days8, wantedFor(7)).map(iso).join(" "));
const t8 = calendarTicks(days8[0], days8[7], wantedFor(7));
check("8-day axis: even gaps, latest day labelled", even(t8) && t8[t8.length - 1] === days8[7], t8.map(iso).join(" "));
let tickFails: string[] = [];
const tEnd = utc("2026-09-30");
for (let span = 1; span <= 70; span++) {
  const tMin = tEnd - span * DAY, w = wantedFor(span), ticks = calendarTicks(tMin, tEnd, w);
  const ok = ticks.length >= 2 && ticks.length <= w && even(ticks) && ticks[ticks.length - 1] === tEnd &&
    ticks[0] >= tMin && ticks.every((t) => t % DAY === 0);
  if (!ok) tickFails.push(`span ${span}: ${ticks.map(iso).join(" ")}`);
}
check("spans 1-70 days: 2..wanted ticks, equal gaps, last = latest, all UTC midnights", tickFails.length === 0, tickFails.slice(0, 3).join("; "));
check("single day: one tick", calendarTicks(tEnd, tEnd, 1).length === 1);
check("InsightPanel: axis uses calendarTicks", panelSrc.includes("calendarTicks(tMin, tMax, wanted)"));

// 6. N-day window
async function windowChecks() {
  console.log("\n[6] N-day window");
  const realFetch = globalThis.fetch;
  const stub = (days: string[]) => {
    const records = days.map((d, i) => ({ datetime: `${d} 00:00:00`, observation: 5 + i * 0.1, depthM: 9 }));
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ records }) })) as unknown as typeof fetch;
  };
  const daysFrom = (start: string, n: number) => Array.from({ length: n }, (_, i) => iso(utc(start) + i * DAY));
  try {
    for (const N of [7, 14, 30]) {
      stub(daysFrom("2026-07-01", 40));
      const r = await fetchSensorSeries("fcre", "DO_mgL_mean", N, "hypolimnion");
      const pts = r?.points ?? [];
      check(`fetch: ${N}-day window holds ${N} days`, pts.length === N,
        `${pts.length} pts, ${pts[0]?.t.slice(0, 10)} to ${pts[pts.length - 1]?.t.slice(0, 10)}`);
    }
    // Local midnights either side of the spring-forward night are 7 d - 1 h apart.
    const localGap = new Date("2026-03-12 00:00:00").getTime() - new Date("2026-03-05 00:00:00").getTime();
    stub(daysFrom("2026-03-01", 12));
    const dst = (await fetchSensorSeries("fcre", "DO_mgL_mean", 7, "hypolimnion"))?.points ?? [];
    check(`fetch across the DST change: 7 days (local-midnight gap ${(localGap / 3600000).toFixed(0)} h)`,
      dst.length === 7 && dst[0].t.startsWith("2026-03-06"), `${dst.length} pts from ${dst[0]?.t}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Render-time trim (saved conversations may hold an N+1-day series).
  const stamped = (n: number) => Array.from({ length: n }, (_, i) => ({ t: utc("2026-08-16") + i * DAY, v: i }));
  check("trim: stored 8-day series -> 7 days", trimToTrailingWindow(stamped(8), 7).length === 7);
  check("trim: idempotent on an N-day series", trimToTrailingWindow(stamped(7), 7).length === 7);
  check("trim: no window -> untouched", trimToTrailingWindow(stamped(8), undefined).length === 8);
  check("trim: fewer than 2 left -> untouched (same fallback as the fetch)",
    trimToTrailingWindow([{ t: utc("2026-08-01"), v: 1 }, { t: utc("2026-08-20"), v: 2 }], 7).length === 2);
  // Full-profile traces are fetched one depth at a time, each windowed from its own latest
  // day; the render-time trim must do the same, or a lagging sonde loses its oldest days.
  const lagging = stamped(7).slice(0, 5);   // a trace whose latest day is 2 days earlier
  check("trim: each trace from its own latest day (a lagging trace keeps its window)",
    trimToTrailingWindow(lagging, 3).length === 3 && trimToTrailingWindow(lagging, 3)[2].t === lagging[4].t);
  check("InsightPanel trims observed traces; page passes the plan window",
    count(panelSrc, "trimToTrailingWindow(") >= 2 && pageSrc.includes("windowDays={m.reproduce?.days}"));

  // Both reproduce templates.
  const params = { site: "fcre", variable: "DO_mgL_mean", depthM: 9, days: 7, horizon: 7, climatology: true, forecast: true, threshold: null };
  const py = buildReproduceSnippet(params, "python"), rr = buildReproduceSnippet(params, "r");
  check("reproduce (python): strict '>' window cutoff",
    py.includes("s = s[s.datetime > s.datetime.max() - pd.Timedelta(days=days)]") && !/datetime >= s\.datetime\.max\(\)/.test(py));
  check("reproduce (r): strict '>' window cutoff",
    rr.includes("d <- d[d$datetime > max(d$datetime) - days, ]") && !/datetime >= max\(d\$datetime\)/.test(rr));
}

// 7. Alignment advisory in every PDF mode
function advisoryChecks() {
  console.log("\n[7] alignment advisory");
  check("aligned / absent -> nothing drawn",
    buildAlignmentAdvisory({ aligned: true, severity: "aligned", dimensions: [], rationale: "" }) === null &&
    buildAlignmentAdvisory(undefined) === null);
  const mode = buildAlignmentAdvisory({ aligned: false, severity: "hard", dimensions: ["mode"], rationale: "r1" });
  check("mode mismatch -> 'No guardrail enforced' (UI title rule)", mode?.title === "No guardrail enforced" && mode.text === "r1" && mode.hard);
  const soft = buildAlignmentAdvisory({ aligned: false, severity: "soft", dimensions: ["zone"], rationale: "r2" });
  check("other mismatch -> 'Profile mismatch · soft'", soft?.title === "Profile mismatch · soft" && !soft.hard);
  const evalEnd = reportSrc.indexOf("doc.save(`LEADS_evaluation_");
  const calls = [...reportSrc.matchAll(/safe\(drawAlignmentAdvisory\)/g)].map((x) => x.index ?? -1);
  check("report.ts: advisory drawn in the evaluation copy AND in brief/full",
    calls.length === 2 && calls[0] < evalEnd && calls[1] > evalEnd, `calls at ${calls.join(", ")}; eval ends ${evalEnd}`);
}

windowChecks()
  .then(() => {
    advisoryChecks();
    const ok = failures === 0;
    console.log(`\n${ok ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("check crashed:", e);
    process.exit(1);
  });
