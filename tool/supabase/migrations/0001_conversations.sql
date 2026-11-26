-- LEADS: per-user conversation history.
-- Run once in the Supabase SQL Editor (or with the Supabase CLI). Safe to re-run.
--
-- One row per conversation; the transcript lives in `messages` as JSONB (maps
-- 1:1 to the app's message array). Row-Level Security scopes every row to its
-- owner, so users can only ever see their own chats on the shared database.

create extension if not exists "pgcrypto";

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default 'New conversation',
  messages    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Fast "my conversations, newest first" lookups.
create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

-- Lock the table down; policies below grant per-owner access only.
alter table public.conversations enable row level security;

drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own"
  on public.conversations for select
  using (auth.uid() = user_id);

drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own"
  on public.conversations for insert
  with check (auth.uid() = user_id);

drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own"
  on public.conversations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own"
  on public.conversations for delete
  using (auth.uid() = user_id);
