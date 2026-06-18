/**
 * IndexedDB wrapper — three object stores:
 *   field_cache  : domain-fingerprint → FieldCacheEntry   (field match cache)
 *   embeddings   : profileEntryId     → Float32Array      (MiniLM vectors)
 *   documents    : id                 → StoredDocument     (file bytes + metadata)
 *
 * Uses the raw IDBDatabase API (no extra library) because the extension
 * ships no runtime deps beyond the AI SDKs.
 */

import type { FieldCacheEntry, DocumentType, StoredDocument, DocumentMeta } from '@shared/types';

export type { FieldCacheEntry };

const DB_NAME = 'ditto_v1';
const DB_VERSION = 3;
const STORE_FIELD_CACHE    = 'field_cache';
const STORE_EMBEDDINGS     = 'embeddings';
const STORE_DOCUMENTS      = 'documents';
const STORE_QA_EMBEDDINGS  = 'qa_embeddings';

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      const oldVersion = e.oldVersion;

      if (oldVersion < 1) {
        const fc = db.createObjectStore(STORE_FIELD_CACHE, { keyPath: 'fingerprint' });
        fc.createIndex('lastUsed', 'lastUsed');
        db.createObjectStore(STORE_EMBEDDINGS, { keyPath: 'entryId' });
      }

      if (oldVersion < 2) {
        const docs = db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'id' });
        docs.createIndex('docType', 'docType', { unique: false });
        docs.createIndex('userId', 'userId', { unique: false });
      }

      if (oldVersion < 3) {
        db.createObjectStore(STORE_QA_EMBEDDINGS, { keyPath: 'question' });
      }
    };

    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result;
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

// ── Documents ─────────────────────────────────────────────────────────────────

function stripFileData(doc: StoredDocument): DocumentMeta {
  const { fileData: _, ...meta } = doc;
  return meta as DocumentMeta;
}

export async function saveDocument(doc: StoredDocument): Promise<void> {
  return idbPut(STORE_DOCUMENTS, doc);
}

export async function getDocumentMeta(id: string): Promise<DocumentMeta | undefined> {
  const doc = await idbGet<StoredDocument>(STORE_DOCUMENTS, id);
  return doc ? stripFileData(doc) : undefined;
}

export async function getDocumentBytes(id: string): Promise<ArrayBuffer | undefined> {
  const doc = await idbGet<StoredDocument>(STORE_DOCUMENTS, id);
  return doc?.fileData;
}

export async function getAllDocumentMetas(): Promise<DocumentMeta[]> {
  const all = await idbGetAll<StoredDocument>(STORE_DOCUMENTS);
  return all.map(stripFileData);
}

export async function getDefaultDocument(docType: DocumentType): Promise<StoredDocument | undefined> {
  const all = await idbGetAll<StoredDocument>(STORE_DOCUMENTS);
  return all.find(d => d.docType === docType && d.isDefault)
      ?? all.find(d => d.docType === docType);
}

export async function deleteDocument(id: string): Promise<void> {
  return idbDelete(STORE_DOCUMENTS, id);
}

export async function updateDocumentMeta(
  id: string,
  patch: Partial<Pick<StoredDocument, 'label' | 'isDefault'>>
): Promise<DocumentMeta | null> {
  const doc = await idbGet<StoredDocument>(STORE_DOCUMENTS, id);
  if (!doc) return null;
  const updated = { ...doc, ...patch, updatedAt: Date.now() };
  await idbPut(STORE_DOCUMENTS, updated);
  return stripFileData(updated);
}

// ── QA Embeddings (fuzzy question matching) ──────────────────────────────────

export interface StoredQAEmbedding {
  question: string;     // normalized question text (the key)
  vector: number[];     // MiniLM embedding of the question
  computedAt: number;
}

export async function saveQaEmbedding(question: string, vector: number[]): Promise<void> {
  return idbPut<StoredQAEmbedding>(STORE_QA_EMBEDDINGS, {
    question, vector, computedAt: Date.now(),
  });
}

export async function getQaEmbedding(question: string): Promise<StoredQAEmbedding | undefined> {
  return idbGet<StoredQAEmbedding>(STORE_QA_EMBEDDINGS, question);
}

export async function getAllQaEmbeddings(): Promise<StoredQAEmbedding[]> {
  return idbGetAll<StoredQAEmbedding>(STORE_QA_EMBEDDINGS);
}

export async function deleteQaEmbedding(question: string): Promise<void> {
  return idbDelete(STORE_QA_EMBEDDINGS, question);
}

export async function clearAllQaEmbeddings(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_QA_EMBEDDINGS, 'readwrite');
    const req = tx.objectStore(STORE_QA_EMBEDDINGS).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
