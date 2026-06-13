-- Run this in the Supabase SQL editor for your project.
-- Ditto: profile_entries table with Row Level Security.

create table if not exists public.profile_entries (
  id            text    primary key,
  user_id       uuid    not null references auth.users(id) on delete cascade,
  canonical_key text    not null,
  display_label text    not null,
  aliases       text[]  not null default '{}',
  value         text    not null,
  category      text    not null,
  source        text    not null default 'manual',
  sensitive     boolean not null default false,
  created_at    bigint  not null,
  updated_at    bigint  not null,
  last_used     bigint,
  use_count     integer not null default 0
);

alter table public.profile_entries enable row level security;

create policy "users_own_entries"
  on public.profile_entries
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_profile_entries_user_id
  on public.profile_entries(user_id);

create index if not exists idx_profile_entries_updated_at
  on public.profile_entries(updated_at desc);
