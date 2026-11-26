// Single source of truth for the forecast horizon inferred from a query.
//
// Consumed by both the answer path (lib/leads/forecast.ts - evidence fetch +
// verdict banner) and the chart/planner (lib/leads/router.ts, LeadsChartSpec),
// so the answer, the banner, the chart, and the reproduce snippet can never
// disagree about how many forecast days the question asked for.
//
// Pure and import-free (router.ts and forecast.ts don't import each other, so
// both importing this module forms no cycle).

/**
 * Forecast horizon in days, parsed from the natural-language query. Returns one
 * of FLARE's supported lead times; defaults to 7 when the query is time-silent.
 *
 * Digit branches are `\b`-anchored and allow only an optional hyphen or space
 * before "day", so a horizon like "21-day" is never misread as "1 day". A
 * descriptive range such as "1- to 35-day horizons" is intentionally left on the
 * default rather than parsed as a directive.
 *
 * This returns the raw horizon the answer reasons over (1/2/3/7/14/21/30).
 * The chart clamps it for display via clampChartHorizon(); the answer/banner use
 * the raw value.
 */
export function inferHorizon(query: string): number {
  const q = query.toLowerCase();
  if (/tomorrow|next day|\b1\s*[-\s]?days?\b/.test(q)) return 1;
  if (/next\s*(2|two|couple)\s*days?|\b2\s*[-\s]?days?\b/.test(q)) return 2;
  if (/next\s*(3|three)\s*days?|\b3\s*[-\s]?days?\b/.test(q)) return 3;
  if (/next\s*week|\b7\s*[-\s]?days?\b/.test(q)) return 7;
  if (/next\s*(2|two)\s*weeks?|\bfortnight\b|\b14\s*[-\s]?days?\b/.test(q)) return 14;
  if (/next\s*(3|three)\s*weeks?|\b21\s*[-\s]?days?\b/.test(q)) return 21;
  if (/next\s*month|\b30\s*[-\s]?days?\b/.test(q)) return 30;
  return 7;
}

/**
 * Clamp a raw horizon to the chart's readable display window: floor 7 (a sub-7
 * answer still shows a full week of forecast) and ceiling 35 (FLARE's horizon).
 * This is a display choice: the answer/banner keep the raw horizon, so for a
 * sub-7 query the chart intentionally extends past the answer's stated horizon.
 * The reproduce snippet uses this same clamped value so the copyable code always
 * reproduces exactly what the chart shows.
 */
export const clampChartHorizon = (h: number): number => Math.min(Math.max(h, 7), 35);
