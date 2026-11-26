/**
 * Standalone forecast endpoint for LEADS.
 *
 * Data source: FLARE GLM-AED 221-member ensemble
 *   OSN bucket: bio230121-bucket01/flare/forecasts/parquet/
 *   Endpoint:   https://amnh1.osn.mghpcc.org
 *
 * GET /api/forecast?site=fcre&variable=Temp_C_mean&horizon=7 (optional &zone=hypolimnion)
 *      Returns raw ensemble statistics and risk assessments as JSON.
 */

import { NextRequest } from "next/server";

import { buildEnsembleSummaries, generateRiskAssessments } from "@/lib/leads/ensemble";
import { fetchFlareForecasts, discoverLatestFlareDate } from "@/lib/leads/flare-reader";
import {
  LEADS_FLARE_LOOKBACK_DAYS,
  LEADS_FLARE_MODEL_ID,
  LEADS_FLARE_SITE,
  LEADS_FORECAST_SITES,
  LEADS_FORECAST_VARIABLES,
} from "@/lib/leads/config";
import { resolveDepthMeters } from "@/lib/leads/guardrails";
import type { LeadsReservoir, LeadsDepthZone } from "@/lib/leads/types";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const site = searchParams.get("site") ?? LEADS_FLARE_SITE;
  const variable = searchParams.get("variable") ?? "Temp_C_mean";
  // Clamp to 1-35 days; a missing or non-numeric value means 7 (the chart sends 7-35).
  const rawHorizon = parseInt(searchParams.get("horizon") ?? "7", 10);
  const horizon = Math.min(Math.max(Number.isFinite(rawHorizon) ? rawHorizon : 7, 1), 35);

  if (!(LEADS_FORECAST_SITES as readonly string[]).includes(site)) {
    return Response.json(
      { error: `Invalid site. Valid: ${LEADS_FORECAST_SITES.join(", ")}` },
      { status: 400 }
    );
  }
  if (!(LEADS_FORECAST_VARIABLES as readonly string[]).includes(variable)) {
    return Response.json(
      { error: `Invalid variable. Valid: ${LEADS_FORECAST_VARIABLES.join(", ")}` },
      { status: 400 }
    );
  }

  // Optional `zone`: read the FLARE layers for that depth zone; without it, the
  // shallowest FLARE layer is returned.
  const SITE_TO_RESERVOIR: Record<string, LeadsReservoir> = { fcre: "fcr", bvre: "bvr" };
  const VALID_ZONES: readonly LeadsDepthZone[] = ["epilimnion", "metalimnion", "hypolimnion"];
  const zoneParam = searchParams.get("zone");
  const reservoir = SITE_TO_RESERVOIR[site];
  let targetDepthsM: number[] = [];
  if (reservoir && zoneParam && (VALID_ZONES as readonly string[]).includes(zoneParam)) {
    try {
      targetDepthsM = resolveDepthMeters(reservoir, zoneParam as LeadsDepthZone);
    } catch {
      targetDepthsM = [];
    }
  }

  try {
    const referenceDate = await discoverLatestFlareDate(site);
    if (!referenceDate) {
      return Response.json(
        { error: `No FLARE data found within the last ${LEADS_FLARE_LOOKBACK_DAYS} days` },
        { status: 503 }
      );
    }

    const records = await fetchFlareForecasts({
      siteId: site,
      variables: [variable],
      maxHorizonDays: horizon,
      targetDepthsM,
    });

    const ensembles = buildEnsembleSummaries(records);
    const risks = generateRiskAssessments(records, horizon);

    return Response.json({
      source: "flare-glm-aed",
      model: LEADS_FLARE_MODEL_ID,
      ensembleSize: 221,
      referenceDate,
      site,
      variable,
      horizon,
      depths: targetDepthsM,
      recordCount: records.length,
      ensembles,
      risks,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "FLARE forecast fetch failed" },
      { status: 500 }
    );
  }
}
