// Guard for the auth gate: only the sign-in pages and the health probe are public; the LEADS tool and its APIs are not.
// Paths are normalised the way the proxy sees them (WHATWG URL parsing), so traversal tricks are covered.
import { isPublicPath } from "../lib/public-paths";

const norm = (p: string) => new URL(p, "https://leads.example").pathname;
let failed = 0;
function expect(path: string, isPublic: boolean) {
  const got = isPublicPath(norm(path));
  const ok = got === isPublic;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${path} -> ${got ? "public" : "signed-in only"}`);
}

// public
for (const p of ["/login", "/welcome", "/api/health"]) expect(p, true);
// must stay behind sign-in
for (const p of [
  "/", "/api/query", "/api/documents", "/api/forecast", "/api/forecast/members", "/api/sensors", "/api/unknown-route",
  "/loginx", "/login/../api/query", "/auth/..%2fapi%2fquery", "/auth/%2e%2e/api/query",
]) expect(p, false);

if (failed) { console.error(`\n${failed} public-path check(s) failed`); process.exit(1); }
console.log("\npublic paths: sign-in pages open, tool and APIs signed-in only");
