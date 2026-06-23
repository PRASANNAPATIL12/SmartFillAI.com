-- Form Fingerprints cloud sync — Phase AD.3
--
-- Whole-form-level cache learned by the extension when a user fills any form
-- on a supported ATS. Mirrors the local IndexedDB form_fingerprints store so a
-- user signing in on a second device inherits the first device's accumulated
-- form-recognition immediately.
--
-- ─── Privacy ─────────────────────────────────────────────────────────────────
-- The payload column stores a FormFingerprint object. By design it contains
-- ONLY:
--   • structural hashes (one-way djb2 over normalized label text + role)
--   • canonical-key names ("first_name", "phone_number", "current_company")
--   • per-field useCount, learnedAt timestamps
--   • atsId family token and an exemplar URL for debugging
--
-- It MUST NOT contain:
--   • actual form-field values (those live in profile_entries)
--   • raw label text (only its djb2 hash)
--   • any user-identifying URL fragment beyond the exemplar host+path
--
-- Row Level Security restricts every read/write to the row's owner.
-- Two distinct users filling the same Greenhouse form independently
-- produce the same structuralHash — but their rows are still separate
-- per-user under RLS; the hash collision is not user-identifying.
--
-- Run this in the Supabase SQL editor for your project.

create table if not exists public.form_fingerprints (
  user_id    uuid    not null references auth.users(id) on delete cascade,
  key        text    not null,           -- "${atsId}::${structuralHash}"
  ats_id     text    not null,           -- "greenhouse" | "workday" | "lever" | ...
  payload    jsonb   not null,           -- the FormFingerprint object
  updated_at bigint  not null,           -- millisecond timestamp from extension
  primary key (user_id, key)
);

alter table public.form_fingerprints enable row level security;

drop policy if exists "users_own_form_fingerprints" on public.form_fingerprints;
create policy "users_own_form_fingerprints"
  on public.form_fingerprints
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Per-ATS lookups (popular ATS families) + recent-first ordering for incremental pulls
create index if not exists idx_form_fingerprints_ats_id
  on public.form_fingerprints(user_id, ats_id);
create index if not exists idx_form_fingerprints_updated_at
  on public.form_fingerprints(user_id, updated_at desc);
