import { getOpenAIClient } from "./openai-client";
import { embed } from "./cohere";

export interface RaptorNode {
  level: number;
  text: string;
  embedding: number[];
}

function extractText(response: { content: Array<{ type: string; text?: string }> }) {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

// Simple k-means clustering on embeddings
function kMeans(
  embeddings: number[][],
  k: number,
  maxIter = 20
): number[] {
  const n = embeddings.length;
  if (n <= k) return embeddings.map((_, i) => i);

  const dim = embeddings[0].length;
  // Initialize centroids by picking evenly spaced indices
  const centroids: number[][] = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor((i * n) / k);
    centroids.push([...embeddings[idx]]);
  }

  const assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // Assign each point to nearest centroid
    for (let i = 0; i < n; i++) {
      let bestDist = Infinity;
      let bestCluster = 0;
      for (let c = 0; c < k; c++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = embeddings[i][d] - centroids[c][d];
          dist += diff * diff;
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }

    if (!changed) break;

    // Update centroids
    for (let c = 0; c < k; c++) {
      const members = embeddings.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;
      for (let d = 0; d < dim; d++) {
        centroids[c][d] = members.reduce((s, m) => s + m[d], 0) / members.length;
      }
    }
  }

  return assignments;
}

async function summarizeCluster(texts: string[]): Promise<string> {
  try {
    const combined = texts.map((t, i) => `[${i + 1}] ${t.slice(0, 600)}`).join("\n\n");
    const response = await getOpenAIClient().messages.create(
      {
        model: "gpt-4.1-mini",
        max_tokens: 300,
        system: [
          {
            type: "text",
            text: "You are a document summarizer. Given a cluster of related passages, write a concise summary (2-4 sentences) capturing the key information. Output ONLY the summary.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Passages:\n${combined}\n\nSummary:`,
          },
        ],
      },
    );
    return extractText(response);
  } catch {
    return texts.map((t) => t.slice(0, 100)).join(" ");
  }
}

export async function buildRaptorTree(
  chunks: string[],
  embeddings: number[][]
): Promise<RaptorNode[]> {
  if (chunks.length < 5) return []; // Too few chunks for clustering

  // Absolute fan-out cap: summarizeCluster LLM calls scale ~0.25 × chunks.length
  // and this runs on the standalone ingest path (not covered by the per-request
  // cost breaker), so a very large document could fan out to thousands of calls.
  // Above the cap, tree-building is skipped (RAPTOR is an enhancement, not
  // required for retrieval). Tune via RAPTOR_MAX_CHUNKS.
  const MAX_RAPTOR_CHUNKS = (() => {
    const v = Number(process.env.RAPTOR_MAX_CHUNKS);
    return Number.isFinite(v) && v > 0 ? v : 2000;
  })();
  if (chunks.length > MAX_RAPTOR_CHUNKS) {
    console.warn(
      `[raptor] skipping tree-building: ${chunks.length} chunks exceeds RAPTOR_MAX_CHUNKS=${MAX_RAPTOR_CHUNKS} ` +
        `(~${Math.round(0.25 * chunks.length)} summarization calls avoided). ` +
        `Raise RAPTOR_MAX_CHUNKS to enable for larger documents.`,
    );
    return [];
  }

  const nodes: RaptorNode[] = [];
  let currentTexts = chunks;
  let currentEmbeddings = embeddings;
  const maxLevels = 3;

  for (let level = 1; level <= maxLevels; level++) {
    const k = Math.max(2, Math.ceil(currentTexts.length / 5));
    if (currentTexts.length <= 2) break;

    const assignments = kMeans(currentEmbeddings, k);

    // Group texts by cluster
    const clusters = new Map<number, string[]>();
    for (let i = 0; i < currentTexts.length; i++) {
      const cluster = assignments[i];
      if (!clusters.has(cluster)) clusters.set(cluster, []);
      clusters.get(cluster)!.push(currentTexts[i]);
    }

    // Summarize each cluster
    const summaries: string[] = [];
    const clusterEntries = Array.from(clusters.values()).filter((c) => c.length > 0);

    // Process summaries in parallel (max 5 concurrent)
    for (let i = 0; i < clusterEntries.length; i += 5) {
      const batch = clusterEntries.slice(i, i + 5);
      const batchSummaries = await Promise.all(batch.map(summarizeCluster));
      summaries.push(...batchSummaries);
    }

    // Embed summaries
    const summaryEmbeddings = await embed(summaries);

    for (let i = 0; i < summaries.length; i++) {
      nodes.push({
        level,
        text: summaries[i],
        embedding: summaryEmbeddings[i],
      });
    }

    // Next level operates on these summaries
    currentTexts = summaries;
    currentEmbeddings = summaryEmbeddings;
  }

  return nodes;
}
