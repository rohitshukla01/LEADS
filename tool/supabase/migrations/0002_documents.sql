-- LEADS: one row per indexed paper, written by the ingestion scripts with the service-role key.
-- Run once in the Supabase SQL Editor (or with the Supabase CLI). Safe to re-run.

create table if not exists public.documents (
  id                    text primary key,
  name                  text not null,
  pages                 integer,
  chunk_count           integer,
  char_count            integer,
  qdrant_ids            jsonb not null default '[]'::jsonb,
  ingest_source         text,
  corpus_version        text,
  corpus_relative_path  text,
  corpus_sha256         text,
  created_at            timestamptz not null default now()
);

-- Writes use the service-role key, which bypasses Row-Level Security; signed-in users may read the list.
alter table public.documents enable row level security;

drop policy if exists "documents_select_authenticated" on public.documents;
create policy "documents_select_authenticated"
  on public.documents for select
  to authenticated
  using (true);
