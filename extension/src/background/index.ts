import type { MessageType, ProfileEntry, DocumentType, StoredDocument } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';
import { inferCanonicalKey, inferCategory, inferDisplayLabel, normalizeFieldValue, type SerializableFieldSig } from './field-learner';
import {
  signIn,
  signOut,
  getSession,
  getCurrentUserId,
  refreshSessionIfNeeded,
} from './auth-manager';
import { pushSyncQueue, pullFromCloud } from './sync-engine';
import { parseResumeText, parseResumePdf, createEntriesFromResume } from './resume-parser';
import { generateEssay } from './essay-generator';
import { classifyFields, type FieldClassifySpec } from './llm-classifier';
import {
  AIProviderFactory,
  setAPIKey,
  setProviderConfig,
  getTotalCost,
  getCostByProvider,
  getMonthlyCost,
} from '@/ai-providers';
import { ENV_GROQ_API_KEY } from '@/ai-providers/env';
import {
  getAllEntries,
  getEntryById,
  addEntry,
  updateEntry,
  deleteEntry,
  recordUse,
  replaceAll,
  type NewEntryData,
  type EntryPatch,
} from './profile-store';
import { getSettings, updateSettings } from './settings-store';
import { computeEmbedding, warmUp } from '@/ml/embedder';
import { entryEmbedText, matchByEmbedding } from '@/ml/step5';
import {
  setEmbedding,
  setFieldCacheEntry,
  loadFieldCacheForDomain,
  incrementCacheUse,
  evictStaleCacheEntries,
  type FieldCacheEntry,
  saveDocument,
  getDocumentMeta,
  getDocumentBytes,
  getAllDocumentMetas,
  getDefaultDocument,
  deleteDocument,
  updateDocumentMeta,
} from '@/storage/idb';

// ── Alarm names ───────────────────────────────────────────────────────────────

const SYNC_ALARM      = 'ditto_sync';
const KEEPALIVE_ALARM = 'ditto_keepalive';

// ── Alarm setup ───────────────────────────────────────────────────────────────
// Called on both install/update AND browser startup so alarms are always present.
// chrome.alarms.create is idempotent when the alarm already exists, but we check
// first to avoid resetting the next-fire time on every SW wake.

async function ensureAlarms(): Promise<void> {
  const [sync, keepalive] = await Promise.all([
    chrome.alarms.get(SYNC_ALARM),
    chrome.alarms.get(KEEPALIVE_ALARM),
  ]);
  if (!sync)      chrome.alarms.create(SYNC_ALARM,      { periodInMinutes: 5 });
  if (!keepalive) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Seed GROQ key from build-time env var (dev convenience; user can override in settings)
    if (ENV_GROQ_API_KEY) {
      setAPIKey('groq', ENV_GROQ_API_KEY).then(() =>
        setProviderConfig({ provider: 'groq', fallbackProvider: 'gemini' })
      );
    }
    // Pre-warm embedder on first install so model is cached before first form fill
    warmUp().catch(() => {});
  }

  ensureAlarms().catch(() => {});
});

// Recreate alarms after a browser restart — onInstalled does not fire then.
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms().catch(() => {});
});

// ── Alarm handler ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Waking the SW is the goal — no work needed.
    return;
  }
  if (alarm.name === SYNC_ALARM) {
    evictStaleCacheEntries().catch(() => {});
    refreshSessionIfNeeded().catch(() => {});
    // Push pending local changes to Supabase when cloud sync is enabled
    getSettings().then(s => {
      if (s.cloudSync) pushSyncQueue().catch(() => {});
    }).catch(() => {});
  }
});

// ── Profile CS-cache refresh ──────────────────────────────────────────────────
// Keeps the content-script's SW-dormancy fallback (STORAGE_KEYS.PROFILE_CS_CACHE)
// in sync with the authoritative profile store whenever a mutation occurs.
// Without this, popup-initiated edits (add/update/delete) are invisible to the
// CS cache, so a page refresh while the SW is dormant fills with stale values.

async function refreshCSCache(): Promise<void> {
  const entries = await getAllEntries();
  await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE_CS_CACHE]: entries });
}

// ── Documents meta cache refresh ─────────────────────────────────────────────
// Same pattern as refreshCSCache — keeps metadata (no file bytes) in
// chrome.storage.local so the content script can check document availability
// even when the SW is dormant.

async function refreshDocumentsMetaCache(): Promise<void> {
  const metas = await getAllDocumentMetas();
  await chrome.storage.local.set({ [STORAGE_KEYS.DOCUMENTS_META_CACHE]: metas });
}

// ── Message router ────────────────────────────────────────────────────────────

type HandlerFn = (
  payload: unknown,
  sender: chrome.runtime.MessageSender
) => Promise<unknown> | unknown;

const handlers: Partial<Record<MessageType, HandlerFn>> = {

  // ── Health ─────────────────────────────────────────────────────────────────

  PING: () => ({ ok: true }),

  GET_PROVIDER: async () => {
    const p = await AIProviderFactory.getProvider();
    return { name: p.name, displayName: p.displayName };
  },

  // ── Profile CRUD ───────────────────────────────────────────────────────────

  GET_PROFILE: async () => {
    return getAllEntries();
  },

  ADD_ENTRY: async (payload) => {
    const data    = payload as NewEntryData;
    const userId  = (await getCurrentUserId()) ?? '';
    const created = await addEntry(data, userId);
    embedEntry(created).catch(() => {});
    refreshCSCache().catch(() => {});
    return created;
  },

  UPDATE_ENTRY: async (payload) => {
    const { id, patch } = payload as { id: string; patch: EntryPatch };
    const updated = await updateEntry(id, patch);
    if (!updated) throw new Error(`Entry not found: ${id}`);
    if (patch.value || patch.display_label || patch.aliases) {
      embedEntry(updated).catch(() => {});
    }
    refreshCSCache().catch(() => {});
    return updated;
  },

  DELETE_ENTRY: async (payload) => {
    const { id } = payload as { id: string };
    const ok = await deleteEntry(id);
    refreshCSCache().catch(() => {});
    return ok;
  },

  RECORD_USE: async (payload) => {
    const { id } = payload as { id: string };
    await recordUse(id);
    return getEntryById(id);
  },

  UPDATE_PROFILE: async (payload) => {
    // Bulk replace — used by the sync engine after a successful cloud pull
    const { entries } = payload as { entries: ProfileEntry[] };
    await replaceAll(entries);
    refreshCSCache().catch(() => {});
    return { ok: true };
  },

  // ── Settings ───────────────────────────────────────────────────────────────

  GET_SETTINGS: async () => {
    return getSettings();
  },

  UPDATE_SETTINGS: async (payload) => {
    return updateSettings(payload as Parameters<typeof updateSettings>[0]);
  },

  // ── AI cost ────────────────────────────────────────────────────────────────

  GET_AI_COST: async () => {
    const [monthly, total, byProvider] = await Promise.all([
      getMonthlyCost(),
      getTotalCost(),
      getCostByProvider(),
    ]);
    return { monthly, total, byProvider };
  },

  // ── Field cache ────────────────────────────────────────────────────────────

  GET_FIELD_CACHE: async (payload) => {
    const { domain } = payload as { domain: string };
    const cacheMap = await loadFieldCacheForDomain(domain);
    // Convert Map → plain object for serialisation across the message channel
    const result: Record<string, FieldCacheEntry> = {};
    for (const [key, val] of cacheMap) result[key] = val;
    return result;
  },

  INCREMENT_CACHE_USE: async (payload) => {
    const { fingerprint } = payload as { fingerprint: string };
    await incrementCacheUse(fingerprint);
    return { ok: true };
  },

  // ── ML / Step 5 ────────────────────────────────────────────────────────────

  STEP5_MATCH: async (payload) => {
    const { fieldText } = payload as { fieldText: string };
    const profile = await getAllEntries();
    return matchByEmbedding(fieldText, profile);
  },

  CACHE_FIELD_MATCH: async (payload) => {
    const { fingerprint, profileEntryId, confidence } = payload as {
      fingerprint: string;
      profileEntryId: string;
      confidence: number;
    };
    await setFieldCacheEntry({
      fingerprint,
      profileEntryId,
      confidence,
      useCount: 1,
      lastUsed: Date.now(),
    });
    return { ok: true };
  },

  COMPUTE_EMBEDDINGS: async () => {
    const entries = await getAllEntries();
    let computed = 0;
    for (const entry of entries) {
      try {
        await embedEntry(entry);
        computed++;
      } catch {
        // skip entries that fail
      }
    }
    return { computed, total: entries.length };
  },

  // ── Deferred stubs (Tasks 4–8) ─────────────────────────────────────────────

  STEP6_CLASSIFY: async (payload) => {
    const { fieldTexts } = payload as { fieldTexts: string[] };
    if (!Array.isArray(fieldTexts) || fieldTexts.length === 0) return [];
    const specs: FieldClassifySpec[] = fieldTexts.map((t, i) => ({ fieldIndex: i, fieldText: t }));
    return classifyFields(specs);
  },

  MATCH_FIELDS: () => {
    throw new Error('MATCH_FIELDS is handled in the content script (Task 4.1)');
  },

  LEARN_FIELD: async (payload) => {
    const { sig, value } = payload as { sig: SerializableFieldSig; value: string };

    const inferred = inferCanonicalKey(sig);
    if (inferred === '') throw new Error('Sensitive field — will not learn this value');

    // STEP 7.3 — Defensive value-length cap. A textarea that snuck through
    // the matcher's essay-detector shouldn't be saved as a profile field;
    // anything > 500 chars is almost certainly the wrong target.
    const trimmed = value.length > 500 ? value.slice(0, 500) : value;

    const canonicalKey = inferred ?? sig.name ?? sig.id ?? 'custom_field';
    // Normalize country values: strip emoji flags and calling-code suffixes,
    // resolve to canonical country name ("🇮🇳 India +91" → "India").
    const normalizedTrimmed = normalizeFieldValue(canonicalKey, trimmed);
    const category     = inferCategory(canonicalKey);
    const displayLabel = inferDisplayLabel(sig);
    const userId       = (await getCurrentUserId()) ?? '';

    // STEP 7.1 — Duplicate prevention. If the profile already has an entry
    // with this canonical_key, UPDATE its value instead of creating a second
    // entry. This is the proper "change of mind" handling — user picks
    // "India" then later "United States" for the same Country field should
    // result in ONE entry, not two.
    const existing = (await getAllEntries()).find(e => e.canonical_key === canonicalKey);
    if (existing) {
      if (existing.value === normalizedTrimmed) return existing; // no-op
      const updated = await updateEntry(existing.id, { value: normalizedTrimmed });
      if (updated) {
        embedEntry(updated).catch(() => {});
        refreshCSCache().catch(() => {});
        return updated;
      }
      // Fall through to create only if update somehow failed
    }

    const data: NewEntryData = {
      canonical_key: canonicalKey,
      display_label: displayLabel,
      aliases:       [],
      value:         normalizedTrimmed,
      category,
      source:        'learned',
      sensitive:     false,
    };

    const created = await addEntry(data, userId);
    embedEntry(created).catch(() => {});
    refreshCSCache().catch(() => {});
    return created;
  },

  // ── Auth (Task 6.1) ────────────────────────────────────────────────────────

  SIGN_IN: async (payload) => {
    const { email, password } = payload as { email: string; password: string };
    const session = await signIn(email, password);
    // Pull cloud entries on successful login
    pullFromCloud().catch(() => {});
    return { userId: session.userId, email: session.email };
  },

  SIGN_OUT: async () => {
    await signOut();
    return { ok: true };
  },

  GET_SESSION: async () => {
    const session = await getSession();
    if (!session) return null;
    // Never expose tokens to popup — return only display info
    return { userId: session.userId, email: session.email, expiresAt: session.expiresAt };
  },

  GENERATE_ESSAY: async (payload) => {
    const { question, domain } = payload as { question: string; domain: string };
    if (!question?.trim()) throw new Error('Question text is required');
    const essay = await generateEssay(question, domain);
    return { essay };
  },

  PARSE_RESUME: async (payload) => {
    const { text, pdfBase64 } = payload as { text?: string; pdfBase64?: string };
    if (!text && !pdfBase64) throw new Error('Either text or pdfBase64 is required');

    const parsed   = pdfBase64 ? await parseResumePdf(pdfBase64) : await parseResumeText(text!);
    const userId   = (await getCurrentUserId()) ?? '';
    const entries  = await createEntriesFromResume(parsed, userId);
    return { entries, parsed };
  },

  SYNC_NOW: async () => {
    const [push, pull] = await Promise.all([pushSyncQueue(), pullFromCloud()]);
    return { pushed: push.pushed, failed: push.failed, pulled: pull.pulled };
  },

  // ── Documents ────────────────────────────────────────────────────────────────

  GET_DOCUMENTS: async () => {
    return getAllDocumentMetas();
  },

  GET_DOCUMENT_BYTES: async (payload) => {
    const { id } = payload as { id: string };
    const bytes = await getDocumentBytes(id);
    if (!bytes) throw new Error('Document not found');
    const binary = new Uint8Array(bytes);
    let str = '';
    for (let i = 0; i < binary.length; i++) str += String.fromCharCode(binary[i]);
    return { base64: btoa(str) };
  },

  UPLOAD_DOCUMENT: async (payload) => {
    const { docType, label, fileName, mimeType, fileDataBase64 } = payload as {
      docType: DocumentType; label: string; fileName: string;
      mimeType: string; fileDataBase64: string;
    };
    const userId = (await getCurrentUserId()) ?? '';

    const binary = atob(fileDataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bytes.length > 10 * 1024 * 1024) throw new Error('File exceeds 10 MB limit');

    // Un-default any existing doc of the same type
    const existing = await getAllDocumentMetas();
    for (const other of existing) {
      if (other.docType === docType && other.isDefault) {
        await updateDocumentMeta(other.id, { isDefault: false });
      }
    }

    let extractedText: string | null = null;

    // Auto-parse resume PDFs to update profile entries
    if (docType === 'resume') {
      try {
        if (mimeType === 'application/pdf') {
          const parsed = await parseResumePdf(fileDataBase64);
          extractedText = JSON.stringify(parsed);
          await createEntriesFromResume(parsed, userId);
          refreshCSCache().catch(() => {});
        } else if (mimeType === 'text/plain') {
          const text = new TextDecoder().decode(bytes);
          const parsed = await parseResumeText(text);
          extractedText = text;
          await createEntriesFromResume(parsed, userId);
          refreshCSCache().catch(() => {});
        }
      } catch {
        // Parse failure shouldn't block document storage
      }
    }

    const doc: StoredDocument = {
      id: crypto.randomUUID(),
      userId,
      docType,
      label,
      fileName,
      mimeType,
      fileSize: bytes.length,
      fileData: bytes.buffer as ArrayBuffer,
      extractedText,
      isDefault: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveDocument(doc);
    refreshDocumentsMetaCache().catch(() => {});

    const { fileData: _, ...meta } = doc;
    return meta;
  },

  UPDATE_DOCUMENT_META: async (payload) => {
    const { id, patch } = payload as { id: string; patch: { label?: string; isDefault?: boolean } };
    if (patch.isDefault) {
      const doc = await getDocumentMeta(id);
      if (doc) {
        const all = await getAllDocumentMetas();
        for (const other of all) {
          if (other.docType === doc.docType && other.id !== id && other.isDefault) {
            await updateDocumentMeta(other.id, { isDefault: false });
          }
        }
      }
    }
    const updated = await updateDocumentMeta(id, patch);
    refreshDocumentsMetaCache().catch(() => {});
    return updated;
  },

  REPLACE_DOCUMENT_FILE: async (payload) => {
    const { id, fileName, mimeType, fileDataBase64 } = payload as {
      id: string; fileName: string; mimeType: string; fileDataBase64: string;
    };
    const userId = (await getCurrentUserId()) ?? '';

    const binary = atob(fileDataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bytes.length > 10 * 1024 * 1024) throw new Error('File exceeds 10 MB limit');

    const existing = await getDefaultDocument(
      (await getDocumentMeta(id))?.docType ?? 'resume'
    );
    if (!existing) throw new Error('Document not found');

    let extractedText: string | null = null;
    if (existing.docType === 'resume') {
      try {
        if (mimeType === 'application/pdf') {
          const parsed = await parseResumePdf(fileDataBase64);
          extractedText = JSON.stringify(parsed);
          await createEntriesFromResume(parsed, userId);
          refreshCSCache().catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    await saveDocument({
      ...existing,
      fileName,
      mimeType,
      fileSize: bytes.length,
      fileData: bytes.buffer as ArrayBuffer,
      extractedText: extractedText ?? existing.extractedText,
      updatedAt: Date.now(),
    });
    refreshDocumentsMetaCache().catch(() => {});

    return getDocumentMeta(id);
  },

  DELETE_DOCUMENT: async (payload) => {
    const { id } = payload as { id: string };
    await deleteDocument(id);
    refreshDocumentsMetaCache().catch(() => {});
    return { ok: true };
  },

  GET_DEFAULT_DOCUMENT: async (payload) => {
    const { docType } = payload as { docType: DocumentType };
    const doc = await getDefaultDocument(docType);
    if (!doc) return null;
    const { fileData: _, ...meta } = doc;
    return meta;
  },

  FILL_FIELD: () => {
    throw new Error('FILL_FIELD is handled in the content script (Task 4.3)');
  },

  FILL_ALL: () => {
    throw new Error('FILL_ALL is handled in the content script (Task 4.3)');
  },
};

// ── Embedding helper ──────────────────────────────────────────────────────────

async function embedEntry(entry: ProfileEntry): Promise<void> {
  const text = entryEmbedText(entry);
  const vector = await computeEmbedding(text);
  await setEmbedding(entry.id, vector);
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((
  message: { type: MessageType; payload?: unknown },
  sender,
  sendResponse
) => {
  const handler = handlers[message.type];

  if (!handler) {
    sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
    return false;
  }

  Promise.resolve(handler(message.payload ?? null, sender))
    .then(data => sendResponse({ success: true, data }))
    .catch(err => sendResponse({ success: false, error: String(err) }));

  return true; // keep the message channel open for the async response
});
