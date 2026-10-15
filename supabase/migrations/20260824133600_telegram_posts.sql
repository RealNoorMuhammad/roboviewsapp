-- Robo View Machine · phone ingest (Telegram views only)
-- Run once in Supabase → SQL Editor, then add SUPABASE_URL + SUPABASE_ANON_KEY to .env
-- Auth → URL Configuration: add your Vercel phone URL (and/or http://localhost:3847)

create table if not exists public.telegram_posts (
  id uuid primary key default gen_random_uuid(),
  link text not null,
  title text,
  flow_id text,
  source text not null default 'mobile',
  status text not null default 'pending'
    check (status in ('pending', 'imported', 'error', 'duplicate')),
  error text,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  constraint telegram_posts_link_key unique (link)
);

-- If you already ran the first migration, run this too:
alter table public.telegram_posts
  add column if not exists source text not null default 'mobile';

create index if not exists telegram_posts_status_created_idx
  on public.telegram_posts (status, created_at);

create index if not exists telegram_posts_source_created_idx
  on public.telegram_posts (source, created_at desc);

alter table public.telegram_posts enable row level security;

drop policy if exists "anon insert telegram_posts" on public.telegram_posts;
drop policy if exists "anon select telegram_posts" on public.telegram_posts;
drop policy if exists "anon update telegram_posts" on public.telegram_posts;

create policy "anon insert telegram_posts"
  on public.telegram_posts
  for insert
  to anon
  with check (true);

create policy "anon select telegram_posts"
  on public.telegram_posts
  for select
  to anon
  using (true);

create policy "anon update telegram_posts"
  on public.telegram_posts
  for update
  to anon
  using (true)
  with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update on table public.telegram_posts to anon, authenticated;
