/**
 * Waterfall Step 5 — Semantic embedding match.
 *
 * When Steps 1-4 (deterministic rules) return UNKNOWN, Step 5 computes a
 * MiniLM sentence embedding for the field's combined text signal and
 * compares it against stored embeddings for each profile entry.
 *
 * We embed what each profile entry REPRESENTS (canonical key + label + aliases),
 * not its raw value. This means "email_address Email Address work email" will
 * match field text like "Your work email" or "Contact email" even if the field
 * doesn't use standard naming.
 *
 * Threshold: 0.75 (tuned for MiniLM-L6-v2 on form field descriptions).
 * Fields below this threshold remain UNKNOWN and fall through to Step 6 (LLM).
 */

import type { ProfileEntry } from '@shared/types';
import { getAllEmbeddings } from '@/storage/idb';
import { computeEmbedding, cosineSimilarity } from './embedder';

export const STEP5_THRESHOLD = 0.75;

export interface Step5Result {
  profileEntryId: string;
  confidence: number;
}

/**
 * Run Step 5 matching for a single field.
 * @param fieldText  Combined label + placeholder + name + id text from the field
 * @param profile    Current profile entries (needed to filter by existing IDs)
 * @returns Best match above threshold, or null
 */
export async function matchByEmbedding(
  fieldText: string,
  profile: ProfileEntry[]
): Promise<Step5Result | null> {
  if (!fieldText.trim() || profile.length === 0) return null;

  const activeIds = new Set(profile.map(e => e.id));
  const [fieldVec, allEmbeddings] = await Promise.all([
    computeEmbedding(fieldText),
    getAllEmbeddings(),
  ]);

  let bestId   = '';
  let bestSim  = -1;

  for (const stored of allEmbeddings) {
    if (!activeIds.has(stored.entryId)) continue; // orphaned embedding
    const sim = cosineSimilarity(fieldVec, stored.vector);
    if (sim > bestSim) {
      bestSim = sim;
      bestId  = stored.entryId;
    }
  }

  if (bestSim < STEP5_THRESHOLD || !bestId) return null;

  return { profileEntryId: bestId, confidence: Math.round(bestSim * 1000) / 1000 };
}

/**
 * Compute the text to embed for a profile entry.
 * Combines canonical key (underscores → spaces), display label, and aliases.
 */
export function entryEmbedText(entry: ProfileEntry): string {
  const parts = [
    entry.canonical_key.replace(/_/g, ' '),
    entry.display_label,
    ...entry.aliases,
  ];
  return [...new Set(parts.filter(Boolean))].join(' ');
}

/**
 * Compute the text to embed for a field signature.
 * Normalises name/id separators so "first_name" and "first-name" look the same.
 */
export function fieldEmbedText(sig: {
  label: string;
  placeholder: string;
  ariaLabel: string;
  name: string;
  id: string;
}): string {
  return [
    sig.label,
    sig.placeholder,
    sig.ariaLabel,
    sig.name.replace(/[-_]/g, ' '),
    sig.id.replace(/[-_]/g, ' '),
  ]
    .filter(Boolean)
    .join(' ');
}
