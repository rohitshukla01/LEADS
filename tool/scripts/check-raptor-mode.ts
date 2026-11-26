/**
 * Summary-node mode gate (LEADS_RAPTOR_MODE, lib/leads/raptor-mode.ts).
 *
 *   npx tsx scripts/check-raptor-mode.ts
 *
 * Offline. The real Qdrant client in lib/qdrant.ts (and lib/qdrant-v2.ts) talks to an
 * in-process stand-in for the Qdrant REST API: globalThis.fetch is replaced, so the request
 * bodies inspected here are exactly what the client would send. Any request to another
 * URL fails the run, so nothing can leave the process.
 *
 * Asserts:
 *  1. Flag: unset, empty or unrecognised LEADS_RAPTOR_MODE reads as "off"; "legacy" as legacy.
 *  2. Legacy: the dense literature lane asks for 8 hits and returns exactly what the
 *     single-pool call search(vector, 8, filter) returns, summary nodes included.
 *  3. Off: it asks for 16 and returns only raptor_level 0 hits (missing counts as 0), at
 *     most 8, in Qdrant's order; with few verbatim hits it returns fewer and does not
 *     re-query. The contextual profile behaves the same against its own collection.
 *  4. Requests: no request body or URL ever mentions raptor_level; the only filter key
 *     sent is doc_id.
 *  5. Failure: a rejected (HTTP 400) or failed (network) dense call logs
 *     "[literature] dense search failed" and returns [] in both modes.
 *  6. Cache key: the query-cache key differs by mode, follows the flag when no mode is
 *     passed, and the legacy key carries no mode tag (pipeline tag and query only).
 */
import { readFileSync } from "fs";
import { join } from "path";

// In-process Qdrant stand-in
const MOCK_ORIGIN = "http://qdrant-check.invalid:6333";
process.env.QDRANT_URL = MOCK_ORIGIN;
delete process.env.QDRANT_API_KEY;
delete process.env.QDRANT_COLLECTION;
delete process.env.LEADS_RELAY_URL;

type Level = number | undefined;
interface FixturePoint {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

function makeFixture(prefix: string, levels: Level[]): FixturePoint[] {
  return levels.map((level, i) => {
    const payload: Record<string, unknown> = {
      doc_id: `doc-${prefix}`,
      doc_name: `${prefix}2020_Journal.pdf`,
      chunk_index: level ? 100 + i : i,
      page_num: level ? 0 : 1 + i,
      text: `${prefix} point ${i + 1}: dissolved oxygen and temperature in the hypolimnion of the reservoir.`,
    };
    if (level !== undefined) payload.raptor_level = level;
    return { id: `${prefix}-${String(i + 1).padStart(2, "0")}`, score: 0.9 - i * 0.01, payload };
  });
}

// Mixed pool: summary nodes (1-3) interleaved with verbatim chunks (0 or no field).
// The first 16 hold 10 verbatim hits, so "off" must stop at 8 (A-01 ... A-14).
const POOL_MIXED = makeFixture("A", [0, 1, 0, 2, undefined, 0, 3, 1, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
// Summary-heavy pool: only 3 verbatim hits in the first 16, and more after them.
const POOL_SPARSE = makeFixture("B", [1, 2, 0, 1, 1, 3, 2, 1, 0, 1, 2, 1, 1, 0, 2, 1, 0, 0, 0, 0]);

const VEC_MIXED = [1, 0, 0, 0];
const VEC_SPARSE = [2, 0, 0, 0];
const VEC_REJECTED = [3, 0, 0, 0];
const VEC_NETWORK = [4, 0, 0, 0];

interface Recorded {
  method: string;
  url: string;
  body: string;
}
const requests: Recorded[] = [];
const strayRequests: string[] = [];

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
  const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  if (!url.startsWith(MOCK_ORIGIN)) {
    strayRequests.push(`${method} ${url}`);
    throw new Error(`check-raptor-mode: unexpected request to ${url}`);
  }
  requests.push({ method, url, body });
  const path = new URL(url).pathname;

  if (method === "GET" && path === "/") return jsonResponse(200, { title: "qdrant", version: "1.17.0" });

  if (method === "POST" && /^\/collections\/[^/]+\/points\/search$/.test(path)) {
    const req = JSON.parse(body) as { vector: number[]; limit: number };
    const key = req.vector[0];
    if (key === VEC_REJECTED[0]) {
      return jsonResponse(400, {
        status: { error: 'Bad request: Index required but not found for "raptor_level"' },
        time: 0,
      });
    }
    if (key === VEC_NETWORK[0]) throw new TypeError("fetch failed");
    const pool = key === VEC_SPARSE[0] ? POOL_SPARSE : POOL_MIXED;
    // Like Qdrant: the top `limit` points by score, in score order.
    return jsonResponse(200, { result: pool.slice(0, req.limit), status: "ok", time: 0 });
  }

  return jsonResponse(404, { status: { error: `no route for ${method} ${path}` }, time: 0 });
}) as typeof fetch;

// Result bookkeeping
const failures: string[] = [];
let passed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}${detail ? `  ::  ${detail}` : ""}`);
  }
}

function searchRequests(since: number): Array<{ path: string; body: Record<string, unknown> }> {
  return requests
    .slice(since)
    .filter((r) => r.method === "POST" && r.url.includes("/points/search"))
    .map((r) => ({ path: new URL(r.url).pathname, body: JSON.parse(r.body) as Record<string, unknown> }));
}

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = original;
  }
}

const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);
const levelOf = (hit: { payload: unknown }) =>
  (hit.payload as { raptor_level?: unknown }).raptor_level ?? 0;

async function main(): Promise<void> {
  const { raptorMode, DENSE_LITERATURE_TOP_K, RAPTOR_OVERFETCH_K } = await import("../lib/leads/raptor-mode");
  const { denseLiteratureSearch } = await import("../lib/leads/literature");
  const { search } = await import("../lib/qdrant");
  const { buildCacheKey } = await import("../lib/leads/query-cache");

  // 1. Flag
  console.log("\n[flag] LEADS_RAPTOR_MODE");
  const flagCases: Array<[string | undefined, string]> = [
    [undefined, "off"],
    ["", "off"],
    ["  ", "off"],
    ["off", "off"],
    ["OFF", "off"],
    ["legacy", "legacy"],
    [" Legacy ", "legacy"],
    ["route", "off"],
  ];
  for (const [raw, want] of flagCases) {
    if (raw === undefined) delete process.env.LEADS_RAPTOR_MODE;
    else process.env.LEADS_RAPTOR_MODE = raw;
    const got = raptorMode();
    check(`${raw === undefined ? "unset" : JSON.stringify(raw)} -> ${want}`, got === want, `got ${got}`);
  }
  delete process.env.LEADS_RAPTOR_MODE;
  check(
    "constants: keep 8, over-fetch 16",
    DENSE_LITERATURE_TOP_K === 8 && RAPTOR_OVERFETCH_K === 16,
    `${DENSE_LITERATURE_TOP_K}/${RAPTOR_OVERFETCH_K}`
  );

  // 2. Legacy
  console.log("\n[legacy] single pool, unchanged");
  let mark = requests.length;
  const baseline = await search(VEC_MIXED, 8);
  const legacy = await denseLiteratureSearch(VEC_MIXED, { profile: "hybrid" }, "legacy");
  let reqs = searchRequests(mark);
  check("legacy result equals search(vector, 8)", JSON.stringify(legacy) === JSON.stringify(baseline));
  check(
    "legacy result is the top 8, summary nodes included",
    JSON.stringify(ids(legacy)) === JSON.stringify(ids(POOL_MIXED.slice(0, 8))) &&
      legacy.some((h) => levelOf(h) !== 0),
    ids(legacy).join(",")
  );
  check("legacy requests limit 8", reqs.length === 2 && reqs.every((r) => r.body.limit === 8), JSON.stringify(reqs.map((r) => r.body.limit)));

  mark = requests.length;
  const baselineDoc = await search(VEC_MIXED, 8, { doc_id: "doc-A" });
  const legacyDoc = await denseLiteratureSearch(VEC_MIXED, { docId: "doc-A" }, "legacy");
  reqs = searchRequests(mark);
  check("legacy with docId equals search(vector, 8, {doc_id})", JSON.stringify(legacyDoc) === JSON.stringify(baselineDoc));
  check(
    "legacy with docId sends the doc_id filter unchanged",
    JSON.stringify(reqs[1]?.body.filter) === JSON.stringify({ must: [{ key: "doc_id", match: { value: "doc-A" } }] }),
    JSON.stringify(reqs[1]?.body.filter)
  );

  // 3. Off
  console.log("\n[off] verbatim chunks only");
  mark = requests.length;
  const off = await denseLiteratureSearch(VEC_MIXED, { profile: "hybrid" }, "off");
  reqs = searchRequests(mark);
  const wantOff = POOL_MIXED.slice(0, 16).filter((p) => (p.payload.raptor_level ?? 0) === 0).slice(0, 8);
  check("off requests limit 16", reqs.length === 1 && reqs[0].body.limit === 16, JSON.stringify(reqs.map((r) => r.body.limit)));
  check("off keeps only raptor_level 0 (missing counts as 0)", off.every((h) => levelOf(h) === 0), ids(off).join(","));
  check(
    "off returns the first 8 verbatim hits in Qdrant's order",
    JSON.stringify(ids(off)) === JSON.stringify(ids(wantOff)) && off.length === 8,
    `got ${ids(off).join(",")} want ${ids(wantOff).join(",")}`
  );
  check("off keeps the hit without a raptor_level field", ids(off).includes("A-05"));
  const top16 = await search(VEC_MIXED, 16);
  check(
    "off hits are the client's objects unchanged (score and payload as returned)",
    JSON.stringify(off) === JSON.stringify(top16.filter((h) => levelOf(h) === 0).slice(0, 8))
  );

  mark = requests.length;
  const offSparse = await denseLiteratureSearch(VEC_SPARSE, undefined, "off");
  reqs = searchRequests(mark);
  check(
    "off with few verbatim hits returns only those (no re-query)",
    JSON.stringify(ids(offSparse)) === JSON.stringify(["B-03", "B-09", "B-14"]) && reqs.length === 1,
    `got ${ids(offSparse).join(",")} after ${reqs.length} request(s)`
  );

  mark = requests.length;
  const offDoc = await denseLiteratureSearch(VEC_MIXED, { docId: "doc-A" }, "off");
  reqs = searchRequests(mark);
  check(
    "off with docId sends only the doc_id filter",
    JSON.stringify(reqs[0]?.body.filter) === JSON.stringify({ must: [{ key: "doc_id", match: { value: "doc-A" } }] }) &&
      JSON.stringify(ids(offDoc)) === JSON.stringify(ids(wantOff)),
    JSON.stringify(reqs[0]?.body.filter)
  );

  mark = requests.length;
  const offContextual = await denseLiteratureSearch(VEC_MIXED, { profile: "contextual" }, "off");
  reqs = searchRequests(mark);
  check(
    "contextual profile: same rule against its own collection",
    reqs.length === 1 &&
      reqs[0].path === "/collections/leads_docs_v2/points/search" &&
      reqs[0].body.limit === 16 &&
      JSON.stringify(ids(offContextual)) === JSON.stringify(ids(wantOff)),
    `${reqs[0]?.path} limit=${reqs[0]?.body.limit}`
  );

  delete process.env.LEADS_RAPTOR_MODE;
  mark = requests.length;
  const offDefault = await denseLiteratureSearch(VEC_MIXED);
  reqs = searchRequests(mark);
  check(
    "flag unset: the default mode is off",
    reqs[0]?.body.limit === 16 && JSON.stringify(ids(offDefault)) === JSON.stringify(ids(wantOff))
  );
  process.env.LEADS_RAPTOR_MODE = "legacy";
  mark = requests.length;
  const legacyFromEnv = await denseLiteratureSearch(VEC_MIXED);
  reqs = searchRequests(mark);
  check(
    "flag legacy: the default mode follows the variable",
    reqs[0]?.body.limit === 8 && JSON.stringify(legacyFromEnv) === JSON.stringify(baseline)
  );
  delete process.env.LEADS_RAPTOR_MODE;

  // 5. Failure (before the request audit, so the failing calls are audited too)
  console.log("\n[failure] dense call rejected or unreachable");
  for (const mode of ["off", "legacy"] as const) {
    for (const [label, vector] of [
      ["HTTP 400", VEC_REJECTED],
      ["network error", VEC_NETWORK],
    ] as const) {
      const { value, logged } = await captureErrors(() => denseLiteratureSearch(vector, undefined, mode));
      check(
        `${mode}: ${label} logs and returns []`,
        Array.isArray(value) && value.length === 0 && logged.some((l) => l.includes("[literature] dense search failed")),
        `returned ${JSON.stringify(value)}; logged ${JSON.stringify(logged)}`
      );
    }
  }

  // 4. Requests
  console.log("\n[requests] what was sent to Qdrant");
  const searches = requests.filter((r) => r.url.includes("/points/search"));
  check(`${searches.length} search requests recorded`, searches.length >= 12, String(searches.length));
  check(
    "no request body or URL mentions raptor_level",
    requests.every((r) => !r.body.includes("raptor_level") && !r.url.includes("raptor_level"))
  );
  const filterKeys = new Set<string>();
  for (const r of searches) {
    const filter = (JSON.parse(r.body) as { filter?: { must?: Array<{ key?: string }> } }).filter;
    for (const cond of filter?.must ?? []) filterKeys.add(String(cond.key));
  }
  check("the only filter key sent is doc_id", [...filterKeys].every((k) => k === "doc_id"), [...filterKeys].join(","));
  check("no request left the process", strayRequests.length === 0, strayRequests.join("; "));

  // 6. Cache key
  console.log("\n[cache] query-cache key");
  const q = "What drives hypolimnetic oxygen depletion in Falling Creek Reservoir?";
  const lit = ["literature"];
  const mixed = ["sensor", "literature"];
  check("off and legacy keys differ (literature)", buildCacheKey(q, lit, "off") !== buildCacheKey(q, lit, "legacy"));
  check("off and legacy keys differ (sensor + literature)", buildCacheKey(q, mixed, "off") !== buildCacheKey(q, mixed, "legacy"));
  check("keys are stable for the same mode", buildCacheKey(q, lit, "off") === buildCacheKey(q, lit, "off"));
  delete process.env.LEADS_RAPTOR_MODE;
  check("flag unset: key equals the off key", buildCacheKey(q, lit) === buildCacheKey(q, lit, "off"));
  process.env.LEADS_RAPTOR_MODE = "legacy";
  check("flag legacy: key equals the legacy key", buildCacheKey(q, lit) === buildCacheKey(q, lit, "legacy"));
  delete process.env.LEADS_RAPTOR_MODE;

  // The legacy key carries no mode tag: it hashes only the pipeline tag (read from the
  // source) and the normalised query. Recompute it independently of buildCacheKey.
  const cacheSrc = readFileSync(join(__dirname, "..", "lib", "leads", "query-cache.ts"), "utf8");
  const tag = /const CACHE_PIPELINE_TAG = "([^"]+)"/.exec(cacheSrc)?.[1];
  const djb2 = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(36);
  };
  const norm = q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const previousFormat = `leads:qcache:${djb2(`${tag}|${norm}`)}`;
  // LEADS_LIT_VERBATIM and LEADS_CITATION_ALIGN "off" add nothing to the key either
  // (lit-verbatim.ts, citation-align.ts).
  check(
    "legacy key carries no mode tag",
    Boolean(tag) && buildCacheKey(q, lit, "legacy", "off", "off") === previousFormat,
    `tag=${tag} legacy=${buildCacheKey(q, lit, "legacy", "off", "off")} previous=${previousFormat}`
  );
}

main()
  .catch((err) => {
    failures.push(`uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    console.error(err);
  })
  .finally(() => {
    const ok = failures.length === 0;
    console.log(`\n[raptor-mode] ${passed} passed, ${failures.length} failed`);
    console.log(`\n${ok ? "ALL CHECKS PASSED" : "CHECKS FAILED"}\n`);
    process.exit(ok ? 0 : 1);
  });
