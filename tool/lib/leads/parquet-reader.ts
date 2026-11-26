/**
 * Shared parquet-wasm + apache-arrow initialisation helper.
 *
 * Exported for reuse by lib/leads/flare-reader.ts.
 * The ESM parquet-wasm build requires an explicit WASM init step in Node.js;
 * this module handles that once and caches the result.
 */

let wasmReady: Promise<typeof import("parquet-wasm/esm/parquet_wasm.js")> | null = null;

export async function getParquetModule() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import("parquet-wasm/esm/parquet_wasm.js");

      try {
        const { readFileSync } = await import("fs");
        const { resolve } = await import("path");
        const wasmPath = resolve(
          process.cwd(),
          "node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm"
        );
        const wasmBytes = readFileSync(wasmPath);
        await mod.default(wasmBytes);
      } catch {
        try {
          await mod.default();
        } catch {
          // Already initialised
        }
      }

      return mod;
    })();
  }
  return wasmReady;
}
