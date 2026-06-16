import type { MessageType } from '@shared/types';

/** popup → background service worker */
export function sendToBackground<T = unknown>(
  type: MessageType,
  payload?: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error ?? 'Background request failed'));
        return;
      }
      resolve(response.data as T);
    });
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sendToTab<T>(tabId: number, type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'Content script unavailable'));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error ?? 'Content script error'));
        return;
      }
      resolve(response.data as T);
    });
  });
}

async function injectContentScript(tabId: number): Promise<void> {
  const manifest = chrome.runtime.getManifest();
  const csJs  = manifest.content_scripts?.[0]?.js  ?? [];
  const csCss = manifest.content_scripts?.[0]?.css ?? [];
  await Promise.all([
    csCss.length > 0
      ? chrome.scripting.insertCSS({ target: { tabId }, files: csCss }).catch(() => {})
      : Promise.resolve(),
    csJs.length > 0
      ? chrome.scripting.executeScript({ target: { tabId }, files: csJs })
      : Promise.resolve(),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isConnectionError(msg: string): boolean {
  return (
    msg.includes('Receiving end does not exist') ||
    msg.includes('Could not establish connection')
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a message to the content script in the active tab.
 *
 * The content script loader uses an async dynamic import, so the onMessage
 * listener isn't registered until that import resolves — typically a few
 * hundred milliseconds after document_idle fires.  We retry up to 3 times
 * at 600 ms intervals before falling back to programmatic injection.
 *
 * Throws one of these sentinel error messages (check with ===):
 *   'restricted_page'      — chrome:// or other restricted URL
 *   'context_invalidated'  — extension was reloaded/updated
 *   'cs_unreachable'       — content script couldn't be reached even after injection
 */
export async function sendToActiveTab<T = unknown>(
  type: string,
  payload?: unknown
): Promise<T> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active tab');
  const tabId = tab.id;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sendToTab<T>(tabId, type, payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('Cannot access') || msg.includes('chrome://')) {
        throw new Error('restricted_page');
      }
      if (msg.includes('invalidated') || msg.includes('Extension context')) {
        throw new Error('context_invalidated');
      }

      if (isConnectionError(msg)) {
        if (attempt < 2) {
          await delay(600);
          continue;
        }
        // 3rd attempt failed — inject the content script programmatically then retry once
        try {
          await injectContentScript(tabId);
          await delay(1000); // wait for the loader's async import inside the injected script
          return await sendToTab<T>(tabId, type, payload);
        } catch {
          throw new Error('cs_unreachable');
        }
      }

      throw err;
    }
  }

  throw new Error('cs_unreachable');
}
