/**
 * Cache 3 — Option-resolution cache.
 *
 * Maps a dropdown's option SET + the user's profile value → the option text
 * that was ultimately chosen (by exact match, alias, embedding, or a prior
 * successful fill). Keyed by a hash of the sorted option texts so it's
 * SITE-INDEPENDENT: two different portals that render the same country list
 * share the same cache entry.
 *
 * Why this exists:
 *   • Large dropdowns (country pickers, 200 options) skip the embedding
 *     fallback for performance. Once any strategy resolves an option, we
 *     cache it so the next visit is an instant exact hit — no re-embedding,
 *     no re-matching, no FILL_FAILED.
 *   • Independent of the profile: keyed by the user VALUE, so changing an
 *     unrelated profile entry never invalidates these. If the user changes
 *     their country, we simply look up the new value (and may cache a new
 *     resolution). No version bumping needed.
 *
 * Storage: chrome.storage.local (persists across sessions, ~10 MB budget;
 * each entry is ~100 bytes so this scales to tens of thousands of entries).
 */

import { STORAGE_KEYS } from '@shared/types';

const KEY = STORAGE_KEYS.OPTION_RESOLUTION_CACHE;

type ResolutionMap = Record<string, string>;

/** djb2 hash of the normalized, sorted option texts. Order-independent. */
function hashOptions(optionTexts: string[]): string {
  const joined = optionTexts
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash) ^ joined.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(16);
}

function entryKey(optionTexts: string[], userValue: string): string {
  return `${hashOptions(optionTexts)}::${userValue.trim().toLowerCase()}`;
}

/**
 * Look up the previously-chosen option text for this (option-set, value).
 * Returns null on miss or any storage error.
 */
export async function getResolvedOption(
  optionTexts: string[],
  userValue: string,
): Promise<string | null> {
  if (!optionTexts.length || !userValue.trim()) return null;
  try {
    const stored = await chrome.storage.local.get(KEY);
    const map = stored[KEY] as ResolutionMap | undefined;
    if (!map) return null;
    return map[entryKey(optionTexts, userValue)] ?? null;
  } catch {
    return null;
  }
}

/**
 * Record that `chosenOptionText` was the right option for this
 * (option-set, value). Fire-and-forget; failures are swallowed.
 */
export async function setResolvedOption(
  optionTexts: string[],
  userValue: string,
  chosenOptionText: string,
): Promise<void> {
  if (!optionTexts.length || !userValue.trim() || !chosenOptionText.trim()) return;
  try {
    const stored = await chrome.storage.local.get(KEY);
    const map = (stored[KEY] as ResolutionMap | undefined) ?? {};
    map[entryKey(optionTexts, userValue)] = chosenOptionText;
    await chrome.storage.local.set({ [KEY]: map });
  } catch {
    /* storage unavailable — non-fatal, we just re-resolve next time */
  }
}
