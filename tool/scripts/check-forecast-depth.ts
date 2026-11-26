/**
 * Forecast depth gate (offline).
 *
 * A full-profile plan (water extraction) resolves no single depth; its FLARE read uses
 * the reservoir's surface sensor depth instead of FLARE's unobserved 0 m layer. Plans
 * that resolved depths keep them, and plans with no scope keep an empty filter.
 *
 *   npx tsx scripts/check-forecast-depth.ts
 */
import { forecastTargetDepths } from "../lib/leads/forecast";
import type { LeadsQueryPlan } from "../lib/leads/types";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
const plan = (over: Partial<LeadsQueryPlan>): LeadsQueryPlan =>
  ({ originalQuery: "q", variableHints: ["DO_mgL_mean"], siteHints: ["fcre"], ...over } as unknown as LeadsQueryPlan);

console.log("\n[forecast depth]");
const fcrFull = forecastTargetDepths(plan({ resolvedDepthScope: "full_profile", resolvedDepthsM: [] }));
check("FCR full profile reads the 1.6 m surface sensor layer", JSON.stringify(fcrFull) === "[1.6]", JSON.stringify(fcrFull));
const bvrFull = forecastTargetDepths(plan({ resolvedDepthScope: "full_profile", resolvedDepthsM: [], siteHints: ["bvre"] }));
check("BVR full profile reads the 1.5 m surface sensor layer", JSON.stringify(bvrFull) === "[1.5]", JSON.stringify(bvrFull));
const zone = forecastTargetDepths(plan({ resolvedDepthScope: "profile_zone", resolvedDepthsM: [9] }));
check("a resolved depth is kept", JSON.stringify(zone) === "[9]", JSON.stringify(zone));
const none = forecastTargetDepths(plan({}));
check("no scope keeps the empty filter (unchanged)", JSON.stringify(none) === "[]", JSON.stringify(none));

console.log(failed ? `\n[forecast depth] ${failed} failed` : "\n[forecast depth] all passed\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
