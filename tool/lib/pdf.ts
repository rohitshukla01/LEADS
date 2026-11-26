// Server-side only - never import in client components
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (
  buf: Buffer
) => Promise<{ text: string; numpages: number }>;

export interface PDFResult {
  text: string;
  pages: number;
}

export async function extractPDF(buffer: Buffer): Promise<PDFResult> {
  const data = await pdfParse(buffer);
  return {
    text: cleanPDFText(data.text),
    pages: data.numpages,
  };
}

// Fallback extraction used when the primary parse looks poor: text of poor quality is
// returned as extracted, otherwise it is cleaned once more.
export async function extractPDFHybrid(buffer: Buffer): Promise<PDFResult> {
  const parsed = await extractPDF(buffer);
  const poorTextQuality = parsed.text.length < buffer.length * 0.003;
  return poorTextQuality ? parsed : { text: cleanPDFText(parsed.text), pages: parsed.pages };
}

// Common English function words used as split hints within fused lowercase runs
// Ordered longest-first so multi-char words match before their prefixes
const SPLIT_WORDS = [
  "between", "through", "during", "because", "therefore", "however", "although",
  "within", "without", "against", "toward", "around", "across", "along",
  "whether", "results", "shows", "showing", "indicate", "analysis", "change",
  "changes", "model", "models", "these", "those", "their", "there", "which",
  "while", "where", "when", "that", "this", "with", "from", "into", "onto",
  "over", "under", "upon", "after", "before", "about", "above", "below",
  "have", "been", "were", "they", "them", "then", "than", "also", "both",
  "each", "some", "most", "more", "less", "very", "such", "other",
  "and", "not", "but", "for", "are", "was", "has", "had", "its", "the",
].sort((a, b) => b.length - a.length);

// Build a single alternation regex from the word list
const SPLIT_RE = new RegExp(`(?<=[a-z]{3})(${SPLIT_WORDS.join("|")})(?=[a-z]{2})`, "g");

// Fix common pdf-parse artifacts: fused words, hyphenation, excess whitespace
export function cleanPDFText(raw: string): string {
  return raw
    // Re-join hyphenated line breaks: "phyto-\nplankton" -> "phytoplankton"
    .replace(/-\n(\S)/g, "$1")
    // CamelCase -> spaced: "MachineLearning" -> "Machine Learning"
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Letter-digit boundaries: split genuinely fused tokens ("IPSL1" -> "IPSL 1",
    // "Figure3" -> "Figure 3", "10W" -> "10 W") without breaking chemical formulas
    // and units:
    //   - letter-to-digit only after a 3+ letter run (preserves O2/CO2/CH4/NH4/N2/SO4/L1)
    //   - digit-to-letter only when the digit is not preceded by a letter (preserves
    //     H2O/H2S/N2O formula digits, still splits 9m / 10W / 35days)
    .replace(/([a-zA-Z]{3,})(\d)/g, "$1 $2")
    .replace(/(?<![A-Za-z])(\d)([A-Za-z])/g, "$1 $2")
    // Insert spaces before common English function words inside long fused runs
    // e.g. "modelshowsresultsbetween" -> "model shows results between"
    .replace(SPLIT_RE, " $1")
    // Collapse multiple spaces/newlines
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
