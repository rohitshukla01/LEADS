import type { LeadsEvidence, LeadsQueryPlan } from "./types";

export interface OperationalSensorAdapterConfig {
  endpoint?: string;
  apiKey?: string;
}

export function getOperationalSensorConfig(): OperationalSensorAdapterConfig {
  return {
    endpoint: process.env.LEADS_OPERATIONAL_SENSOR_URL,
    apiKey: process.env.LEADS_OPERATIONAL_SENSOR_API_KEY,
  };
}

export async function retrieveOperationalSensorEvidence(
  plan: LeadsQueryPlan
): Promise<LeadsEvidence[]> {
  const config = getOperationalSensorConfig();
  if (!config.endpoint) {
    return [];
  }

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        siteHints: plan.siteHints,
        variableHints: plan.variableHints,
        timeHints: plan.timeHints,
        // Depth filter forwarded so the operational adapter can pre-filter on
        // its side when supported.
        resolvedDepthsM: plan.resolvedDepthsM ?? [],
        query: plan.originalQuery,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as {
      evidence?: Array<{
        id: string;
        title: string;
        text: string;
        score?: number;
        siteId?: string;
        variable?: string;
        depthM?: number | null;
        timestamp?: string;
      }>;
    };

    // Depth filter applied on this side too, in case the operational adapter
    // does not honour `resolvedDepthsM` in the request body.
    const filtered = (payload.evidence ?? []).filter((item) => {
      const depths = plan.resolvedDepthsM ?? [];
      if (depths.length === 0) return true;
      if (item.depthM == null) return true;
      return depths.some((d) => Math.abs((item.depthM as number) - d) <= 0.05);
    });

    return filtered.map((item, index) => ({
      id: item.id || `operational:${index}`,
      channel: "sensor",
      title: item.title,
      text: item.text,
      score: item.score ?? Math.max(0.2, 1 - index * 0.05),
      provenance: {
        type: "sensor",
        label: item.title,
        sourceUrl: config.endpoint,
        siteId: item.siteId,
        variable: item.variable,
        depthM: item.depthM ?? null,
        timestamp: item.timestamp,
        method: "operational-stream",
        score: item.score ?? Math.max(0.2, 1 - index * 0.05),
      },
    }));
  } catch {
    return [];
  }
}
