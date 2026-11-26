import { NextRequest, NextResponse } from "next/server";

import { LEADS_PUBLIC_VERA_URL } from "@/lib/leads/config";
import { baselineForRecord, computeBaselineStats, fetchPublicSensorRecords } from "@/lib/leads/sensor-public";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site")?.toLowerCase() ?? "";
    const variable = req.nextUrl.searchParams.get("variable") ?? "";
    const limit = Math.max(1, Math.min(50, Number(req.nextUrl.searchParams.get("limit") ?? "12")));

    const records = await fetchPublicSensorRecords();
    const filtered = records
      .filter((record) => (site ? record.siteId === site : true))
      .filter((record) => (variable ? record.variable === variable : true))
      .sort((left, right) => right.datetime.localeCompare(left.datetime))
      .slice(0, limit);

    const baselines = computeBaselineStats(records).filter((baseline) =>
      filtered.some(
        (record) =>
          record.siteId === baseline.siteId &&
          record.variable === baseline.variable
      )
    );
    const matchedBaselines = filtered
      .map((record) => {
        const baseline = baselineForRecord(record, baselines);
        return baseline
          ? {
              recordDatetime: record.datetime,
              recordDepthM: record.depthM,
              ...baseline,
            }
          : null;
      })
      .filter(Boolean);

    return NextResponse.json({
      sourceUrl: LEADS_PUBLIC_VERA_URL,
      count: filtered.length,
      records: filtered,
      matchedBaselines,
      baselines: baselines.slice(0, 24),
      operationalLaneConfigured: Boolean(process.env.LEADS_OPERATIONAL_SENSOR_URL),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sensor fetch failed" },
      { status: 500 }
    );
  }
}
