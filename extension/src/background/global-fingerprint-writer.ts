/**
 * Phase AM — Global fingerprint writer (write path).
 *
 * Counterpart to global-fingerprint-client.ts (read path). Contributes
 * learned per-user field→canonical_key mappings to the crowdsourced global
 * tier so every other user benefits from them on their first visit to the
 * same ATS form.
 *
 * ─── Privacy invariant ────────────────────────────────────────────────────────
 * NOTHING that crosses the wire can identify the user or reveal their profile
 * values. Exactly three kinds of data are sent:
 *   1. Fingerprint key  — `${atsId}::${structuralHash}` (public + hashed)
 *   2. field_hash       — djb2(normalize(label)) — one-way, irreversible
 *   3. canonical_key    — schema string from SAFE_CANONICAL_KEYS whitelist
 *
 * Values, raw labels, resume text, Q&A answers, embeddings: never sent.
 *
 * ─── When this runs ──────────────────────────────────────────────────────────
 * Called from the background ditto_sync alarm (every 5 min), AFTER the
 * per-user pushFormFingerprints() call, when:
 *   - User is signed in (session exists)
 *   - settings.cloudSync === true
 *   - settings.contributeToGlobal === true (opt-out; default ON)
 *
 * ─── Dedup guard ─────────────────────────────────────────────────────────────
 * A chrome.storage.local log tracks `{ [fpKey]: lastContributedAt }`. A
 * fingerprint is re-contributed only when 23h have passed since the last
 * successful contribution for that key. This prevents vote_count inflation
 * from the same user on every alarm tick, while still catching fingerprints
 * that gained new field mappings since the last contribution.
 *
 * ─── Rate limit ──────────────────────────────────────────────────────────────
 * The Supabase contribute_fingerprint() function enforces 50 calls/user/24h.
 * When it returns rate_limited=true, this module marks everything contributed
 * so far and stops — remaining fingerprints are deferred to the next window.
 * Fingerprints are sorted by useCount desc so the most-used (most reliable)
 * ones are always contributed first.
 */

import { getSession } from './auth-manager';
import { getAuthClient } from './supabase-client';
import { getAllFormFingerprints } from '@/storage/idb';
import type { FormFingerprint, FingerprintFieldEntry } from '../content-script/form-fingerprinter';

// ── Canonical key whitelist ───────────────────────────────────────────────────
// Only these schema-string canonical_keys are ever contributed. This is the
// primary PII defense: even if a bug ever caused a user's email address to
// appear as a canonical_key, it would be silently dropped here.

const SAFE_CANONICAL_KEYS = new Set([
  'first_name', 'last_name', 'full_name', 'email', 'phone_number', 'phone_country_code',
  'linkedin_url', 'github_url', 'portfolio_url', 'website_url', 'twitter_url',
  'current_company', 'current_title', 'years_experience', 'current_salary', 'expected_salary',
  'salary_expectation', 'notice_period',
  'street_address', 'city', 'state', 'postal_code', 'country',
  'education_school', 'education_degree', 'education_field', 'education_gpa', 'education_year',
  'work_authorization', 'sponsorship_required', 'gender', 'pronouns',
  'ethnicity', 'veteran_status', 'disability_status', 'race',
  'cover_letter', 'skills', 'summary', 'availability_date', 'start_date', 'dob',
  'referral_source', 'citizenship', 'drivers_license', 'languages',
]);

// Minimum confidence for a field mapping to be eligible for contribution.
// Matches the minimum the fingerprint store already requires (see form-fingerprinter.ts).
const MIN_CONTRIBUTE_CONFIDENCE = 0.80;

// ── Dedup guard ───────────────────────────────────────────────────────────────

const CONTRIB_LOG_KEY = 'ditto_global_contrib_log';
// 23h — slightly under 24h to account for clock skew between devices
const CONTRIB_COOLDOWN_MS = 23 * 60 * 60 * 1000;
// How long before we evict an entry from the local log (25h — just over the window)
const CONTRIB_LOG_EVICT_MS = 25 * 60 * 60 * 1000;

async function getContribLog(): Promise<Record<string, number>> {
  try {
    const r = await chrome.storage.local.get(CONTRIB_LOG_KEY);
    return (r[CONTRIB_LOG_KEY] as Record<string, number>) ?? {};
  } catch {
    return {};
  }
}

async function markContributed(keys: string[], now: number): Promise<void> {
  if (keys.length === 0) return;
  try {
    const log = await getContribLog();
    for (const k of keys) {
      log[k] = now;
    }
    // Evict entries older than 25h to keep chrome.storage lean
    for (const [k, t] of Object.entries(log)) {
      if (now - t > CONTRIB_LOG_EVICT_MS) delete log[k];
    }
    await chrome.storage.local.set({ [CONTRIB_LOG_KEY]: log });
  } catch {
    // Non-fatal: if the write fails, we'll just re-contribute next tick
  }
}

function shouldContribute(key: string, log: Record<string, number>, now: number): boolean {
  const last = log[key];
  return !last || (now - last) > CONTRIB_COOLDOWN_MS;
}

// ── Field vote builder ────────────────────────────────────────────────────────

interface FieldVote {
  field_hash: string;
  canonical_key: string;
}

/**
 * Extract the sanitized set of field votes from a fingerprint.
 * Returns an empty array when nothing is safe to contribute.
 */
export function buildFieldVotes(fp: FormFingerprint): FieldVote[] {
  return fp.fields
    .filter((f: FingerprintFieldEntry) =>
      f.nameHash.length > 0 &&                    // must have a stable label hash
      f.canonicalKey &&                            // must have a mapping
      SAFE_CANONICAL_KEYS.has(f.canonicalKey) &&  // must be a whitelisted schema key
      f.confidence >= MIN_CONTRIBUTE_CONFIDENCE   // must be high-confidence
    )
    .map((f: FingerprintFieldEntry) => ({
      field_hash:    f.nameHash,
      canonical_key: f.canonicalKey,
    }));
}

// ── Main contribution function ────────────────────────────────────────────────

export interface ContributeResult {
  contributed: number;
  rateLimited: boolean;
  skipped: number;
}

/**
 * Contribute learned fingerprints to the global shared brain.
 *
 * Called by the sync alarm handler after per-user pushFormFingerprints()
 * so local data is always fresher than what we'd contribute.
 */
export async function contributeToGlobal(): Promise<ContributeResult> {
  const session = await getSession();
  if (!session) return { contributed: 0, rateLimited: false, skipped: 0 };

  const now = Date.now();
  const [all, log] = await Promise.all([
    getAllFormFingerprints(),
    getContribLog(),
  ]);

  // Filter: learned only, has fingerprint content, passes dedup guard
  const eligible = all
    .filter(fp => (fp.source ?? 'learned') === 'learned')
    .filter(fp => fp.fields.length > 0)
    .filter(fp => shouldContribute(fp.key, log, now))
    // Most-used fingerprints contributed first — they're the most reliable signal
    .sort((a, b) => b.useCount - a.useCount);

  if (eligible.length === 0) return { contributed: 0, rateLimited: false, skipped: 0 };

  const client = getAuthClient(session);
  let contributed = 0;
  let skipped = 0;
  const contributedKeys: string[] = [];

  for (const fp of eligible) {
    const fieldVotes = buildFieldVotes(fp);
    if (fieldVotes.length === 0) {
      skipped++;
      continue;
    }

    try {
      const { data, error } = await client.rpc('contribute_fingerprint', {
        p_key:         fp.key,
        p_ats_id:      fp.atsId,
        p_field_votes: fieldVotes,
      });

      if (error) {
        // Network or Supabase error — skip this fingerprint, try the next
        continue;
      }

      // The RPC returns a single-row table: [{ recorded, rate_limited }]
      const row = Array.isArray(data) ? data[0] : null;
      if (row?.rate_limited) {
        // Server rate limit hit — persist what we have and stop
        await markContributed(contributedKeys, now);
        return { contributed, rateLimited: true, skipped };
      }
      if (row?.recorded) {
        contributed++;
        contributedKeys.push(fp.key);
      }
    } catch {
      // Any unexpected error (offline, SW killed mid-loop) → skip fingerprint
      continue;
    }
  }

  await markContributed(contributedKeys, now);
  return { contributed, rateLimited: false, skipped };
}
