/**
 * IndexedDB wrapper — two object stores:
 *   field_cache  : domain-fingerprint → FieldCacheEntry   (field match cache)
 *   embeddings   : profileEntryId     → Float32Array      (MiniLM vectors)
 *
 * Uses the raw IDBDatabase API (no extra library) because the extension
 * ships no runtime deps beyond the AI SDKs.
 */

import type { FieldCacheEntry } from '@shared/types';

export type { FieldCacheEntry };

const DB_NAME = 'ditto_v1';
const DB_VERSION = 1;
const STORE_FIELD_CACHE = 'field_cache';
const STORE_EMBEDDINGS  = 'embeddings';

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_FIELD_CACHE)) {
        const store = db.createObjectStore(STORE_FIELD_CACHE, { keyPath: 'fingerprint' });
        store.createIndex('lastUsed', 'lastUsed');
      }

      if (!db.objectStoreNames.contains(STORE_EMBEDDINGS)) {
        db.createObjectStore(STORE_EMBEDDINGS, { keyPath: 'entryId' });
      }
    };

    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
      // Re-open on unexpected close (e.g. schema change by another tab)
      _db.onclose = () => { _db = null; };
      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror   = () => reject(req.error);
  }));
}

function idbPut<T>(store: string, value: T): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

function idbGetAll<T>(store: string): Promise<T[]> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror   = () => reject(req.error);
  }));
}

// ── Field cache ───────────────────────────────────────────────────────────────
// FieldCacheEntry is imported from @shared/types and re-exported above.

export async function getFieldCacheEntry(fingerprint: string): Promise<FieldCacheEntry | undefined> {
  return idbGet<FieldCacheEntry>(STORE_FIELD_CACHE, fingerprint);
}

export async function setFieldCacheEntry(entry: FieldCacheEntry): Promise<void> {
  return idbPut(STORE_FIELD_CACHE, entry);
}

export async function incrementCacheUse(fingerprint: string): Promise<void> {
  const existing = await getFieldCacheEntry(fingerprint);
  if (!existing) return;
  await setFieldCacheEntry({
    ...existing,
    useCount: existing.useCount + 1,
    lastUsed: Date.now(),
  });
}

// domain is reserved for future scoped filtering; currently loads all entries
// since the cache is typically small (<1000 entries total across all domains)
export async function loadFieldCacheForDomain(_domain: string): Promise<Map<string, FieldCacheEntry>> {
  const all = await idbGetAll<FieldCacheEntry>(STORE_FIELD_CACHE);
  const map = new Map<string, FieldCacheEntry>();
  for (const entry of all) {
    map.set(entry.fingerprint, entry);
  }
  return map;
}

export async function evictStaleCacheEntries(maxAgeMs = 90 * 24 * 60 * 60 * 1000): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const all = await idbGetAll<FieldCacheEntry>(STORE_FIELD_CACHE);
  for (const entry of all) {
    if (entry.lastUsed < cutoff) {
      await idbDelete(STORE_FIELD_CACHE, entry.fingerprint);
    }
  }
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export interface StoredEmbedding {
  entryId: string;
  vector: number[];   // Float32 stored as plain number[] (JSON-serialisable)
  computedAt: number;
}

export async function getEmbedding(entryId: string): Promise<StoredEmbedding | undefined> {
  return idbGet<StoredEmbedding>(STORE_EMBEDDINGS, entryId);
}

export async function setEmbedding(entryId: string, vector: number[]): Promise<void> {
  return idbPut<StoredEmbedding>(STORE_EMBEDDINGS, { entryId, vector, computedAt: Date.now() });
}

export async function deleteEmbedding(entryId: string): Promise<void> {
  return idbDelete(STORE_EMBEDDINGS, entryId);
}

export async function getAllEmbeddings(): Promise<StoredEmbedding[]> {
  return idbGetAll<StoredEmbedding>(STORE_EMBEDDINGS);
}

/** Remove embeddings for entry IDs that no longer exist in the profile. */
export async function pruneOrphanEmbeddings(activeIds: Set<string>): Promise<void> {
  const all = await getAllEmbeddings();
  for (const e of all) {
    if (!activeIds.has(e.entryId)) {
      await idbDelete(STORE_EMBEDDINGS, e.entryId);
    }
  }
}
