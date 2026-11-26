/**
 * Checks for `inferHorizon` (lib/leads/horizon.ts).
 *
 *   npx tsx scripts/check-horizon.ts
 *
 *  1. Benchmark consistency: `inferHorizon` must return the same horizon as the
 *     reference implementation below for every benchmark question. Any mismatch
 *     exits non-zero.
 *  2. Regression: fixed expectations for phrasings the benchmark does not use,
 *     such as multi-digit horizons ("21-day") and short or mid-range horizons.
 *
 * The repo has no unit-test runner (npm scripts use `npx tsx`), so this file is the
 * check to re-run whenever inferHorizon or the benchmark questions change.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { inferHorizon } from "../lib/leads/horizon";

// Reference implementation (a simpler, unanchored pattern set)
function inferHorizonReference(query: string): number {
  const q = query.toLowerCase();
  if (/tomorrow|next day|1.?day/.test(q)) return 1;
  if (/next\s*(2|two|couple)\s*days?/.test(q)) return 2;
  if (/next\s*(3|three)\s*days?/.test(q)) return 3;
  if (/next\s*week|7.?day/.test(q)) return 7;
  if (/next\s*(2|two)\s*weeks?|14.?day/.test(q)) return 14;
  if (/next\s*month|30.?day/.test(q)) return 30;
  return 7;
}

// Collect every question from the benchmark case files
// The benchmark questions are in reproduce_paper/benchmark at the repository root.
const BENCHMARK_DIR = join(__dirname, "..", "..", "reproduce_paper", "benchmark");
const QUERY_KEYS = new Set(["question", "user_input", "query"]);

function collectStrings(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const el of node) collectStrings(el, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (QUERY_KEYS.has(k) && typeof v === "string" && v.trim()) out.push(v);
      else collectStrings(v, out);
    }
  }
}

type Q = { file: string; text: string };
const queries: Q[] = [];
for (const f of existsSync(BENCHMARK_DIR) ? readdirSync(BENCHMARK_DIR) : []) {
  if (!f.endsWith(".json")) continue; // top-level JSON case files only
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(BENCHMARK_DIR, f), "utf8"));
  } catch {
    continue; // ignore any non-JSON / malformed file
  }
  const found: string[] = [];
  collectStrings(parsed, found);
  for (const text of found) if (!queries.some((q) => q.text === text)) queries.push({ file: f, text });
}
if (queries.length === 0) console.log("\n[benchmark] skipped: reproduce_paper/benchmark not found");

// Check 1: the reference and inferHorizon agree on every benchmark question
const mismatches = queries.filter((q) => inferHorizonReference(q.text) !== inferHorizon(q.text));
const horizons = new Set(queries.map((q) => inferHorizon(q.text)));

console.log(`\n[benchmark] scanned ${queries.length} benchmark questions`);
console.log(`[benchmark] distinct horizons across the benchmark: {${[...horizons].sort((a, b) => a - b).join(", ")}}`);
if (mismatches.length === 0) {
  console.log(`[benchmark] PASS — inferHorizon matches the reference on all ${queries.length} questions.`);
} else {
  console.error(`[benchmark] FAIL — ${mismatches.length} question(s) differ from the reference:`);
  for (const m of mismatches) {
    console.error(`  (${m.file}) reference=${inferHorizonReference(m.text)} inferHorizon=${inferHorizon(m.text)}  ::  ${m.text.slice(0, 90)}`);
  }
}

// Check 2: fixed expectations for phrasings outside the benchmark
// [phrase, expected, reference]: the third value is what the reference
// implementation returns; only the expected value is asserted.
const REGRESSION: [string, number, number][] = [
  // Multi-digit horizons (the unanchored reference pattern `1.?day` matches inside "21").
  ["what is the 21-day forecast for chl-a?", 21, 1],
  ["probability over the next 21 days", 21, 1],
  ["21 day outlook", 21, 1],
  // Short and mid-range horizons.
  ["3-day forecast", 3, 7],
  ["2-day outlook", 2, 7],
  ["what happens over the next two weeks?", 14, 14],
  ["fortnight forecast", 14, 7],
  // Anchors shared with the reference.
  ["tomorrow's temperature", 1, 1],
  ["next week's bloom risk", 7, 7],
  ["7-day hypoxia risk", 7, 7],
  ["14-day forecast", 14, 14],
  ["next month's outlook", 30, 30],
  ["what is the DO right now?", 7, 7], // no time phrase: default 7
  // A descriptive range of horizons is not a request for a specific horizon.
  ["forecast skill across 1- to 35-day horizons, assimilated fortnightly or monthly", 7, 7],
];

const regFails = REGRESSION.filter(([phrase, want]) => inferHorizon(phrase) !== want);
console.log(`\n[regression] ${REGRESSION.length} locked expectations`);
if (regFails.length === 0) {
  console.log(`[regression] PASS — all ${REGRESSION.length} phrasings resolve as intended.`);
} else {
  console.error(`[regression] FAIL — ${regFails.length} phrasing(s) wrong:`);
  for (const [phrase, want] of regFails) {
    console.error(`  want ${want}, got ${inferHorizon(phrase)}  ::  ${phrase}`);
  }
}

const ok = mismatches.length === 0 && regFails.length === 0;
console.log(`\n${ok ? "ALL CHECKS PASSED" : "CHECKS FAILED"}\n`);
process.exit(ok ? 0 : 1);
