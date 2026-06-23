/**
 * Form-level fingerprinting — Phase AD.1.
 *
 * The existing field_cache (matcher.ts `fingerprint`) is keyed PER-FIELD by
 * `domain::name::id::label::inputType`. That works for "I've seen this exact
 * field on this exact site before" but never generalizes — learning fields on
 * Greenhouse/Databricks does nothing for Greenhouse/Stripe.
 *
 * This module produces a TWO-TIER form-level key:
 *
 *   Tier A — ATS family token (e.g. "greenhouse", "workday", "lever").
 *            Sourced from company-detector.ts URL patterns.
 *
 *   Tier B — Structural hash over the ordered list of field signatures, where
 *            each field reduces to {role, nameHash} so cosmetic edits ("First
 *            Name" vs "First name *") don't change the hash but a structural
 *            change (added field, removed field, reordered fields) does.
 *
 * Composite key:  `${atsId}::${structuralHash}`
 *
 * The fingerprint store maps that key to an array of `{nameHash, canonicalKey,
 * confidence}` entries. On a hit, every field whose nameHash appears in the
 * fingerprint gets its canonical_key assigned in one O(1) lookup — no regex,
 * no embeddings, no LLM, no per-field cache walk.
 *
 * Pure functions only. No DOM access, no IDB, no fetch. Importable from tests.
 */

import type { FieldSignature } from '@shared/types';
import { djb2 } from '../matcher';
import { getAtsId } from './company-detector';

// ─────────────────────────────────────────────────────────────────────────────
// Field-signature reduction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable single role string for fingerprinting. Prefers the browser's
 * resolved ARIA role (`axRole`) when meaningful, else falls back to the input
 * type. "generic" axRoles carry no semantic info and are skipped.
 */
function fieldRole(sig: FieldSignature): string {
  if (sig.axRole && sig.axRole !== 'generic') return sig.axRole;
  return sig.inputType || 'unknown';
}

/**
 * Pick the most stable name signal. Ordered for cross-machine consistency:
 * `label` is identical across all browsers; `axName` may diverge between
 * Chrome versions that do/don't support `computedName`, so it's a fallback,
 * not the primary source.
 *
 * `name`/`id` come last because some ATS systems generate them randomly
 * per-render (e.g. "f_3892"); using them as the primary signal would produce
 * a different fingerprint on every page load.
 */
function fieldNameSource(sig: FieldSignature): string {
  const candidates = [sig.label, sig.ariaLabel, sig.placeholder, sig.axName, sig.name, sig.id];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return '';
}

// "*" and "(required)" suffix patterns vary per portal; strip them so the
// label hash is the same regardless of whether the user is logged in (which
// often toggles required-indicators on/off in some ATS templates).
const REQUIRED_INDICATOR_RE = /\s*(\*+|\(required\)|\(req\)|\(optional\)|\(opt\))\s*/gi;
const STOPWORDS = new Set(['a', 'an', 'the', 'your', 'please', 'enter']);

/**
 * Normalize a name into a deterministic, stopword-free, punctuation-free
 * lowercase token sequence joined by single spaces. Two cosmetic variants
 * of the same label collapse to the same string:
 *
 *   "First Name *"      → "first name"
 *   "first name"        → "first name"
 *   "Your First Name"   → "first name"
 *   "First Name (req)"  → "first name"
 */
export function normalizeNameForHash(name: string): string {
  if (!name) return '';
  return name
    .replace(REQUIRED_INDICATOR_RE, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t))
    .join(' ');
}

/**
 * Hash a normalized name for use as the per-field identity inside a
 * fingerprint. Returns empty string for empty / unhashable input so callers
 * can use truthiness to skip fields with no stable name source.
 */
export function nameHash(name: string): string {
  const normalized = normalizeNameForHash(name);
  if (!normalized) return '';
  return djb2(normalized);
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural hash
// ─────────────────────────────────────────────────────────────────────────────

export interface FingerprintFieldRef {
  /** Position in the form's field order. Stable across pages of the same form. */
  position: number;
  /** Browser-resolved role or input type (e.g. "textbox", "combobox"). */
  role: string;
  /** djb2 hash of the field's normalized primary name. */
  nameHash: string;
}

/**
 * Reduce a field signature down to the minimal shape that contributes to
 * structural identity. Order matters — the array index becomes `position`.
 */
export function reduceFieldsForFingerprint(fields: FieldSignature[]): FingerprintFieldRef[] {
  return fields.map((f, i) => ({
    position: i,
    role: fieldRole(f),
    nameHash: nameHash(fieldNameSource(f)),
  }));
}

/**
 * Hash the ORDERED reduced field array. The serialization is JSON over the
 * shape `{role, nameHash}` (position is implicit in array order). Two forms
 * with identical structure produce the same hash on any machine.
 *
 * Using djb2 over a JSON string is deterministic, sync, and collision-safe
 * within a single user's namespace (one user holds ≤ a few hundred
 * fingerprints — djb2's 32-bit space is far more than enough).
 */
export function computeStructuralHash(fields: FieldSignature[]): string {
  const reduced = reduceFieldsForFingerprint(fields).map(r => ({ r: r.role, n: r.nameHash }));
  return djb2(JSON.stringify(reduced));
}

/** Compose the final fingerprint key from its two tiers. */
export function computeFingerprintKey(atsId: string, structuralHash: string): string {
  return `${atsId}::${structuralHash}`;
}

/**
 * One-shot helper for callers that have the live page available. Returns
 * the full key plus the inputs that built it (handy for logging / debugging
 * fingerprint misses).
 */
export interface FingerprintInputs {
  atsId: string;
  structuralHash: string;
  key: string;
  fieldCount: number;
}

export function buildFingerprintInputs(fields: FieldSignature[], url?: string): FingerprintInputs {
  const atsId = getAtsId(url);
  const structuralHash = computeStructuralHash(fields);
  return {
    atsId,
    structuralHash,
    key: computeFingerprintKey(atsId, structuralHash),
    fieldCount: fields.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One per-field learned mapping inside a fingerprint. `confidence` reflects
 * how the mapping was originally derived:
 *
 *   1.00 — user explicitly confirmed (learn pill, healed correction)
 *   ≥0.90 — auto-derived from autocomplete attribute (deterministic)
 *   ≥0.80 — auto-derived from text-pattern rule (high-quality)
 *
 * Mappings below 0.80 are not written; they're too unreliable to promote
 * to a cross-form cache layer.
 */
export interface FingerprintFieldEntry {
  nameHash: string;
  role: string;
  canonicalKey: string;
  confidence: number;
  learnedAt: number;
  useCount: number;
}

export interface FormFingerprint {
  key: string;                  // `${atsId}::${structuralHash}`
  atsId: string;
  structuralHash: string;
  exemplarUrl: string;          // first URL where we saw this (debug only)
  fields: FingerprintFieldEntry[];
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
}

/**
 * Lookup helper: given a live field signature, find the matching stored
 * mapping inside a previously-loaded fingerprint. Returns undefined when
 * the field's nameHash isn't present.
 */
export function findFingerprintEntry(
  fp: FormFingerprint,
  sig: FieldSignature,
): FingerprintFieldEntry | undefined {
  const target = nameHash(fieldNameSource(sig));
  if (!target) return undefined;
  // Linear scan is cheap — fingerprints rarely exceed ~30 fields.
  return fp.fields.find(f => f.nameHash === target);
}

/**
 * Build a candidate field mapping suitable for storing in a fingerprint.
 * Returns null when the signature lacks a stable name source (cannot be
 * persisted because we'd never find it again).
 */
export function buildFingerprintFieldCandidate(
  sig: FieldSignature,
  canonicalKey: string,
  confidence: number,
): Omit<FingerprintFieldEntry, 'learnedAt' | 'useCount'> | null {
  const hashed = nameHash(fieldNameSource(sig));
  if (!hashed) return null;
  return {
    nameHash: hashed,
    role: fieldRole(sig),
    canonicalKey,
    confidence,
  };
}

/**
 * Merge candidate mappings from THIS page scan into an existing fingerprint.
 * - First-write: returns a fresh FormFingerprint with every candidate at useCount=1.
 * - Subsequent: bumps useCount on rematched fields, adds new fields, and on
 *   a canonicalKey conflict prefers the higher-confidence side. User-confirmed
 *   mappings (confidence === 1.0) always win conflicts — that's how a learn-pill
 *   correction propagates back into the fingerprint.
 */
export function mergeFingerprint(
  existing: FormFingerprint | undefined,
  inputs: FingerprintInputs,
  candidates: Array<Omit<FingerprintFieldEntry, 'learnedAt' | 'useCount'>>,
  url: string,
  now: number = Date.now(),
): FormFingerprint {
  if (!existing) {
    return {
      key: inputs.key,
      atsId: inputs.atsId,
      structuralHash: inputs.structuralHash,
      exemplarUrl: url,
      fields: candidates.map(c => ({ ...c, learnedAt: now, useCount: 1 })),
      createdAt: now,
      lastUsedAt: now,
      useCount: 1,
    };
  }

  const merged = new Map<string, FingerprintFieldEntry>();
  for (const f of existing.fields) merged.set(f.nameHash, f);

  for (const c of candidates) {
    const prior = merged.get(c.nameHash);
    if (!prior) {
      merged.set(c.nameHash, { ...c, learnedAt: now, useCount: 1 });
      continue;
    }
    if (prior.canonicalKey === c.canonicalKey) {
      // Same mapping, bump useCount only.
      merged.set(c.nameHash, { ...prior, useCount: prior.useCount + 1 });
      continue;
    }
    // Conflict on canonical_key. Higher confidence wins; ties keep prior.
    if (c.confidence > prior.confidence) {
      merged.set(c.nameHash, { ...c, learnedAt: now, useCount: 1 });
    }
  }

  return {
    ...existing,
    fields: Array.from(merged.values()),
    lastUsedAt: now,
    useCount: existing.useCount + 1,
  };
}
