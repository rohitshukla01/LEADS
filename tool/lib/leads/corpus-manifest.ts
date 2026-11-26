import { readdir, stat } from "fs/promises";
import type { Dirent } from "fs";
import path from "path";

export interface CorpusManifestEntry {
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  source: "curated";
}

export interface CorpusManifest {
  generatedAt: string;
  corpusVersion: string;
  root: string;
  paperCount: number;
  entries: CorpusManifestEntry[];
}

async function listFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // Corpus dir absent/unreadable (e.g. the source PDFs are not present in this
    // environment). Fail soft: return no files so the manifest is empty rather
    // than throwing and failing the whole snapshot.
    return [];
  }
  const out: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(absolute)));
      continue;
    }
    out.push(absolute);
  }

  return out;
}

export async function buildCorpusManifest(root: string): Promise<CorpusManifest> {
  const files = (await listFiles(root)).filter((file) => /\.(pdf|docx?|txt|html?)$/i.test(file));
  const entries: CorpusManifestEntry[] = [];

  for (const file of files) {
    const metadata = await stat(file);
    entries.push({
      name: path.basename(file),
      relativePath: path.relative(root, file),
      sizeBytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      source: "curated",
    });
  }

  const corpusVersion = `curated-${new Date().toISOString().slice(0, 10)}`;

  return {
    generatedAt: new Date().toISOString(),
    corpusVersion,
    root,
    paperCount: entries.length,
    entries: entries.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
