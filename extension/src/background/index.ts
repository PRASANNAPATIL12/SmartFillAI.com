import type { MessageType, ProfileEntry, DocumentType, StoredDocument } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';
import { inferCanonicalKey, inferCategory, inferDisplayLabel, normalizeFieldValue, type SerializableFieldSig } from './field-learner';
import {
  signIn,
  signUp,
  signOut,
  getSession,
  getCurrentUserId,
  refreshSessionIfNeeded,
} from './auth-manager';
import { pushSyncQueue, pullFromCloud, pushFormFingerprints, pullFormFingerprints } from './sync-engine';
import { parseResumeText, parseResumePdf, createEntriesFromResume } from './resume-parser';
import { generateEssay } from './essay-generator';
import { classifyFields, type FieldClassifySpec } from './llm-classifier';
import { answerField } from './answer-field';
import { generateResumeQA } from './resume-qa-generator';
import { clearLlmAnswers, normalizeQuestion, getRememberedAnswer, rememberAnswer } from '../content-script/qa-cache';
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
  healProfile,
  getEntriesByKey,
  countByKey,
  hasDuplicateValue,
  setAsDefault,
  getMaxAlternatives,
  type NewEntryData,
  type EntryPatch,
} from './profile-store';
import { getSettings, updateSettings } from './settings-store';
import { computeEmbedding, cosineSimilarity, warmUp } from '@/ml/embedder';
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
  saveQaEmbedding,
  getAllQaEmbeddings,
  getFormFingerprint,
  putFormFingerprint,
  bumpFormFingerprintUsage,
} from '@/storage/idb';
import type { FormFingerprint } from '../content-script/form-fingerprinter';
import { fingerprintFromTemplate } from '../content-script/form-fingerprinter';
import { ATS_TEMPLATES, ATS_TEMPLATES_BUNDLE_VERSION } from '../content-script/ats-templates';

// ── Resume Q&A pre-generation ────────────────────────────────────────────────

async function generateAndStoreResumeQA(resumeText: string): Promise<void> {
  const entries = await getAllEntries();
  const pairs = await generateResumeQA(resumeText, entries);
  for (const { question, answer } of pairs) {
    await rememberAnswer(question, answer, 'llm');
    const nq = normalizeQuestion(question);
    if (nq.length >= 6) {
      try {
        const vec = await computeEmbedding(nq);
        await saveQaEmbedding(nq, Array.from(vec));
      } catch { /* embedding model not ready */ }
    }
  }
}

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

// ── Global network-error guard ────────────────────────────────────────────────
// The service worker can wake up before the OS network stack is ready (e.g. on
// browser startup after a reboot). Any fetch() inside Supabase's setSession()
// or the sync engine may throw "TypeError: Failed to fetch". We suppress those
// globally so Chrome's extension error page stays clean. Real logic errors
// (non-network) still surface.
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const msg: string = (event.reason?.message ?? event.reason ?? '').toString();
  if (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('network unreachable') ||
    msg.includes('Load failed')
  ) {
    event.preventDefault();
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Seed GROQ key from build-time env var (dev convenience; user can override in settings)
    if (ENV_GROQ_API_KEY) {
      setAPIKey('groq', ENV_GROQ_API_KEY)
        .then(() => setProviderConfig({ provider: 'groq', fallbackProvider: 'gemini' }))
        .catch(() => {});
    }
    // Pre-warm embedder on first install so model is cached before first form fill
    warmUp().catch(() => {});
  }

  ensureAlarms().catch(() => {});
  // Phase AE.2 — seed ATS templates so first-visit Greenhouse/Workday/Lever
  // forms get day-one auto-fill without waiting for the user to confirm 3+
  // matches. Idempotent: a chrome.storage flag prevents re-seeding within the
  // same bundle version. Runs on both 'install' and 'update' events to pick
  // up version bumps.
  seedAtsTemplatesIfNeeded().catch(() => {});
});

/**
 * Phase AE.2 — write synthetic FormFingerprints derived from ATS_TEMPLATES.
 * Idempotent across multiple calls within the same template-bundle version.
 */
async function seedAtsTemplatesIfNeeded(): Promise<void> {
  const flagKey = `ats_templates_seeded_v${ATS_TEMPLATES_BUNDLE_VERSION}`;
  const stored = await chrome.storage.local.get(flagKey);
  if (stored[flagKey] === true) return;
  for (const template of ATS_TEMPLATES) {
    try {
      const fp = fingerprintFromTemplate(template);
      await putFormFingerprint(fp);
    } catch {
      // Skip individual template failures so one bad entry doesn't block the rest.
    }
  }
  await chrome.storage.local.set({ [flagKey]: true });
}

// Recreate alarms after a browser restart — onInstalled does not fire then.
// Also pull from cloud on startup so data from other browsers is visible
// immediately, without waiting up to 5 minutes for the first sync alarm.
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms().catch(() => {});
  // Phase AE.2 — defensive backstop in case the SW died before the seeder
  // finished on install. Idempotent.
  seedAtsTemplatesIfNeeded().catch(() => {});
  (async () => {
    try {
      const s = await getSettings();
      if (s.cloudSync) {
        await pullFromCloud();
        // Phase AD.3 — also pull form fingerprints. Fire-and-forget so a
        // fingerprint fetch failure doesn't block profile load.
        pullFormFingerprints().catch(() => {});
      }
    } catch { /* network down at boot — sync alarm will retry in 5 min */ }
  })();
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
    // Push pending local changes to Supabase when cloud sync is enabled.
    // Phase AD.3 — also push form fingerprints learned since the last cycle.
    getSettings().then(s => {
      if (s.cloudSync) {
        pushSyncQueue().catch(() => {});
        pushFormFingerprints().catch(() => {});
      }
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
    // Self-heal: purge corrupted/junk entries left by earlier builds before
    // handing the profile to the content script. Cheap (one filter); only
    // writes when something was actually removed.
    const healed = await healProfile();
    if (healed.removed > 0) {
      console.log('[SmartFillAI] healProfile removed', healed.removed, 'corrupt/junk entries');
    }
    return getAllEntries();
  },

  ADD_ENTRY: async (payload) => {
    const data    = payload as NewEntryData;
    const userId  = (await getCurrentUserId()) ?? '';
    const created = await addEntry(data, userId);
    embedEntry(created).catch(() => {});
    refreshCSCache().catch(() => {});
    clearLlmAnswers().catch(() => {});
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
    if (patch.value) clearLlmAnswers().catch(() => {});
    return updated;
  },

  DELETE_ENTRY: async (payload) => {
    const { id } = payload as { id: string };
    const ok = await deleteEntry(id);
    refreshCSCache().catch(() => {});
    clearLlmAnswers().catch(() => {});
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

  // ── Form fingerprint cache (Phase AD.1 — whole-form, cross-ATS) ────────────

  GET_FORM_FINGERPRINT: async (payload) => {
    const { key } = payload as { key: string };
    const fp = await getFormFingerprint(key);
    return fp ?? null;
  },

  LEARN_FORM_FINGERPRINT: async (payload) => {
    const { fingerprint } = payload as { fingerprint: FormFingerprint };
    await putFormFingerprint(fingerprint);
    return { ok: true };
  },

  BUMP_FORM_FINGERPRINT_USE: async (payload) => {
    const { key } = payload as { key: string };
    await bumpFormFingerprintUsage(key);
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

  /**
   * Phase A.4 — semantic option selection for dropdowns whose options don't
   * match any alias / exact text. Embeds the user value and every option,
   * returns the closest above threshold.
   *
   * Called by fillSelect / fillCombobox / fillButtonDropdown as a fallback
   * AFTER deterministic alias matching fails. Cost is bounded: only fires
   * when alias/exact match returns nothing, and we skip very large lists
   * (the content-script caller gates on optionTexts.length).
   *
   * Returns null when no option clears the threshold; the caller then marks
   * the field FILL_FAILED so the user sees visible feedback.
   */
  EMBED_OPTION_MATCH: async (payload) => {
    const { userValue, optionTexts, threshold = 0.65 } = payload as {
      userValue: string;
      optionTexts: string[];
      threshold?: number;
    };
    if (!userValue || !Array.isArray(optionTexts) || optionTexts.length === 0) return null;

    try {
      const userVec = await computeEmbedding(userValue);
      let bestIdx = -1;
      let bestSim = -1;
      for (let i = 0; i < optionTexts.length; i++) {
        const optText = optionTexts[i];
        if (!optText || typeof optText !== 'string') continue;
        const optVec = await computeEmbedding(optText);
        const sim = cosineSimilarity(userVec, optVec);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = i;
        }
      }
      if (bestIdx < 0 || bestSim < threshold) return null;
      return { index: bestIdx, similarity: bestSim, optionText: optionTexts[bestIdx] };
    } catch (err) {
      // Model not loaded yet, or inference failed. Return null so caller
      // falls back to FILL_FAILED rather than crashing the fill loop.
      console.warn('[SmartFillAI] EMBED_OPTION_MATCH failed:', err);
      return null;
    }
  },

  // ── Deferred stubs (Tasks 4–8) ─────────────────────────────────────────────

  STEP6_CLASSIFY: async (payload) => {
    const { fieldTexts } = payload as { fieldTexts: string[] };
    if (!Array.isArray(fieldTexts) || fieldTexts.length === 0) return [];
    const specs: FieldClassifySpec[] = fieldTexts.map((t, i) => ({ fieldIndex: i, fieldText: t }));
    return classifyFields(specs);
  },

  // Final waterfall tier — LLM answers a form question using profile + resume.
  // Only called by the content script after exact / Q→A / embedding all miss.
  ANSWER_FIELD: async (payload) => {
    const { question, options, company, seedAnswer } =
      payload as { question: string; options?: string[]; company?: string; seedAnswer?: string };
    return answerField(question, Array.isArray(options) ? options : [], { company, seedAnswer });
  },

  STORE_QA_EMBEDDING: async (payload) => {
    const { question } = payload as { question: string };
    const nq = normalizeQuestion(question);
    if (nq.length < 6) return { ok: false };
    try {
      const vector = await computeEmbedding(nq);
      await saveQaEmbedding(nq, Array.from(vector));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },

  FUZZY_QA_MATCH: async (payload) => {
    const { question } = payload as { question: string };
    const nq = normalizeQuestion(question);
    if (nq.length < 6) return { answer: null };
    try {
      const queryVec = await computeEmbedding(nq);
      const allEmbeddings = await getAllQaEmbeddings();
      if (allEmbeddings.length === 0) return { answer: null };

      let bestSim = 0;
      let bestQ = '';
      for (const entry of allEmbeddings) {
        if (entry.question === nq) continue;
        const sim = cosineSimilarity(
          Array.from(queryVec),
          entry.vector
        );
        if (sim > bestSim) {
          bestSim = sim;
          bestQ = entry.question;
        }
      }

      if (bestSim < 0.82 || !bestQ) return { answer: null };

      const answer = await getRememberedAnswer(bestQ);
      return { answer, similarity: bestSim, matchedQuestion: bestQ };
    } catch {
      return { answer: null };
    }
  },

  // ── Multi-value alternatives ─────────────────────────────────────────────

  GET_ALTERNATIVES: async (payload) => {
    const { canonicalKey } = payload as { canonicalKey: string };
    return getEntriesByKey(canonicalKey);
  },

  ADD_ALTERNATIVE: async (payload) => {
    const { canonicalKey, value, displayLabel, category } = payload as {
      canonicalKey: string; value: string; displayLabel: string; category: string;
    };
    const count = await countByKey(canonicalKey);
    if (count >= getMaxAlternatives()) throw new Error('Maximum alternatives reached');
    const userId = (await getCurrentUserId()) ?? '';
    const data: NewEntryData = {
      canonical_key: canonicalKey,
      display_label: displayLabel,
      aliases:       [],
      value,
      category,
      source:        'learned',
      sensitive:     false,
    };
    const created = await addEntry(data, userId);
    embedEntry(created).catch(() => {});
    refreshCSCache().catch(() => {});
    clearLlmAnswers().catch(() => {});
    return created;
  },

  SET_DEFAULT_ENTRY: async (payload) => {
    const { entryId } = payload as { entryId: string };
    await setAsDefault(entryId);
    refreshCSCache().catch(() => {});
    return { ok: true };
  },

  CHECK_DUPLICATE_VALUE: async (payload) => {
    const { canonicalKey, value } = payload as { canonicalKey: string; value: string };
    return hasDuplicateValue(canonicalKey, value);
  },

  MATCH_FIELDS: () => {
    throw new Error('MATCH_FIELDS is handled in the content script (Task 4.1)');
  },

  LEARN_FIELD: async (payload) => {
    const { sig, value } = payload as { sig: SerializableFieldSig; value: string };

    const inferred = inferCanonicalKey(sig);
    if (inferred === '') throw new Error('Sensitive field — will not learn this value');

    // Fields with no recognised canonical key (e.g. "Expected CTC", "Notice period",
    // bespoke ATS questions) are NOT profile attributes.  Throwing here causes the
    // content-script's doLearnField catch block to route them to the Q→A cache
    // instead, keyed by the visible label.  That way they are remembered across
    // visits without polluting the profile with unusable canonical keys.
    if (inferred === null) {
      throw new Error(`Refusing to learn — no standard profile attribute for "${inferDisplayLabel(sig)}"`);
    }

    // STEP 7.3 — Defensive value-length cap. A textarea that snuck through
    // the matcher's essay-detector shouldn't be saved as a profile field;
    // anything > 500 chars is almost certainly the wrong target.
    const trimmed = value.length > 500 ? value.slice(0, 500) : value;

    const canonicalKey = inferred;

    // Belt-and-suspenders guard against any remaining junk canonical keys
    // (e.g. bracket-array notation like "application[answers][0][text_value]",
    // Greenhouse checkbox-group names "question_36872262002[]", etc.).
    if (/[[\]]|^question_|^field[_-]?\d/i.test(canonicalKey)) {
      throw new Error(`Refusing to learn junk canonical key "${canonicalKey}"`);
    }

    // Normalize country values: strip emoji flags and calling-code suffixes,
    // resolve to canonical country name ("🇮🇳 India +91" → "India").
    const normalizedTrimmed = normalizeFieldValue(canonicalKey, trimmed);
    const category     = inferCategory(canonicalKey);
    const displayLabel = inferDisplayLabel(sig);
    const userId       = (await getCurrentUserId()) ?? '';

    // Multi-value aware: if the profile already has entries with this
    // canonical_key, check for duplicates and signal the content script
    // to show the Update-or-Add prompt instead of silently overwriting.
    const allForKey = await getEntriesByKey(canonicalKey);
    if (allForKey.length > 0) {
      const isDuplicate = allForKey.some(
        e => e.value.trim().toLowerCase() === normalizedTrimmed.trim().toLowerCase(),
      );
      if (isDuplicate) return allForKey[0]; // no-op — value already stored

      const count = allForKey.length;
      return {
        action: 'ASK_UPDATE_OR_ADD' as const,
        existingEntry: allForKey[0],
        newValue: normalizedTrimmed,
        count,
        maxAlternatives: getMaxAlternatives(),
        canonicalKey,
        displayLabel,
        category,
      };
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
    // Push any locally-queued entries first (data entered before sign-in),
    // then pull the server's canonical state. Fire-and-forget so the popup
    // is not blocked — both operations are idempotent on failure.
    // Phase AD.3 — also pull fingerprints so a fresh sign-in inherits any
    // form memory the user has accumulated on other devices.
    pushSyncQueue().then(() => pullFromCloud()).catch(() => {});
    pullFormFingerprints().catch(() => {});
    return { userId: session.userId, email: session.email };
  },

  SIGN_UP: async (payload) => {
    const { email, password } = payload as { email: string; password: string };
    const session = await signUp(email, password);
    // New account — no cloud data to pull, but start sync for future pushes
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
    // Phase AD.3 — sync fingerprints alongside profile entries. Run all four
    // in parallel; the partial-failure semantics match the profile path (caller
    // sees aggregate counts, retries on next alarm if anything failed).
    const [push, pull, fpPush, fpPull] = await Promise.all([
      pushSyncQueue(),
      pullFromCloud(),
      pushFormFingerprints(),
      pullFormFingerprints(),
    ]);
    return {
      pushed: push.pushed,
      failed: push.failed,
      pulled: pull.pulled,
      fingerprintsPushed: fpPush.pushed,
      fingerprintsPulled: fpPull.pulled,
    };
  },

  WIPE_ALL_DATA: async () => {
    // Wipe profile entries
    await replaceAll([]);
    // Wipe Q&A cache
    await chrome.storage.local.remove(STORAGE_KEYS.QA_CACHE);
    // Wipe all uploaded documents
    const docs = await getAllDocumentMetas();
    await Promise.all(docs.map(d => deleteDocument(d.id)));
    // Sign out
    await signOut();
    return { ok: true };
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
          extractedText = parsed.full_text || JSON.stringify(parsed);
          await createEntriesFromResume(parsed, userId);
          refreshCSCache().catch(() => {});
        } else if (mimeType === 'text/plain') {
          const text = new TextDecoder().decode(bytes);
          const parsed = await parseResumeText(text);
          extractedText = parsed.full_text || text;
          await createEntriesFromResume(parsed, userId);
          refreshCSCache().catch(() => {});
        }
      } catch (err) {
        console.warn('[SmartFillAI] resume parse failed — document saved but no profile entries created:', err);
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
    if (docType === 'resume') {
      try { await clearLlmAnswers(); } catch { /* non-fatal */ }
      if (extractedText) {
        generateAndStoreResumeQA(extractedText).catch(err =>
          console.warn('[SmartFillAI] resume QA generation error', err));
      }
    }

    const { fileData: _, ...meta } = doc;
    return meta;
  },

  UPDATE_DOCUMENT_META: async (payload) => {
    const { id, patch } = payload as { id: string; patch: { label?: string; isDefault?: boolean } };
    const docMeta = await getDocumentMeta(id);
    if (patch.isDefault && docMeta) {
      const all = await getAllDocumentMetas();
      for (const other of all) {
        if (other.docType === docMeta.docType && other.id !== id && other.isDefault) {
          await updateDocumentMeta(other.id, { isDefault: false });
        }
      }
    }
    const updated = await updateDocumentMeta(id, patch);
    refreshDocumentsMetaCache().catch(() => {});
    if (patch.isDefault && docMeta?.docType === 'resume') clearLlmAnswers().catch(() => {});
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
          extractedText = parsed.full_text || JSON.stringify(parsed);
          await createEntriesFromResume(parsed, userId);
          refreshCSCache().catch(() => {});
        }
      } catch (err) {
        console.warn('[SmartFillAI] resume re-parse failed:', err);
      }
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
    if (existing.docType === 'resume') {
      try { await clearLlmAnswers(); } catch { /* non-fatal */ }
      const newText = extractedText ?? existing.extractedText;
      if (newText) {
        generateAndStoreResumeQA(newText).catch(err =>
          console.warn('[SmartFillAI] resume QA generation error', err));
      }
    }

    return getDocumentMeta(id);
  },

  DELETE_DOCUMENT: async (payload) => {
    const { id } = payload as { id: string };
    const meta = await getDocumentMeta(id);
    await deleteDocument(id);
    refreshDocumentsMetaCache().catch(() => {});
    if (meta?.docType === 'resume') clearLlmAnswers().catch(() => {});
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
