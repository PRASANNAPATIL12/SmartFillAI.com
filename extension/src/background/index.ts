/**
 * Service Worker (Background Script)
 * Handles: auth, sync, AI calls, profile store messaging.
 * Full implementation in Tasks 2.1, 3.1, 6.2.
 */

import { AIProviderFactory, setAPIKey, setProviderConfig } from '@/ai-providers';

// ── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    // On fresh install, seed the GROQ key from the build-time env if present
    // (user can replace it later in settings)
    const groqKey = (typeof import.meta !== 'undefined'
      ? (import.meta as any).env?.VITE_GROQ_API_KEY
      : undefined) as string | undefined;

    if (groqKey) {
      setAPIKey('groq', groqKey).then(() => {
        setProviderConfig({ provider: 'groq', fallbackProvider: 'gemini' });
      });
    }
  }
});

// Keep service worker alive while there are open tabs with content scripts
chrome.runtime.onMessage.addListener(handleMessage);

// ── Message router ────────────────────────────────────────────────────────────

function handleMessage(
  message: { type: string; payload?: unknown },
  _sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void
): boolean {
  switch (message.type) {
    case 'PING':
      sendResponse({ ok: true });
      break;

    case 'GET_PROVIDER':
      AIProviderFactory.getProvider()
        .then(p => sendResponse({ provider: p.name }))
        .catch(err => sendResponse({ error: String(err) }));
      return true; // async response

    // Tasks 2.1, 3.x, 6.x will add: GET_PROFILE, MATCH_FIELDS, GENERATE_ESSAY, SYNC_NOW …
  }

  return false;
}
