/**
 * Jest global setup — runs before every test file.
 * Mocks chrome.* APIs since Jest runs in jsdom, not a real extension context.
 */

// ── chrome.storage.local mock ────────────────────────────────────────────────

const store: Record<string, unknown> = {};

const chromeStorageLocal = {
  get: jest.fn(async (keys: string | string[]) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(keyList.map(k => [k, store[k]]));
  }),
  set: jest.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  }),
  remove: jest.fn(async (keys: string | string[]) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    keyList.forEach(k => delete store[k]);
  }),
  clear: jest.fn(async () => {
    Object.keys(store).forEach(k => delete store[k]);
  }),
};

// ── chrome.runtime mock ──────────────────────────────────────────────────────

const chromeRuntime = {
  id: 'ditto-test-extension-id',
  sendMessage: jest.fn(),
  onMessage: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
  },
};

// ── Attach to global ─────────────────────────────────────────────────────────

(global as any).chrome = {
  storage: { local: chromeStorageLocal },
  runtime: chromeRuntime,
};

// ── import.meta.env mock ─────────────────────────────────────────────────────
// Vite exposes these at build time. In tests we provide stubs.
(global as any).importMeta = {
  env: {
    VITE_GROQ_API_KEY: 'test-groq-key',
    VITE_GEMINI_API_KEY: 'test-gemini-key',
  },
};

// ── document.execCommand mock (not available in jsdom) ───────────────────────
// contenteditableHandler uses execCommand('insertText') as a compatibility shim.
// jsdom doesn't implement it; return false so the handler falls back to innerText.
if (!document.execCommand) {
  document.execCommand = () => false;
}

// ── CSS.escape mock (not available in jsdom) ─────────────────────────────────
if (typeof (globalThis as any).CSS === 'undefined') {
  (globalThis as any).CSS = {
    escape: (value: string) => value.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1'),
  };
}

// ── crypto.randomUUID mock (not available in jsdom) ─────────────────────────
let uuidCounter = 0;
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `test-uuid-${++uuidCounter}`,
    writable: true,
  });
} else {
  (globalThis.crypto as any).randomUUID = () => `test-uuid-${++uuidCounter}`;
}

// Reset store and mocks between tests
beforeEach(() => {
  uuidCounter = 0;
  Object.keys(store).forEach(k => delete store[k]);
  jest.clearAllMocks();
});
