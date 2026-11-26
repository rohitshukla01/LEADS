/**
 * Ensemble member trajectories for the chart's optional "Show ensemble members" view.
 *
 * GET /api/forecast/members?site=fcre&variable=Chla_ugL_mean&depth=1.6&horizon=7
 *
 * Read-only and display-only: it streams the same public FLARE parquet as GET
 * /api/forecast and returns one trajectory per member. No model calls; the answer
 * pipeline does not use it.
 */

import { NextRequest } from "next/server";

import { fetchMemberTrajectories } from "@/lib/leads/flare-reader";
import { LEADS_FORECAST_SITES, LEADS_FORECAST_VARIABLES } from "@/lib/leads/config";

export const maxDuration = 60;   // healthy runs take ~8-33 s; a stalled stream is cut off at 60 s

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const site = searchParams.get("site") ?? "";
  const variable = searchParams.get("variable") ?? "";
  const rawHorizon = parseInt(searchParams.get("horizon") ?? "7", 10);
  const horizon = Math.min(Math.max(Number.isFinite(rawHorizon) ? rawHorizon : 7, 1), 35);
  const rawDepth = parseFloat(searchParams.get("depth") ?? "0");
  // Snapped to 0.1 m (FLARE layers sit on whole decimetres), which also bounds the cache.
  const depthM = Number.isFinite(rawDepth) ? Math.round(Math.min(Math.max(rawDepth, 0), 40) * 10) / 10 : 0;

  if (!(LEADS_FORECAST_SITES as readonly string[]).includes(site)) {
    return Response.json({ error: `Invalid site. Valid: ${LEADS_FORECAST_SITES.join(", ")}` }, { status: 400 });
  }
  if (!(LEADS_FORECAST_VARIABLES as readonly string[]).includes(variable)) {
    return Response.json({ error: `Invalid variable. Valid: ${LEADS_FORECAST_VARIABLES.join(", ")}` }, { status: 400 });
  }

  const traj = await fetchMemberTrajectories({ siteId: site, variable, depthM, maxHorizonDays: horizon });
  if (!traj) return Response.json({ error: "Ensemble members unavailable" }, { status: 503 });

  const r = (v: number | null) => (v == null ? null : Math.round(v * 1e4) / 1e4);
  return Response.json({
    site,
    variable,
    referenceDate: traj.referenceDate,
    depthM: traj.depthM,
    dates: traj.dates,
    members: traj.members.map((row) => row.map(r)),
  });
}
