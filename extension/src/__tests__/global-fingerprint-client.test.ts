/**
 * Phase AL.5 — Unit tests for the global fingerprint client.
 *
 * What's covered:
 *   - globalConsensusForField: quorum gate (vote_count >= 3) vs template-key bypass
 *   - Missing field hash → null with isTemplate=false
 *   - Below-quorum + non-template → null but voteCount preserved (caller may log)
 *   - Template canonical_key bypasses the quorum
 *   - isTemplateCanonicalKey: known keys recognised, junk keys rejected
 *
 * NOT covered here (handled in integration / E2E):
 *   - The actual Supabase round-trip (mocked away)
 *   - IDB cache TTL (covered indirectly via idb.ts behaviour)
 */

import {
  globalConsensusForField,
  type GlobalVoteResult,
} from '../background/global-fingerprint-client';
import type { GlobalFingerprintCacheEntry } from '../storage/idb';
import { isTemplateCanonicalKey } from '../content-script/ats-templates';

function makeCache(votes: GlobalFingerprintCacheEntry['votes']): GlobalFingerprintCacheEntry {
  return {
    key: 'greenhouse::abc123',
    atsId: 'greenhouse',
    votes,
    fetchedAt: Date.now(),
  };
}

describe('isTemplateCanonicalKey', () => {
  it('recognises a key that exists in the Greenhouse template', () => {
    expect(isTemplateCanonicalKey('first_name')).toBe(true);
    expect(isTemplateCanonicalKey('email')).toBe(true);
    expect(isTemplateCanonicalKey('phone_number')).toBe(true);
  });

  it('rejects a key not in any template', () => {
    expect(isTemplateCanonicalKey('favourite_pizza_topping')).toBe(false);
    expect(isTemplateCanonicalKey('random_garbage_xyz')).toBe(false);
  });

  it('handles empty / undefined input gracefully', () => {
    expect(isTemplateCanonicalKey('')).toBe(false);
  });
});

describe('globalConsensusForField — quorum gate', () => {
  it('returns the canonical when vote_count >= 3 (quorum met)', () => {
    const cache = makeCache({
      hash_abc: { canonical: 'phone_number', voteCount: 5 },
    });
    const r = globalConsensusForField(cache, 'hash_abc');
    expect(r.canonical).toBe('phone_number');
    expect(r.voteCount).toBe(5);
  });

  it('returns null when vote_count < 3 and canonical_key NOT in templates', () => {
    const cache = makeCache({
      hash_xyz: { canonical: 'favourite_color', voteCount: 2 },
    });
    const r = globalConsensusForField(cache, 'hash_xyz');
    expect(r.canonical).toBeNull();
    expect(r.voteCount).toBe(2); // count is preserved for diagnostics
    expect(r.isTemplate).toBe(false);
  });

  it('returns the canonical when vote_count < 3 BUT canonical IS a template key', () => {
    // Templates are trusted — we accept them even at low vote counts because
    // the template itself ships at confidence 0.95 in the extension.
    const cache = makeCache({
      hash_pn: { canonical: 'phone_number', voteCount: 1 },
    });
    const r = globalConsensusForField(cache, 'hash_pn');
    expect(r.canonical).toBe('phone_number');
    expect(r.voteCount).toBe(1);
    expect(r.isTemplate).toBe(true);
  });
});

describe('globalConsensusForField — edge cases', () => {
  it('field_hash not in cache → null', () => {
    const cache = makeCache({
      hash_a: { canonical: 'email', voteCount: 10 },
    });
    const r = globalConsensusForField(cache, 'hash_missing');
    expect(r.canonical).toBeNull();
    expect(r.voteCount).toBe(0);
    expect(r.isTemplate).toBe(false);
  });

  it('completely empty cache → null for any hash', () => {
    const cache = makeCache({});
    const r = globalConsensusForField(cache, 'any_hash');
    expect(r.canonical).toBeNull();
    expect(r.voteCount).toBe(0);
  });

  it('vote_count exactly at the boundary (3) passes quorum', () => {
    const cache = makeCache({
      h: { canonical: 'address_city', voteCount: 3 },
    });
    const r = globalConsensusForField(cache, 'h');
    expect(r.canonical).toBe('address_city');
  });

  it('vote_count of 2 + non-template fails quorum', () => {
    const cache = makeCache({
      h: { canonical: 'totally_random_key', voteCount: 2 },
    });
    const r = globalConsensusForField(cache, 'h');
    expect(r.canonical).toBeNull();
  });
});

describe('globalConsensusForField — result shape', () => {
  it('always returns a GlobalVoteResult object (never throws)', () => {
    const cache = makeCache({});
    const r: GlobalVoteResult = globalConsensusForField(cache, 'x');
    expect(r).toHaveProperty('canonical');
    expect(r).toHaveProperty('voteCount');
    expect(r).toHaveProperty('isTemplate');
  });
});
