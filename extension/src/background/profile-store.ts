import type { ProfileEntry, Profile, SyncQueueItem } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';
import { validateLearnedValue } from '../content-script/value-validation';

const EMPTY_PROFILE: Profile = { entries: [], version: 0, last_sync: 0 };

// ── Core storage helpers ──────────────────────────────────────────────────────

async function readProfile(): Promise<Profile> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
  return (r[STORAGE_KEYS.PROFILE] as Profile | undefined) ?? { ...EMPTY_PROFILE };
}

async function writeProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: profile });
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getAllEntries(): Promise<ProfileEntry[]> {
  return (await readProfile()).entries;
}

export async function getEntryById(id: string): Promise<ProfileEntry | undefined> {
  const entries = await getAllEntries();
  return entries.find(e => e.id === id);
}

export async function getEntryByKey(canonicalKey: string): Promise<ProfileEntry | undefined> {
  const entries = await getAllEntries();
  return entries.find(e => e.canonical_key === canonicalKey);
}

// ── Writes ────────────────────────────────────────────────────────────────────

export type NewEntryData = Omit<ProfileEntry, 'id' | 'userId' | 'created_at' | 'updated_at' | 'use_count' | 'last_used' | 'priority'>;

export async function addEntry(data: NewEntryData, userId = ''): Promise<ProfileEntry> {
  const profile = await readProfile();

  const siblings = profile.entries.filter(e => e.canonical_key === data.canonical_key);
  const nextPriority = siblings.length > 0
    ? Math.max(...siblings.map(e => (e.priority ?? 0))) + 1
    : 0;

  const entry: ProfileEntry = {
    ...data,
    id: crypto.randomUUID(),
    userId,
    priority: nextPriority,
    created_at: Date.now(),
    updated_at: Date.now(),
    use_count: 0,
  };

  profile.entries.push(entry);
  await writeProfile(profile);

  // Embeddings are local-only — never sync them
  const { embedding: _emb, ...syncData } = entry;
  await enqueue({ op: 'add', entryId: entry.id, data: syncData, timestamp: Date.now() });

  return entry;
}

export type EntryPatch = Partial<Pick<ProfileEntry,
  'value' | 'display_label' | 'aliases' | 'category' | 'sensitive' | 'embedding' | 'priority'>>;

export async function updateEntry(id: string, patch: EntryPatch): Promise<ProfileEntry | null> {
  const profile = await readProfile();
  const idx = profile.entries.findIndex(e => e.id === id);
  if (idx === -1) return null;

  profile.entries[idx] = { ...profile.entries[idx], ...patch, updated_at: Date.now() };
  await writeProfile(profile);

  // Only enqueue if there's something cloud-relevant to sync (not just embedding)
  const { embedding: _emb, ...syncPatch } = patch;
  if (Object.keys(syncPatch).length > 0) {
    await enqueue({ op: 'update', entryId: id, data: syncPatch, timestamp: Date.now() });
  }

  return profile.entries[idx];
}

export async function deleteEntry(id: string): Promise<boolean> {
  const profile = await readProfile();
  const before = profile.entries.length;
  profile.entries = profile.entries.filter(e => e.id !== id);
  if (profile.entries.length === before) return false;

  await writeProfile(profile);
  await enqueue({ op: 'delete', entryId: id, timestamp: Date.now() });
  return true;
}

export async function recordUse(id: string): Promise<void> {
  const profile = await readProfile();
  const entry = profile.entries.find(e => e.id === id);
  if (!entry) return;
  entry.use_count = (entry.use_count ?? 0) + 1;
  entry.last_used = Date.now();
  // Use count is local-only — no sync
  await writeProfile(profile);
}

// ── Multi-value helpers ──────────────────────────────────────────────────────

const MAX_ALTERNATIVES = 5;

export async function getEntriesByKey(canonicalKey: string): Promise<ProfileEntry[]> {
  const entries = await getAllEntries();
  return entries
    .filter(e => e.canonical_key === canonicalKey)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

export async function getDefaultEntryByKey(canonicalKey: string): Promise<ProfileEntry | undefined> {
  const sorted = await getEntriesByKey(canonicalKey);
  return sorted[0];
}

export async function countByKey(canonicalKey: string): Promise<number> {
  const entries = await getAllEntries();
  return entries.filter(e => e.canonical_key === canonicalKey).length;
}

export async function hasDuplicateValue(canonicalKey: string, value: string): Promise<boolean> {
  const entries = await getAllEntries();
  const normalized = value.trim().toLowerCase();
  return entries.some(
    e => e.canonical_key === canonicalKey && e.value.trim().toLowerCase() === normalized,
  );
}

export async function setAsDefault(entryId: string): Promise<void> {
  const profile = await readProfile();
  const target = profile.entries.find(e => e.id === entryId);
  if (!target) return;

  const siblings = profile.entries.filter(
    e => e.canonical_key === target.canonical_key && e.id !== entryId,
  );
  for (const s of siblings) {
    if ((s.priority ?? 0) <= (target.priority ?? 0)) {
      s.priority = (s.priority ?? 0) + 1;
    }
  }
  target.priority = 0;
  target.updated_at = Date.now();
  await writeProfile(profile);
}

export function getMaxAlternatives(): number {
  return MAX_ALTERNATIVES;
}

/** Replace the entire local profile (used by cloud sync pull). */
export async function replaceAll(entries: ProfileEntry[]): Promise<void> {
  await writeProfile({ entries, version: 0, last_sync: Date.now() });
}

export async function clearAll(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: { ...EMPTY_PROFILE } });
}

// ── Self-heal ───────────────────────────────────────────────────────────────
//
// Earlier builds (before learn-time validation) saved corrupted values into
// the profile — e.g. country = "243839892002" (concatenated calling codes) and
// junk canonical keys like "question_36872262002[]" from mis-learned EEO
// checkbox groups. Those entries now block legitimate fills: a corrupt
// `country` value makes the matcher treat the country field as UNKNOWN.
//
// healProfile() purges them. Run on every GET_PROFILE so a polluted profile
// self-cleans on the next page load. Only writes when something changed.

/** Canonical keys that are never legitimate user data (mis-learned form field names). */
const JUNK_CANONICAL_RE = /\[\]|^question_|^field[_-]?\d/i;

/** A display label that reads like a form QUESTION — these were mis-learned as
 *  profile attributes before the qa-cache routing existed (e.g. an "Available
 *  to join (in days)" answer stored as a fake attribute). Purge learned ones. */
function looksLikeQuestionLabel(label: string): boolean {
  const t = (label || '').trim();
  if (!t) return false;
  if (/\?/.test(t)) return true;
  if (/\b(are|do|does|did|have|has|will|would|can|could|should|how|what|why|when|which)\b/i.test(t)
      && /\byou\b/i.test(t)) return true;
  return t.split(/\s+/).length > 5;
}

/** Canonical keys whose values are legitimately long digit strings — exempt from the numeric-garbage check. */
const NUMERIC_OK = new Set([
  'phone_number', 'phone_country_code', 'zip_code',
  'graduation_year', 'years_of_experience', 'gpa', 'date_of_birth',
]);

export async function healProfile(): Promise<{ removed: number; kept: number }> {
  const profile = await readProfile();
  const before = profile.entries.length;

  const kept = profile.entries.filter(e => {
    // 1. Junk canonical key (mis-learned checkbox/radio group)
    if (JUNK_CANONICAL_RE.test(e.canonical_key)) return false;
    // 2. Long pure-digit value under a non-numeric key → control-ID garbage
    if (!NUMERIC_OK.has(e.canonical_key) && /^\+?\d{6,}$/.test((e.value ?? '').trim())) return false;
    // 3. Learned entry whose label reads like a form question — these were
    //    mis-learned before qa-cache routing existed (e.g. "Available to
    //    join (in days)" → "35 days"). Questions belong in qa-cache, not the
    //    profile. Only purge `learned` ones so manual entries are never touched.
    if (e.source === 'learned' && looksLikeQuestionLabel(e.display_label)) return false;
    // 4. Fails shape validation for its canonical key (e.g. country that
    //    doesn't resolve, malformed email)
    if (!validateLearnedValue(e.canonical_key, e.value ?? '')) return false;
    return true;
  });

  const removed = before - kept.length;
  if (removed > 0) {
    profile.entries = kept;
    await writeProfile(profile);
  }
  return { removed, kept: kept.length };
}

// ── Sync queue ────────────────────────────────────────────────────────────────

async function enqueue(item: SyncQueueItem): Promise<void> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SYNC_QUEUE);
  const queue = (r[STORAGE_KEYS.SYNC_QUEUE] as SyncQueueItem[] | undefined) ?? [];
  queue.push(item);
  await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_QUEUE]: queue });
}

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SYNC_QUEUE);
  return (r[STORAGE_KEYS.SYNC_QUEUE] as SyncQueueItem[] | undefined) ?? [];
}

export async function clearSyncQueue(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.SYNC_QUEUE);
}
