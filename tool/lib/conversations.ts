// LEADS conversation history - per-user saved chats in Supabase Postgres.
//
// Storage model: one row per conversation in `public.conversations`, with the
// whole transcript stored as JSONB (maps 1:1 to the React `messages` array).
// Security: Row-Level Security scopes every row to its owner (auth.uid()), so a
// user can only ever read/write their own conversations on the shared database.
//
// All calls fail soft: if the table does not exist yet (migration not run) or the user
// is signed out, they return empty or do nothing instead of throwing, and the history
// list appears once the table exists.
//
// Required one-time migration (run in the Supabase SQL Editor): see
// supabase/migrations/0001_conversations.sql.

import { createClient } from "@/lib/supabase/client";

const TABLE = "conversations";

export type ConversationSummary = {
  id: string;
  title: string;
  updated_at: string;
};

/** List the signed-in user's conversations, most-recently-updated first. */
export async function listConversations(): Promise<ConversationSummary[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) return [];
    return (data ?? []) as ConversationSummary[];
  } catch {
    return [];
  }
}

/** Load one conversation's full transcript (or null if missing / not yours). */
export async function loadConversationMessages(id: string): Promise<unknown[] | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select("messages")
      .eq("id", id)
      .single();
    if (error || !data) return null;
    return ((data as { messages?: unknown[] }).messages ?? []) as unknown[];
  } catch {
    return null;
  }
}

/** Create-or-update a conversation (upsert by id). user_id is filled by the
 *  DB default (auth.uid()), so the browser never has to send it. */
export async function saveConversation(
  id: string,
  title: string,
  messages: unknown[],
): Promise<void> {
  try {
    const supabase = createClient();
    await supabase
      .from(TABLE)
      .upsert(
        { id, title, messages, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
  } catch {
    /* table may not exist yet - ignore */
  }
}

/** Delete a conversation (RLS ensures only the owner can). */
export async function deleteConversation(id: string): Promise<void> {
  try {
    const supabase = createClient();
    await supabase.from(TABLE).delete().eq("id", id);
  } catch {
    /* ignore */
  }
}
