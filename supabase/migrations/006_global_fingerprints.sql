-- Phase AL — Crowdsourced "shared brain" — Global fingerprint tier
--
-- This adds a SECOND tier of fingerprint storage that is shared across ALL
-- authenticated SmartFillAI users. It is built ON TOP of the existing per-user
-- form_fingerprints table (migration 002), not replacing it.
--
-- ─── Why ─────────────────────────────────────────────────────────────────────
-- Today every user is an island. User A spending 10 minutes teaching the
-- extension that some Workday field is `phone_number` provides ZERO benefit
-- to user B who hits the same form tomorrow. The global tier closes that gap.
--
-- ─── Privacy invariant (non-negotiable) ──────────────────────────────────────
-- NO user values ever cross account boundaries. Only structural metadata:
--    • atsId (public knowledge — "greenhouse", "workday", ...)
--    • structuralHash (one-way djb2 over sorted role+normLabel+inputType)
--    • per-field djb2(label) — labels are never sent raw
--    • per-field canonical_key (schema string — "phone_number", etc.)
--
-- Names, emails, addresses, resume text, Q&A answers, embeddings → all stay
-- per-user in the existing form_fingerprints + profile_entries tables.
--
-- ─── Reads ───────────────────────────────────────────────────────────────────
-- Any authenticated user can SELECT from both global tables. The waterfall's
-- new Step 1.7 reads these to decide whether a never-before-seen-locally form
-- has a high-confidence consensus mapping.
--
-- ─── Writes ──────────────────────────────────────────────────────────────────
-- Writes go through a SECURITY DEFINER function `contribute_fingerprint`.
-- Direct INSERT/UPDATE/DELETE on the tables is denied to non-service roles.
-- This is what Phase AM will call from the extension sync engine.
--
-- Run this in the Supabase SQL editor for your project.

-- ─── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.global_fingerprints (
  key            text    primary key,         -- "${atsId}::${structuralHash}"
  ats_id         text    not null,            -- "greenhouse" | "workday" | "lever" | ...
  field_count    int     not null,            -- how many distinct field hashes this fp has
  contributor_n  int     not null default 1,  -- distinct users who've contributed
  first_seen_at  bigint  not null,            -- ms since epoch
  last_updated   bigint  not null             -- ms since epoch
);

create table if not exists public.global_field_votes (
  key            text    not null references public.global_fingerprints(key) on delete cascade,
  field_hash     text    not null,            -- djb2(normalizeLabel(label)) — never raw label
  canonical_key  text    not null,            -- "phone_number" | "current_company" | ...
  vote_count     int     not null default 1,  -- how many distinct contributions support this mapping
  primary key (key, field_hash, canonical_key)
);

-- ─── Indexes ────────────────────────────────────────────────────────────────
-- Common access pattern in Step 1.7: given a fingerprint key, fetch all field
-- votes for it, then group by field_hash and pick the top-voted canonical_key.
create index if not exists idx_global_field_votes_key
  on public.global_field_votes(key);
create index if not exists idx_global_field_votes_key_hash
  on public.global_field_votes(key, field_hash, vote_count desc);

-- ─── RLS — authenticated read, no direct write ───────────────────────────────
alter table public.global_fingerprints enable row level security;
alter table public.global_field_votes  enable row level security;

drop policy if exists "global_fp_authenticated_read" on public.global_fingerprints;
create policy "global_fp_authenticated_read"
  on public.global_fingerprints
  for select
  using (auth.role() = 'authenticated');

drop policy if exists "global_fv_authenticated_read" on public.global_field_votes;
create policy "global_fv_authenticated_read"
  on public.global_field_votes
  for select
  using (auth.role() = 'authenticated');

-- ─── Audit log (for rate-limiting and abuse detection — Phase AM) ────────────
-- This is per-user, RLS-scoped so users only see their own contributions.
create table if not exists public.global_contribution_log (
  user_id        uuid    not null references auth.users(id) on delete cascade,
  key            text    not null,
  contributed_at bigint  not null,
  field_count    int     not null,
  primary key (user_id, key, contributed_at)
);
create index if not exists idx_contrib_log_user_time
  on public.global_contribution_log(user_id, contributed_at desc);

alter table public.global_contribution_log enable row level security;
drop policy if exists "contrib_log_owner" on public.global_contribution_log;
create policy "contrib_log_owner"
  on public.global_contribution_log
  for select
  using (auth.uid() = user_id);

-- ─── Contribution function (called from Phase AM) ────────────────────────────
-- SECURITY DEFINER so it can bypass the table-level RLS (writes), but the
-- function body still validates auth.uid() to attribute the contribution
-- correctly and enforce per-user rate limits.
--
-- Rate limit: max 50 contributions per user per 24h, enforced by counting
-- rows in global_contribution_log for the same user_id within the window.
-- The 51st call returns without writing.
create or replace function public.contribute_fingerprint(
  p_key         text,
  p_ats_id      text,
  p_field_votes jsonb     -- array of { field_hash, canonical_key }
) returns table (
  recorded     boolean,
  rate_limited boolean
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_user_id      uuid := auth.uid();
  v_now_ms       bigint := (extract(epoch from now()) * 1000)::bigint;
  v_window_start bigint := v_now_ms - (24 * 60 * 60 * 1000);
  v_recent_count int;
  v_field_count  int := jsonb_array_length(p_field_votes);
begin
  if v_user_id is null then
    return query select false, false;
    return;
  end if;

  -- Per-user rate limit (50 contributions / rolling 24h)
  select count(*) into v_recent_count
  from public.global_contribution_log
  where user_id = v_user_id and contributed_at > v_window_start;
  if v_recent_count >= 50 then
    return query select false, true;
    return;
  end if;

  -- 1. Upsert the parent fingerprint row
  insert into public.global_fingerprints (key, ats_id, field_count, first_seen_at, last_updated)
  values (p_key, p_ats_id, v_field_count, v_now_ms, v_now_ms)
  on conflict (key) do update
    set last_updated  = excluded.last_updated,
        contributor_n = public.global_fingerprints.contributor_n + 1,
        field_count   = greatest(public.global_fingerprints.field_count, excluded.field_count);

  -- 2. Upsert each field vote
  insert into public.global_field_votes (key, field_hash, canonical_key, vote_count)
  select p_key,
         (v->>'field_hash')::text,
         (v->>'canonical_key')::text,
         1
  from jsonb_array_elements(p_field_votes) v
  where (v->>'field_hash') is not null
    and (v->>'canonical_key') is not null
    and length(v->>'field_hash') > 0
    and length(v->>'canonical_key') > 0
  on conflict (key, field_hash, canonical_key) do update
    set vote_count = public.global_field_votes.vote_count + 1;

  -- 3. Audit log row
  insert into public.global_contribution_log (user_id, key, contributed_at, field_count)
  values (v_user_id, p_key, v_now_ms, v_field_count);

  return query select true, false;
end;
$$;

-- Grant execute to authenticated users; deny to anon
revoke execute on function public.contribute_fingerprint(text, text, jsonb) from public, anon;
grant  execute on function public.contribute_fingerprint(text, text, jsonb) to   authenticated;

-- ─── Read helper (optional sugar for the extension) ──────────────────────────
-- Given a fingerprint key, return the top-voted canonical_key per field_hash
-- in a single round-trip. The extension can also do this client-side with
-- vanilla SELECTs — either path works.
create or replace function public.global_top_votes(p_key text)
returns table (field_hash text, canonical_key text, vote_count int)
language sql security definer
set search_path = public
as $$
  select distinct on (field_hash)
    field_hash,
    canonical_key,
    vote_count
  from public.global_field_votes
  where key = p_key
  order by field_hash, vote_count desc, canonical_key;
$$;

revoke execute on function public.global_top_votes(text) from public, anon;
grant  execute on function public.global_top_votes(text) to   authenticated;
