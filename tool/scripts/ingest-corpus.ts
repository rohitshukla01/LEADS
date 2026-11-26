import "./load-env";
import { readFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";

import { buildCorpusManifest } from "@/lib/leads/corpus-manifest";
import { deleteDocumentArtifacts, listIndexedDocuments } from "@/lib/document-artifacts";
import { ingestContextualV2Document, ingestPrimaryDocument } from "@/lib/ingest-core";
import type { PdfEngine } from "@/lib/document-parser";
import { hasV2Index } from "@/lib/qdrant-v2";

function parseArgs(argv: string[]) {
  const args = new Set(argv);
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const matchArg = argv.find((arg) => arg.startsWith("--match="));
  const sleepArg = argv.find((arg) => arg.startsWith("--sleep-ms="));
  const engineArg = argv.find((arg) => arg.startsWith("--pdf-engine="));

  // The curated corpus defaults to docling-first (structure-aware, better chunks).
  // Override with `--pdf-engine=pdf-parse-first` to use the fast path.
  const engineRaw = engineArg ? engineArg.split("=")[1] : "docling-first";
  const pdfEngine: PdfEngine = engineRaw === "pdf-parse-first" ? "pdf-parse-first" : "docling-first";

  return {
    force: args.has("--force"),
    // The v2 (contextual) index is built only with --with-v2; the query route reads
    // v1 (profile "hybrid": leads_docs + bm25).
    skipV2: !args.has("--with-v2"),
    repairPartial: args.has("--repair-partial"),
    limit: limitArg ? Number(limitArg.split("=")[1]) : undefined,
    match: matchArg ? matchArg.split("=").slice(1).join("=") : undefined,
    sleepMs: sleepArg ? Number(sleepArg.split("=")[1]) : 0,
    pdfEngine,
  };
}

async function loadManifest(root: string) {
  return buildCorpusManifest(root);
}

async function sleep(ms: number) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function main() {
  const corpusRoot = path.resolve(process.cwd(), "..", "LLM_Papers");
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(corpusRoot);
  const indexed = await listIndexedDocuments();
  const indexedByName = new Map(indexed.map((doc) => [doc.name, doc]));

  const candidates = manifest.entries
    .filter((entry) => /\.(pdf|txt|docx?|pptx?|xlsx?|html?|rtf|epub|odt|ods|odp|csv|tsv|xml|json|md|markdown)$/i.test(entry.name))
    .filter((entry) => (options.match ? entry.name.toLowerCase().includes(options.match.toLowerCase()) : true))
    .slice(0, options.limit ?? manifest.entries.length);

  console.log(`Corpus version: ${manifest.corpusVersion}`);
  console.log(`PDF engine: ${options.pdfEngine}`);
  console.log(`Scanning ${candidates.length} files from ${manifest.root}`);

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of candidates) {
    const existing = indexedByName.get(entry.name);
    let shouldRepairPartial = false;

    if (existing && options.repairPartial && !options.skipV2) {
      shouldRepairPartial = !(await hasV2Index(existing.id));
    }

    if (existing && !options.force && !shouldRepairPartial) {
      console.log(`skip  ${entry.name} (already indexed as ${existing.id})`);
      skipped += 1;
      continue;
    }

    try {
      if (existing && (options.force || shouldRepairPartial)) {
        console.log(`${shouldRepairPartial ? "repair" : "reset"} ${entry.name} (${existing.id})`);
        await deleteDocumentArtifacts(existing.id);
      }

      const absolutePath = path.join(manifest.root, entry.relativePath);
      const buffer = await readFile(absolutePath);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const mimeType = entry.name.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : entry.name.toLowerCase().endsWith(".txt")
        ? "text/plain"
        : undefined;
      const metadata = {
        ingestSource: "corpus" as const,
        corpusVersion: manifest.corpusVersion,
        corpusRelativePath: entry.relativePath,
        corpusSha256: sha256,
      };

      console.log(`ingest ${entry.name}`);
      const primary = await ingestPrimaryDocument({
        buffer,
        fileName: entry.name,
        mimeType,
        enrichMode: "await",
        metadata,
        pdfEngine: options.pdfEngine,
      });

      if (!options.skipV2) {
        await ingestContextualV2Document({
          buffer,
          fileName: entry.name,
          mimeType,
          docId: primary.docId,
          pdfEngine: options.pdfEngine,
          metadata,
        });
      }

      ingested += 1;
      console.log(
        `done  ${entry.name} -> ${primary.docId} (${primary.chunkCount} chunks${options.skipV2 ? "" : ", v2 ready"})`
      );
    } catch (error) {
      failed += 1;
      console.error(`fail  ${entry.name}:`, error instanceof Error ? error.message : error);
    }

    await sleep(options.sleepMs);
  }

  console.log("");
  console.log(`Summary: ingested=${ingested} skipped=${skipped} failed=${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
