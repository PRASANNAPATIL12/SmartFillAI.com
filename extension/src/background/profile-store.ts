import type { ProfileEntry, Profile, SyncQueueItem } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';

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

export type NewEntryData = Omit<ProfileEntry, 'id' | 'userId' | 'created_at' | 'updated_at' | 'use_count' | 'last_used'>;

export async function addEntry(data: NewEntryData): Promise<ProfileEntry> {
  const profile = await readProfile();

  const entry: ProfileEntry = {
    ...data,
    id: crypto.randomUUID(),
    userId: '',
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
  'value' | 'display_label' | 'aliases' | 'category' | 'sensitive' | 'embedding'>>;

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

/** Replace the entire local profile (used by cloud sync pull). */
export async function replaceAll(entries: ProfileEntry[]): Promise<void> {
  await writeProfile({ entries, version: 0, last_sync: Date.now() });
}

export async function clearAll(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: { ...EMPTY_PROFILE } });
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
