import { createHash } from "crypto";
import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

import { extractPDF, extractPDFHybrid, cleanPDFText } from "@/lib/pdf";

const execFileAsync = promisify(execFile);

const TIKA_URL = process.env.TIKA_URL ?? "http://localhost:9998";
// Cache schema version. A bump invalidates all cached artifacts so a re-ingest
// re-parses every document.
const NORMALIZED_ARTIFACT_VERSION = 4;
const NORMALIZED_ARTIFACT_DIR = path.resolve(process.cwd(), "data", "normalized-artifacts");

const TIKA_EXTENSIONS = new Set([
  ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".html", ".htm", ".rtf", ".epub", ".odt", ".ods", ".odp",
  ".csv", ".tsv", ".xml", ".json", ".md", ".markdown",
]);

export type SupportedFileKind = "pdf" | "txt" | "tika";
export type ParserEngine = "pdf-parse" | "docling" | "docling-ocr" | "pdf-hybrid" | "txt" | "tika";

// PDF parser order. "pdf-parse-first" (default) is the fast path (pdf-parse primary,
// Docling only as a quality fallback). "docling-first" makes Docling the primary parser
// (structure-aware, better chunks) with pdf-parse as the safety fallback; npm run
// ingest-corpus uses it unless --pdf-engine=pdf-parse-first is given.
export type PdfEngine = "pdf-parse-first" | "docling-first";

function resolvePdfEngine(opt?: PdfEngine): PdfEngine {
  return opt ?? "pdf-parse-first";
}

export interface NormalizedArtifactBlock {
  id: string;
  type: "heading" | "paragraph" | "table" | "caption" | "other";
  page: number;
  text: string;
}

export interface NormalizedDocumentArtifact {
  schemaVersion: number;
  cacheKey: string;
  sourceSha256: string;
  fileName: string;
  extension: string;
  kind: SupportedFileKind;
  parser: ParserEngine;
  pages: number;
  text: string;
  blocks: NormalizedArtifactBlock[];
  generatedAt: string;
}

export interface ParsedDocument {
  text: string;
  pages: number;
  kind: SupportedFileKind;
  extension: string;
  parser: ParserEngine;
  artifactPath: string;
  blocks: NormalizedArtifactBlock[];
}

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function normalizeWhitespace(text: string) {
  return cleanPDFText(text).replace(/\r/g, "\n").trim();
}

function splitParagraphs(text: string) {
  return normalizeWhitespace(text)
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

const SPLIT_ARTIFACT_RE =
  /\b(?:per formance|contri but|Never theless|syn thesize|underst and|consi dered|trans fer|oper ating|man agement|heatmitigation|athttps|moreclosely|withthe|drawdownsacross|resultsat)\b/gi;

function looksLikeHeading(block: string) {
  if (!block || block.length > 100) return false;
  const words = block.split(/\s+/).filter(Boolean).length;
  if (words > 14) return false;
  if (/^(abstract|introduction|background|methods?|materials?|results?|discussion|conclusion|references|bibliography)$/i.test(block)) {
    return true;
  }
  if (/^\d+(\.\d+)*\s+[A-Z]/.test(block)) return true;
  if (/^[A-Z][A-Za-z0-9 ,:()/-]{0,90}$/.test(block) && !/[.!?]$/.test(block)) return true;
  return false;
}

function paragraphBlocks(text: string, page = 1): NormalizedArtifactBlock[] {
  return splitParagraphs(text).map((block, index) => ({
    id: `block-${index}`,
    type: looksLikeHeading(block) ? "heading" : "paragraph",
    page,
    text: block,
  }));
}

function blocksToText(blocks: NormalizedArtifactBlock[]) {
  return blocks
    .map((block) => (block.type === "heading" ? `${block.text}\n` : block.text))
    .join("\n\n")
    .trim();
}

function textLooksPoor(text: string, bufferSize: number) {
  const normalized = normalizeWhitespace(text);
  const longRuns = normalized.match(/[A-Za-z]{24,}/g) ?? [];
  const splitArtifacts = normalized.match(SPLIT_ARTIFACT_RE) ?? [];
  const fusedMarkerCount =
    (normalized.match(/[a-z]{8,}[A-Z][a-z]{3,}/g) ?? []).length +
    (normalized.match(/(?:[a-z]{4,})(?:and|with|that|from|into|over)(?:[a-z]{4,})/g) ?? []).length;
  // Length-scaled artifact caps: a handful of typesetting artifacts (split/glued words
  // from hyphenation, ligatures, or justified text) in a long paper is noise, not a broken
  // parse. Allow ~1 artifact per 3000 chars, with fixed absolute counts as a floor for
  // short docs. The low-yield guard (< 0.3% of file bytes) catches image-only/empty PDFs,
  // whose failure mode is ~zero usable text, not artifact density.
  const cap = normalized.length / 3000;
  return (
    normalized.length < bufferSize * 0.003 ||
    longRuns.length > Math.max(4, cap) ||
    fusedMarkerCount > Math.max(4, cap) ||
    splitArtifacts.length > Math.max(3, cap)
  );
}

function qualityPenalty(text: string) {
  const normalized = normalizeWhitespace(text);
  const longRuns = normalized.match(/[A-Za-z]{24,}/g) ?? [];
  const splitArtifacts = normalized.match(SPLIT_ARTIFACT_RE) ?? [];
  const fusedMarkerCount =
    (normalized.match(/[a-z]{8,}[A-Z][a-z]{3,}/g) ?? []).length +
    (normalized.match(/(?:[a-z]{4,})(?:and|with|that|from|into|over)(?:[a-z]{4,})/g) ?? []).length;
  const veryShortPenalty = normalized.length < 2000 ? 25 : 0;
  return longRuns.length * 3 + splitArtifacts.length * 5 + fusedMarkerCount * 4 + veryShortPenalty;
}

async function ensureArtifactDirectory() {
  await mkdir(NORMALIZED_ARTIFACT_DIR, { recursive: true });
}

function artifactCacheKey(buffer: Buffer, fileName: string, profile: string) {
  const sha = createHash("sha256").update(buffer).digest("hex");
  const name = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return {
    sha,
    key: `${sha.slice(0, 16)}-${profile}-${name}.json`,
  };
}

function artifactPathFromKey(key: string) {
  return path.join(NORMALIZED_ARTIFACT_DIR, key);
}

async function readArtifact(cachePath: string): Promise<NormalizedDocumentArtifact | null> {
  try {
    const contents = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(contents) as NormalizedDocumentArtifact;
    return parsed.schemaVersion === NORMALIZED_ARTIFACT_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

async function writeArtifact(cachePath: string, artifact: NormalizedDocumentArtifact) {
  await ensureArtifactDirectory();
  await writeFile(cachePath, JSON.stringify(artifact, null, 2));
}

async function extractWithTika(buffer: Buffer): Promise<string | null> {
  try {
    const res = await fetch(`${TIKA_URL}/tika`, {
      method: "PUT",
      headers: { Accept: "text/plain" },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function pageFromDoclingItem(item: Record<string, unknown>): number {
  if (typeof item.page_no === "number") return item.page_no;
  if (typeof item.page === "number") return item.page;

  const prov = item.prov;
  if (Array.isArray(prov)) {
    for (const candidate of prov) {
      if (candidate && typeof candidate === "object") {
        const record = candidate as Record<string, unknown>;
        if (typeof record.page_no === "number") return record.page_no;
        if (typeof record.page === "number") return record.page;
        if (typeof record.page_idx === "number") return record.page_idx + 1;
      }
    }
  }
  return 1;
}

function typeFromDoclingItem(item: Record<string, unknown>): NormalizedArtifactBlock["type"] {
  const raw = String(item.type ?? item.label ?? "paragraph").toLowerCase();
  if (
    raw.includes("title") ||
    raw.includes("heading") ||
    raw.includes("subtitle") ||
    raw.includes("section_header") ||
    raw.includes("page_header")
  ) {
    return "heading";
  }
  if (raw.includes("table")) return "table";
  if (raw.includes("caption")) return "caption";
  if (raw.includes("paragraph") || raw.includes("text")) return "paragraph";
  return "other";
}

function doclingBlocks(payload: Record<string, unknown>): NormalizedArtifactBlock[] {
  const collections = [payload.texts, payload.furniture, payload.body];
  const blocks: NormalizedArtifactBlock[] = [];

  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const text = normalizeWhitespace(String(record.text ?? ""));
      if (!text) continue;
      blocks.push({
        id: String(record.self_ref ?? `docling-${blocks.length}`),
        type: typeFromDoclingItem(record),
        page: pageFromDoclingItem(record),
        text,
      });
    }
  }

  return blocks;
}

async function runDoclingCli(inputPath: string, outputDir: string, opts?: { ocr?: boolean }) {
  // OCR off by default (fast, deterministic). When ocr is requested, --no-ocr is
  // omitted so Docling auto-OCRs bitmap pages: the rescue path for image-only or
  // rasterized PDFs. OCR is much slower and may download OCR models on first use,
  // so the caller gates it tightly.
  const ocrFlag = opts?.ocr ? [] : ["--no-ocr"];
  const tailArgs = ["--to", "json", "--output", outputDir, "--image-export-mode", "placeholder", ...ocrFlag, "--device", "cpu"];
  const commands: Array<[string, string[]]> = [
    ["docling", [inputPath, ...tailArgs]],
    ["docling", ["convert", inputPath, ...tailArgs]],
  ];
  const timeout = opts?.ocr ? 600000 : 120000;

  for (const [command, args] of commands) {
    try {
      await execFileAsync(command, args, { timeout });
      return true;
    } catch (error) {
      const details = error as NodeJS.ErrnoException;
      if (details.code === "ENOENT") continue;
    }
  }
  return false;
}

async function parseWithDocling(
  buffer: Buffer,
  fileName: string,
  extension: string,
  cacheKey: string,
  sourceSha256: string,
  opts?: { ocr?: boolean }
): Promise<NormalizedDocumentArtifact | null> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "leads-docling-"));
  const inputPath = path.join(tmpRoot, path.basename(fileName));
  const outputDir = path.join(tmpRoot, "out");

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(inputPath, buffer);
    const ran = await runDoclingCli(inputPath, outputDir, opts);
    if (!ran) return null;

    const expectedJson = path.join(outputDir, `${path.parse(fileName).name}.json`);
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(await readFile(expectedJson, "utf-8")) as Record<string, unknown>;
    } catch {
      const dirEntries = await readdir(outputDir);
      const jsonName = dirEntries.find((name) => name.endsWith(".json"));
      if (!jsonName) return null;
      payload = JSON.parse(await readFile(path.join(outputDir, jsonName), "utf-8")) as Record<string, unknown>;
    }

    if (!payload) return null;

    const blocks = doclingBlocks(payload);
    // Page count: Docling 2.x stores the top-level `pages` as a dict keyed by page
    // number (not an array), so derive the count from the largest valid signal: max
    // block page (from prov), the pages dict/array size, or the metadata count.
    const maxBlockPage = blocks.reduce((max, block) => Math.max(max, block.page || 1), 1);
    const pagesField = payload.pages;
    const pagesFromField = Array.isArray(pagesField)
      ? pagesField.length
      : pagesField && typeof pagesField === "object"
      ? Object.keys(pagesField as Record<string, unknown>).length
      : typeof (payload.metadata as Record<string, unknown> | undefined)?.pages === "number"
      ? Number((payload.metadata as Record<string, unknown>).pages)
      : 0;
    const pages = Math.max(maxBlockPage, pagesFromField, 1);
    const text = blocksToText(blocks);
    if (!text) return null;

    return {
      schemaVersion: NORMALIZED_ARTIFACT_VERSION,
      cacheKey,
      sourceSha256,
      fileName,
      extension,
      kind: "pdf",
      parser: opts?.ocr ? "docling-ocr" : "docling",
      pages,
      text,
      blocks,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function artifactFromText(params: {
  cacheKey: string;
  sourceSha256: string;
  fileName: string;
  extension: string;
  kind: SupportedFileKind;
  parser: ParserEngine;
  text: string;
  pages: number;
}): NormalizedDocumentArtifact {
  const blocks = paragraphBlocks(params.text);
  return {
    schemaVersion: NORMALIZED_ARTIFACT_VERSION,
    cacheKey: params.cacheKey,
    sourceSha256: params.sourceSha256,
    fileName: params.fileName,
    extension: params.extension,
    kind: params.kind,
    parser: params.parser,
    pages: params.pages,
    text: blocksToText(blocks),
    blocks,
    generatedAt: new Date().toISOString(),
  };
}

// Resolve the parsed-PDF artifact according to the selected engine. Both branches
// always have a working fallback so ingestion never hard-fails on a missing Docling
// binary or a low-yield parse.
async function parsePdf(
  buffer: Buffer,
  fileName: string,
  extension: string,
  cacheRef: { key: string; sha: string },
  fastPdf: boolean,
  engine: PdfEngine
): Promise<NormalizedDocumentArtifact> {
  const pdfParseArtifact = async () => {
    const primary = await extractPDF(buffer);
    return artifactFromText({
      cacheKey: cacheRef.key,
      sourceSha256: cacheRef.sha,
      fileName,
      extension,
      kind: "pdf",
      parser: "pdf-parse",
      text: primary.text,
      pages: primary.pages,
    });
  };

  if (engine === "docling-first") {
    // 1) Docling (no-OCR) as the primary, structure-aware parser.
    const docling = await parseWithDocling(buffer, fileName, extension, cacheRef.key, cacheRef.sha);
    if (docling && !textLooksPoor(docling.text, buffer.length)) {
      return { ...docling, sourceSha256: cacheRef.sha };
    }

    // 2) Fall back to pdf-parse (Docling missing/failed or low-yield). Keep whichever
    //    captured more text so a partial Docling run is never a regression.
    let best = await pdfParseArtifact();
    if (docling && docling.text.length > best.text.length) {
      best = { ...docling, sourceSha256: cacheRef.sha };
    }

    // 3) Image-only/rasterized rescue: only if still poor and explicitly enabled.
    if (textLooksPoor(best.text, buffer.length) && process.env.LEADS_DOCLING_OCR === "1") {
      const ocr = await parseWithDocling(buffer, fileName, extension, cacheRef.key, cacheRef.sha, { ocr: true });
      if (ocr && ocr.text.length > best.text.length) {
        best = { ...ocr, sourceSha256: cacheRef.sha };
      }
    }

    if (best.parser === "pdf-parse") {
      console.warn(
        `[parser] docling-first fell back to pdf-parse for ${fileName} ` +
          `(docling unavailable or low-yield; usable chars=${best.text.length})`
      );
    }
    return best;
  }

  // engine === "pdf-parse-first" - fast path.
  const primaryArtifact = await pdfParseArtifact();
  let artifact = primaryArtifact;

  if (textLooksPoor(primaryArtifact.text, buffer.length)) {
    const doclingArtifact = await parseWithDocling(buffer, fileName, extension, cacheRef.key, cacheRef.sha);
    if (
      doclingArtifact &&
      doclingArtifact.text.length >= primaryArtifact.text.length * 0.55 &&
      qualityPenalty(doclingArtifact.text) + 2 < qualityPenalty(primaryArtifact.text)
    ) {
      artifact = { ...doclingArtifact, sourceSha256: cacheRef.sha };
    } else if (!fastPdf) {
      const hybrid = await extractPDFHybrid(buffer);
      const hybridArtifact = artifactFromText({
        cacheKey: cacheRef.key,
        sourceSha256: cacheRef.sha,
        fileName,
        extension,
        kind: "pdf",
        parser: "pdf-hybrid",
        text: hybrid.text,
        pages: hybrid.pages,
      });
      if (hybridArtifact.text.length > artifact.text.length) {
        artifact = hybridArtifact;
      }
    }
  }
  return artifact;
}

export async function parseDocumentArtifact(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
  options?: { fastPdf?: boolean; pdfEngine?: PdfEngine }
): Promise<ParsedDocument> {
  const extension = getFileExtension(fileName);
  const isPDF = mimeType === "application/pdf" || extension === ".pdf";
  const isTxt = mimeType === "text/plain" || extension === ".txt";
  const isTikaSupported = TIKA_EXTENSIONS.has(extension);

  if (!isPDF && !isTxt && !isTikaSupported) {
    throw new Error(
      `Unsupported file type: ${extension || mimeType || "unknown"}. Supported: PDF, TXT, DOCX, PPTX, XLSX, HTML, RTF, EPUB, and more.`
    );
  }

  const pdfEngine = resolvePdfEngine(options?.pdfEngine);
  // docling-first uses its own profile (and ignores fastPdf) so its artifacts never
  // collide with pdf-parse caches and the fast+full callers share one Docling run.
  const profile = isPDF
    ? pdfEngine === "docling-first"
      ? "pdf-doclingfirst-v1"
      : options?.fastPdf
      ? "pdf-fast-v1"
      : "pdf-full-v1"
    : isTxt
    ? "txt-v1"
    : "tika-v1";
  const cacheRef = artifactCacheKey(buffer, fileName, profile);
  const cachePath = artifactPathFromKey(cacheRef.key);
  const cached = await readArtifact(cachePath);

  if (cached) {
    return {
      text: cached.text,
      pages: cached.pages,
      kind: cached.kind,
      extension: cached.extension,
      parser: cached.parser,
      artifactPath: cachePath,
      blocks: cached.blocks,
    };
  }

  let artifact: NormalizedDocumentArtifact;

  if (isPDF) {
    artifact = await parsePdf(buffer, fileName, extension, cacheRef, options?.fastPdf ?? false, pdfEngine);
  } else if (isTxt) {
    artifact = artifactFromText({
      cacheKey: cacheRef.key,
      sourceSha256: cacheRef.sha,
      fileName,
      extension,
      kind: "txt",
      parser: "txt",
      text: buffer.toString("utf-8"),
      pages: 1,
    });
  } else {
    const tikaText = await extractWithTika(buffer);
    if (!tikaText || tikaText.length === 0) {
      throw new Error(`Could not extract text. Ensure Tika is at ${TIKA_URL}`);
    }
    artifact = artifactFromText({
      cacheKey: cacheRef.key,
      sourceSha256: cacheRef.sha,
      fileName,
      extension,
      kind: "tika",
      parser: "tika",
      text: tikaText,
      pages: 1,
    });
  }

  await writeArtifact(cachePath, artifact);

  return {
    text: artifact.text,
    pages: artifact.pages,
    kind: artifact.kind,
    extension: artifact.extension,
    parser: artifact.parser,
    artifactPath: cachePath,
    blocks: artifact.blocks,
  };
}
