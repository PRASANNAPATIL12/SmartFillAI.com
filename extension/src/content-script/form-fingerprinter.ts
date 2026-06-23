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
import { detectAts } from './company-detector';
import type { AtsDetection } from './company-detector';

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
 * fingerprint misses). `detection` carries the method + confidence used to
 * arrive at atsId, so debug logs can surface "ats=greenhouse via=query_param".
 */
export interface FingerprintInputs {
  atsId: string;
  structuralHash: string;
  key: string;
  fieldCount: number;
  detection: AtsDetection;
}

export function buildFingerprintInputs(fields: FieldSignature[], url?: string): FingerprintInputs {
  const doc = typeof document !== 'undefined' ? document : undefined;
  const detection = detectAts(url, doc);
  const structuralHash = computeStructuralHash(fields);
  return {
    atsId: detection.atsId,
    structuralHash,
    key: computeFingerprintKey(detection.atsId, structuralHash),
    fieldCount: fields.length,
    detection,
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

/**
 * Phase AE.2 — provenance flag.
 *
 *   'template' — seeded from an ATS template on extension install. NOT pushed
 *                to Supabase (identical for all users; pushing wastes bandwidth).
 *   'learned'  — at least one real user fill matched this fingerprint, OR the
 *                user explicitly corrected a field. Eligible for cloud sync.
 *
 * `mergeFingerprint` automatically promotes template → learned on first real
 * fill activity.
 */
export type FingerprintSource = 'template' | 'learned';

export interface FormFingerprint {
  key: string;                  // `${atsId}::${structuralHash}`
  atsId: string;
  structuralHash: string;
  exemplarUrl: string;          // first URL where we saw this (debug only)
  fields: FingerprintFieldEntry[];
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  /** Provenance. Defaults to 'learned' on old persisted rows (handled at read time). */
  source?: FingerprintSource;
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
      source: 'learned',  // real user fill → real provenance from the start
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
    // Phase AE.2 — any real-fill merge promotes a template fingerprint to
    // 'learned' status, making it eligible for cloud sync from this point.
    source: 'learned',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATS template seeding (Phase AE.2)
// ─────────────────────────────────────────────────────────────────────────────

import type { AtsTemplate } from './ats-templates';

/**
 * Build a synthetic FormFingerprint from an ATS template. Each template field
 * — and each of its `aliases` — becomes a separate FingerprintFieldEntry with
 * the same canonicalKey, so cosmetic label variants across employers all hit.
 *
 * The structural hash is computed from the template's field list. It may not
 * match any specific employer's exact field order, but Step 1.6 looks up
 * individual nameHashes anyway — the per-field cache survives a structural-
 * hash miss because the matcher's `findFingerprintEntry` is by-name only.
 *
 * Confidence: 0.95 on every entry, slightly below user-confirmed (1.0) so the
 * merge logic always prefers a real correction over a templated guess.
 *
 * @param now Optional timestamp injection for deterministic tests.
 */
export function fingerprintFromTemplate(
  t: AtsTemplate,
  now: number = Date.now(),
): FormFingerprint {
  const entries: FingerprintFieldEntry[] = [];
  const seen = new Set<string>();

  for (const field of t.fields) {
    const allLabels = [field.label, ...(field.aliases ?? [])];
    for (const label of allLabels) {
      const hashed = nameHash(label);
      if (!hashed) continue;
      // De-duplicate: if two labels normalize to the same hash, take the first.
      if (seen.has(hashed)) continue;
      seen.add(hashed);
      entries.push({
        nameHash:     hashed,
        role:         field.role,
        canonicalKey: field.canonicalKey,
        confidence:   0.95,
        learnedAt:    now,
        useCount:     0,         // template seeds start at 0 — a real fill bumps to 1
      });
    }
  }

  // Structural hash derived from the field list (label-only, so it's stable
  // across template-version-1 lifetime). Different template versions produce
  // different hashes so old fingerprints don't collide with new ones.
  const structuralHash = djb2(
    JSON.stringify(t.fields.map(f => ({ l: nameHash(f.label), r: f.role })))
  );

  return {
    key: `${t.atsId}::${structuralHash}`,
    atsId: t.atsId,
    structuralHash,
    exemplarUrl: `template:${t.atsId}@v${t.version}`,
    fields: entries,
    createdAt: now,
    lastUsedAt: now,
    useCount: 0,
    source: 'template',
  };
}
