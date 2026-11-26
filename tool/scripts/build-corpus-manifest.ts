import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { buildCorpusManifest } from "@/lib/leads/corpus-manifest";

async function main() {
  const corpusRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(process.cwd(), "..", "LLM_Papers");
  const outputDir = path.resolve(process.cwd(), "data");
  const outputPath = path.join(outputDir, "corpus-manifest.json");

  const manifest = await buildCorpusManifest(corpusRoot);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2));

  console.log(`Wrote corpus manifest to ${outputPath}`);
  console.log(`Corpus version: ${manifest.corpusVersion}`);
  console.log(`Paper count: ${manifest.paperCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
