import type { MessageType, ProfileEntry } from '@shared/types';
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

// ── Alarm name ────────────────────────────────────────────────────────────────

const SYNC_ALARM = 'ditto_sync';

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // Seed GROQ key from build-time env var (dev convenience; user can override in settings)
    if (ENV_GROQ_API_KEY) {
      setAPIKey('groq', ENV_GROQ_API_KEY).then(() =>
        setProviderConfig({ provider: 'groq', fallbackProvider: 'gemini' })
      );
    }
  }

  // (Re)create the periodic sync alarm on every install/update
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
});

// ── Alarm handler (sync stub — full implementation in Task 6.2) ───────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    // Task 6.2: read sync queue, push to Supabase
  }
});

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
    const data = payload as NewEntryData;
    return addEntry(data);
  },

  UPDATE_ENTRY: async (payload) => {
    const { id, patch } = payload as { id: string; patch: EntryPatch };
    const updated = await updateEntry(id, patch);
    if (!updated) throw new Error(`Entry not found: ${id}`);
    return updated;
  },

  DELETE_ENTRY: async (payload) => {
    const { id } = payload as { id: string };
    return deleteEntry(id);
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

  // ── Deferred stubs (Tasks 4–8) ─────────────────────────────────────────────

  MATCH_FIELDS: () => {
    throw new Error('MATCH_FIELDS is handled in the content script (Task 4.1)');
  },

  LEARN_FIELD: () => {
    throw new Error('Not implemented (Task 5.1)');
  },

  GENERATE_ESSAY: () => {
    throw new Error('Not implemented (Task 7.3)');
  },

  PARSE_RESUME: () => {
    throw new Error('Not implemented (Task 6.3)');
  },

  SYNC_NOW: () => {
    throw new Error('Not implemented (Task 6.2)');
  },

  FILL_FIELD: () => {
    throw new Error('FILL_FIELD is handled in the content script (Task 4.3)');
  },

  FILL_ALL: () => {
    throw new Error('FILL_ALL is handled in the content script (Task 4.3)');
  },
};

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
