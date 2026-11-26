import { getOpenAIClient } from "./openai-client";

const BATCH_SIZE = 10;

function chunkIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }

  return batches;
}

function extractText(response: { content: Array<{ type: string; text?: string }> }) {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

// Fast regex-only PII scrubbing (no LLM calls).
const PII_PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED-SSN]"],
  [/\b\d{9}\b/g, "[REDACTED-SSN]"],
  [/\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[REDACTED-PHONE]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[REDACTED-EMAIL]"],
  [/\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/g, "[REDACTED-ACCOUNT]"],
  [/\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g, "[REDACTED-DOB]"],
];

export function scrubPIIFast(chunks: string[]): string[] {
  return chunks.map((chunk) => {
    let result = chunk;
    for (const [pattern, replacement] of PII_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  });
}

export async function scrubPII(chunks: string[]): Promise<string[]> {
  if (chunks.length === 0) {
    return [];
  }

  const batches = chunkIntoBatches(chunks, BATCH_SIZE);
  const redactedBatches = await Promise.all(
    batches.map(async (batch) => {
      try {
        const response = await getOpenAIClient().messages.create({
          model: "gpt-4.1",
          max_tokens: 2200,
          system:
            "PII redactor for compliance documents. Given text chunks, identify and redact: full names of private individuals (not public figures/organizations), SSNs, phone numbers, personal email addresses, home addresses, dates of birth, financial account numbers, medical record numbers. Replace each PII span with [REDACTED-TYPE] e.g. [REDACTED-NAME], [REDACTED-SSN]. Return ONLY a JSON array of the redacted strings in the same order. Do NOT redact: organization names, public figures, regulatory body names, dates of events (only DOB), general locations (only specific home addresses).",
          messages: [
            {
              role: "user",
              content: JSON.stringify(batch),
            },
          ],
        });

        const raw = extractText(response);
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) {
          return batch;
        }

        const parsed = JSON.parse(match[0]) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== batch.length) {
          return batch;
        }

        return parsed.map((value, index) =>
          typeof value === "string" && value.trim().length > 0 ? value : batch[index]
        );
      } catch {
        return batch;
      }
    })
  );

  return redactedBatches.flat();
}
