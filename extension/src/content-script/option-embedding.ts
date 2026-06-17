/**
 * Phase A.4 — Semantic option selection via local ONNX embeddings.
 *
 * Called by fillSelect / fillCombobox / fillButtonDropdown as the LAST
 * deterministic fallback before marking a field FILL_FAILED. When alias
 * tables and exact / partial text matching all return nothing, we ask the
 * background SW to embed the user's profile value and every visible option,
 * and select the option with the highest cosine similarity above a
 * configurable threshold (default 0.65).
 *
 * Why a fallback (not the first strategy):
 *   • Alias tables are deterministic, free, and microseconds-fast.
 *   • Embedding all options costs ~10 ms per option (local ONNX) — fine for
 *     5–30 option dropdowns; pathological for 200+ country pickers (we skip
 *     those because the alias table already handles them perfectly).
 *
 * Why local-only (no LLM):
 *   • Already in the codebase — `Xenova/all-MiniLM-L6-v2` runs offline.
 *   • Zero network cost.
 *   • Privacy — no form data ever leaves the device.
 *
 * Per-element session cache prevents recomputing on the same dropdown
 * across multiple Fill clicks during one page session.
 */

import { sendToBackground } from './messenger';

/** Skip embedding entirely for dropdowns this big (e.g. country pickers). */
const MAX_OPTIONS_FOR_EMBEDDING = 50;

/** Default cosine similarity floor below which we don't pick anything. */
export const DEFAULT_EMBEDDING_THRESHOLD = 0.65;

interface CachedMatch {
  optionKey: string;             // join of option texts — invalidates if options change
  index: number;
  similarity: number;
}

const cache: WeakMap<HTMLElement, Map<string, CachedMatch>> = new WeakMap();

function cacheKey(userValue: string, threshold: number): string {
  return `${userValue}␟${threshold}`;
}

/**
 * Find the option semantically closest to `userValue` above the threshold.
 *
 * Returns null when:
 *   • optionTexts has 0 entries or > MAX_OPTIONS_FOR_EMBEDDING entries.
 *   • The best match is below threshold.
 *   • The background SW is unavailable or the embedder fails to load.
 *
 * Callers should treat null as "no semantic match — mark FILL_FAILED."
 */
export async function selectOptionByEmbedding(
  hostElement: HTMLElement | undefined,
  userValue: string,
  optionTexts: string[],
  threshold: number = DEFAULT_EMBEDDING_THRESHOLD,
): Promise<{ index: number; similarity: number; optionText: string } | null> {
  if (!userValue) return null;
  if (!Array.isArray(optionTexts) || optionTexts.length === 0) return null;
  if (optionTexts.length > MAX_OPTIONS_FOR_EMBEDDING) return null;

  // Cache lookup
  if (hostElement) {
    let perEl = cache.get(hostElement);
    if (!perEl) {
      perEl = new Map();
      cache.set(hostElement, perEl);
    }
    const key = cacheKey(userValue, threshold);
    const cached = perEl.get(key);
    const fingerprint = optionTexts.join('␟');
    if (cached && cached.optionKey === fingerprint) {
      return {
        index: cached.index,
        similarity: cached.similarity,
        optionText: optionTexts[cached.index],
      };
    }

    try {
      const result = await sendToBackground<
        { index: number; similarity: number; optionText: string } | null
      >('EMBED_OPTION_MATCH', { userValue, optionTexts, threshold });
      if (result && typeof result.index === 'number' && result.index >= 0) {
        perEl.set(key, { optionKey: fingerprint, index: result.index, similarity: result.similarity });
        return result;
      }
      return null;
    } catch {
      return null;
    }
  }

  try {
    const result = await sendToBackground<
      { index: number; similarity: number; optionText: string } | null
    >('EMBED_OPTION_MATCH', { userValue, optionTexts, threshold });
    return result ?? null;
  } catch {
    return null;
  }
}
