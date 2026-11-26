// Section/paragraph-aware chunker
// target size ~= 220 words, no overlap

// Strip bibliography/references section - these pollute retrieval with citation noise
function stripBoilerplate(text: string): string {
  // 1. Cut at References/Bibliography section header
  //    Match both newline-delimited headers and inline occurrences where the
  //    document parser collapsed newlines (e.g., "…ecosystems. References Bastviken…")
  const refHeader = /\n\s*(?:References|Bibliography|Works Cited|Literature Cited|REFERENCES|BIBLIOGRAPHY)\s*\n/i;
  let refIdx = text.search(refHeader);

  // Fallback: match "References" appearing after sentence-ending punctuation
  // (handles artifact text where internal newlines were collapsed)
  if (refIdx < 0) {
    const inlineRef = /[.!?]\s+(?:References|Bibliography|Works Cited|Literature Cited|REFERENCES|BIBLIOGRAPHY)\s+[A-Z]/;
    const m = text.match(inlineRef);
    if (m && m.index !== undefined) {
      // Cut right after the sentence-ending punctuation, before "References"
      refIdx = m.index + 1; // keep the period, cut after it
    }
  }

  const trimmed = refIdx > 0 ? text.slice(0, refIdx) : text;

  // 2. Remove publisher download/access stamps
  // Line-by-line removal only for short lines (standalone stamp lines from raw pdf-parse).
  // Long lines (artifact text where stamps are fused into paragraph text) are kept intact
  // and cleaned with inline regex below.
  const lines = trimmed.split("\n").filter((line) => {
    if (line.length > 300) return true; // Keep long lines - stamp is a small part
    if (/downloaded from https?:\/\//i.test(line)) return false;
    if (/wiley online library|terms and conditions|creative commons/i.test(line)) return false;
    if (/^doi:\s*10\./i.test(line.trim())) return false;
    return true;
  });

  // Strip inline publisher stamps that were fused into paragraph text
  return lines.join("\n")
    .replace(/Downloaded from https?:\/\/\S+[^.]*\./gi, " ")
    .replace(/Wiley Online Library[^.]*\./gi, " ")
    .replace(/Terms and Conditions[^.]*\./gi, " ")
    .replace(/This article is protected by copyright[^.]*\./gi, " ")
    .replace(/[ ]{2,}/g, " ");
}

// Reject chunks that are boilerplate / not actual content
function isBoilerplateChunk(chunk: string): boolean {
  const lower = chunk.toLowerCase();

  // Author contribution blocks
  if (/writing[\s-]*review\s*&\s*editing:/i.test(chunk)) return true;
  if (/conceptualization:|formal analysis:|investigation:|methodology:/i.test(chunk)) return true;

  // Journal/publisher metadata - only reject short chunks that are mostly boilerplate.
  // Long content chunks may have publisher watermarks fused in by the document parser.
  if (/downloaded from https?:\/\//i.test(chunk) && chunk.length < 400) return true;
  if (/wiley online library/i.test(chunk) && chunk.length < 400) return true;
  if (/this article is protected by copyright/i.test(lower) && chunk.length < 400) return true;
  if (/open access|creative commons|cc by/i.test(lower) && chunk.length < 400) return true;

  // Reference list entries (dense with author-year patterns)
  const refPattern = /[A-Z][a-z]+,\s[A-Z]\.\s*[(&]/g;
  const refMatches = chunk.match(refPattern) ?? [];
  if (refMatches.length >= 4) return true; // 4+ author-year entries = reference list

  // Chunks that are mostly URLs or DOIs
  const urlCount = (chunk.match(/https?:\/\//g) ?? []).length;
  if (urlCount >= 3) return true;

  return false;
}

function normalizeParagraphs(text: string): string[] {
  const normalized = text
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");

  const blocks = normalized
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

  if (blocks.length > 1) return blocks;

  return normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

function isSectionHeading(block: string) {
  const trimmed = block.trim();
  if (!trimmed || trimmed.length > 90) return false;
  if (wordCount(trimmed) > 12) return false;
  if (/^(abstract|introduction|background|methods?|materials?|results?|discussion|conclusion|references|bibliography)$/i.test(trimmed)) {
    return true;
  }
  if (/^\d+(\.\d+)*\s+[A-Z]/.test(trimmed)) return true;
  if (/^[A-Z][A-Za-z0-9 ,:()/-]{0,80}$/.test(trimmed) && !/[.!?]$/.test(trimmed)) return true;
  return false;
}

export function chunkText(text: string, targetSize = 220, maxSize = 320): string[] {
  const cleaned = stripBoilerplate(text);
  const blocks = normalizeParagraphs(cleaned);

  const out: string[] = [];
  let currentHeading = "";
  let currentParts: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (currentParts.length === 0) return;
    const body = currentParts.join("\n\n").trim();
    const chunk = currentHeading ? `${currentHeading}\n\n${body}` : body;
    if (chunk.length > 80 && !isBoilerplateChunk(chunk)) {
      out.push(chunk);
    }
    currentParts = [];
    currentWords = 0;
  };

  for (const block of blocks) {
    if (isSectionHeading(block)) {
      flush();
      currentHeading = block;
      continue;
    }

    const blockWords = wordCount(block);

    // If a single block exceeds maxSize, split it by sentence boundaries
    if (blockWords > maxSize) {
      flush(); // flush any accumulated parts first
      const sentences = block.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [block];
      for (const sentence of sentences) {
        const sentWords = wordCount(sentence);
        if (currentParts.length > 0 && currentWords + sentWords > maxSize) {
          flush();
        }
        currentParts.push(sentence.trim());
        currentWords += sentWords;
        if (currentWords >= targetSize) {
          flush();
        }
      }
      continue;
    }

    if (currentParts.length > 0 && currentWords + blockWords > maxSize) {
      flush();
    }

    currentParts.push(block);
    currentWords += blockWords;

    if (currentWords >= targetSize) {
      flush();
    }
  }

  flush();

  return out.filter((chunk) => chunk.length > 80);
}
