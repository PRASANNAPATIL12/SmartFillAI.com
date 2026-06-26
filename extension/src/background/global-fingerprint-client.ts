/**
 * Phase AL — Global fingerprint client (read path).
 *
 * Queries the crowdsourced global tier for consensus field mappings on a
 * fingerprint key. Cached locally for 7 days (see idb.ts:GlobalFingerprintCacheEntry).
 *
 * ─── How the result is computed ──────────────────────────────────────────────
 * Supabase migration 006 defines `global_field_votes(key, field_hash,
 * canonical_key, vote_count)`. We fetch all rows for this key, group by
 * field_hash, and pick the canonical_key with the highest vote_count per
 * group. The caller then decides whether to USE each consensus mapping based
 * on the quorum rule (see globalConsensusForField below).
 *
 * ─── Privacy ─────────────────────────────────────────────────────────────────
 * This module is READ-ONLY. It NEVER sends user data to Supabase. The write
 * path (contribute_fingerprint) is in Phase AM (sync-engine extension).
 *
 * ─── Failure modes ───────────────────────────────────────────────────────────
 * Network offline, Supabase down, no rows for this key: all surface as
 * `{ votes: {}, source: 'miss' }`. The matcher's Step 1.7 treats "miss" as
 * "fall through to next tier"; no error is shown to the user.
 */

import { getAuthClient } from './supabase-client';
import { getSession } from './auth-manager';
import {
  getGlobalFpCacheEntry,
  putGlobalFpCacheEntry,
  type GlobalFingerprintCacheEntry,
} from '@/storage/idb';
import { isTemplateCanonicalKey } from '@/content-script/ats-templates';

const VOTES_TABLE = 'global_field_votes';

interface GlobalVoteRow {
  key:           string;
  field_hash:    string;
  canonical_key: string;
  vote_count:    number;
}

export interface GlobalVoteResult {
  /** Top-voted canonical_key for the field_hash, after applying the quorum gate. */
  canonical: string | null;
  voteCount: number;
  /** Set when canonical_key is one of the seeded ATS-template keys. */
  isTemplate: boolean;
}

const QUORUM_MIN_VOTES = 3;

/**
 * Apply the quorum rule to a single field's top vote. A canonical_key passes
 * if vote_count >= 3 OR it matches a known ATS-template key (templates are
 * trusted by design — they ship in the extension).
 */
function passesQuorum(canonical: string, voteCount: number): boolean {
  if (voteCount >= QUORUM_MIN_VOTES) return true;
  if (isTemplateCanonicalKey(canonical)) return true;
  return false;
}

/**
 * Fetch + cache. Returns the cached entry on hit (<7 days old), otherwise
 * pulls from Supabase, caches, and returns. On any error (offline, RLS,
 * Supabase down) returns an entry with empty `votes` so callers can treat
 * it as a clean miss.
 */
export async function getGlobalConsensus(
  fpKey: string,
  atsId: string,
): Promise<GlobalFingerprintCacheEntry> {
  // 1. Cache hit (<7 days)
  const cached = await getGlobalFpCacheEntry(fpKey);
  if (cached) return cached;

  // 2. Cache miss → Supabase round-trip
  const fetched = await fetchVotesFromSupabase(fpKey).catch(() => null);
  const entry: GlobalFingerprintCacheEntry = {
    key:       fpKey,
    atsId,
    votes:     fetched ?? {},
    fetchedAt: Date.now(),
  };

  // 3. Persist — even an empty result is worth caching so we don't hammer
  // Supabase on every page load for a never-contributed fingerprint.
  await putGlobalFpCacheEntry(entry).catch(() => {});
  return entry;
}

/**
 * Return the consensus canonical_key for a specific field_hash on a
 * fingerprint, honouring the quorum rule. Returns null if no consensus
 * (cache miss, no rows, or below-quorum votes).
 */
export function globalConsensusForField(
  cache: GlobalFingerprintCacheEntry,
  fieldHash: string,
): GlobalVoteResult {
  const vote = cache.votes[fieldHash];
  if (!vote) {
    return { canonical: null, voteCount: 0, isTemplate: false };
  }
  const isTemplate = isTemplateCanonicalKey(vote.canonical);
  if (!passesQuorum(vote.canonical, vote.voteCount)) {
    return { canonical: null, voteCount: vote.voteCount, isTemplate };
  }
  return { canonical: vote.canonical, voteCount: vote.voteCount, isTemplate };
}

// ── Supabase read ───────────────────────────────────────────────────────────

async function fetchVotesFromSupabase(
  fpKey: string,
): Promise<Record<string, { canonical: string; voteCount: number }> | null> {
  const session = await getSession();
  if (!session) return null;       // anonymous / not signed in → no global tier
  const client = getAuthClient(session);

  const { data, error } = await client
    .from(VOTES_TABLE)
    .select('field_hash, canonical_key, vote_count')
    .eq('key', fpKey);

  if (error || !Array.isArray(data)) return null;

  // Pick top-voted canonical_key per field_hash
  const topByHash: Record<string, { canonical: string; voteCount: number }> = {};
  for (const row of data as GlobalVoteRow[]) {
    if (!row.field_hash || !row.canonical_key) continue;
    const current = topByHash[row.field_hash];
    if (!current || row.vote_count > current.voteCount) {
      topByHash[row.field_hash] = {
        canonical: row.canonical_key,
        voteCount: row.vote_count,
      };
    }
  }
  return topByHash;
}
