/**
 * Session memory for LEADS - stores the last N Q&A turns per session in
 * Upstash Redis so the LLM can resolve follow-up questions like
 * "what about last year?" or "and at Beaverdam?".
 *
 * Redis keys: leads:session:{sessionId}  (TTL: 2 h)
 * Value: JSON-encoded ConversationTurn[]
 */

const SESSION_KEY_PREFIX = "leads:session:";
const SESSION_TTL_SECONDS = 60 * 60 * 2; // 2 hours
const MAX_TURNS_STORED = 3;
const MAX_ANSWER_CHARS = 400; // truncate long answers before storing

export interface ConversationTurn {
  query: string;
  answer: string;
}

function getRedisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function redisCommand(
  url: string,
  token: string,
  command: unknown[]
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { result?: unknown };
  return payload.result ?? null;
}

/** Load conversation history for a session. Returns [] if none exists. */
export async function loadHistory(sessionId: string): Promise<ConversationTurn[]> {
  if (!sessionId) return [];
  const cfg = getRedisConfig();
  if (!cfg) return [];

  try {
    const raw = await redisCommand(cfg.url, cfg.token, [
      "GET",
      `${SESSION_KEY_PREFIX}${sessionId}`,
    ]);
    if (typeof raw !== "string") return [];
    return JSON.parse(raw) as ConversationTurn[];
  } catch {
    return [];
  }
}

/** Append a Q&A turn to the session, keeping only the last MAX_TURNS_STORED. */
export async function saveHistory(
  sessionId: string,
  previousHistory: ConversationTurn[],
  query: string,
  answer: string
): Promise<void> {
  if (!sessionId) return;
  const cfg = getRedisConfig();
  if (!cfg) return;

  const newTurn: ConversationTurn = {
    query,
    answer: answer.slice(0, MAX_ANSWER_CHARS),
  };
  const updated = [...previousHistory, newTurn].slice(-MAX_TURNS_STORED);

  try {
    await redisCommand(cfg.url, cfg.token, [
      "SET",
      `${SESSION_KEY_PREFIX}${sessionId}`,
      JSON.stringify(updated),
      "EX",
      SESSION_TTL_SECONDS,
    ]);
  } catch {
    // Non-critical - failure to save history never breaks the query
  }
}

/**
 * Format conversation history for injection into the synthesis prompt.
 * Returns empty string when there's no history (first query in a session).
 */
export function formatHistoryForPrompt(history: ConversationTurn[]): string {
  if (history.length === 0) return "";
  const turns = history
    .map((turn, i) => `Q${i + 1}: ${turn.query}\nA${i + 1}: ${turn.answer}`)
    .join("\n\n");
  return (
    "[Conversation context — use only if the user's question is a follow-up. " +
    "Do not repeat information the user already has.]\n" +
    turns +
    "\n\n"
  );
}
