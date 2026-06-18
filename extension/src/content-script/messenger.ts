import type { MessageType } from '@shared/types';

/**
 * How long to wait for the background service worker to respond before giving up.
 *
 * MV3 service workers sleep after ~30 s of inactivity. Chrome wakes them on the
 * first incoming message but there is a brief race window where the wake-up
 * handshake can fail and the sendMessage callback is silently never called.
 * Without this timeout `init()` would hang forever, keeping `profileLoaded`
 * false and preventing scanFields() from ever running.
 */
const TIMEOUT_MS = 8_000;
const TIMEOUT_LONG_MS = 30_000;

const LONG_TIMEOUT_TYPES: Set<MessageType> = new Set([
  'ANSWER_FIELD', 'STEP6_CLASSIFY', 'GENERATE_ESSAY', 'PARSE_RESUME',
]);

function sendOnce<T>(type: MessageType, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) { settled = true; fn(); }
    };

    const ms = LONG_TIMEOUT_TYPES.has(type) ? TIMEOUT_LONG_MS : TIMEOUT_MS;
    const timer = setTimeout(
      () => settle(() => reject(new Error(`[SFA] background timeout (${type})`))),
      ms
    );

    chrome.runtime.sendMessage({ type, payload }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        settle(() => reject(new Error(chrome.runtime.lastError!.message)));
        return;
      }
      if (!response) {
        settle(() => reject(new Error('No response received from background')));
        return;
      }
      if (!response.success) {
        settle(() => reject(new Error(response.error ?? 'Background handler returned an error')));
        return;
      }
      settle(() => resolve(response.data as T));
    });
  });
}

/**
 * Typed wrapper around chrome.runtime.sendMessage for content-script → background calls.
 *
 * Rejects if:
 * - the background returns { success: false }
 * - the extension context is invalidated
 * - no response arrives within TIMEOUT_MS (service worker wake-up race)
 */
export function sendToBackground<T = unknown>(
  type: MessageType,
  payload?: unknown
): Promise<T> {
  return sendOnce<T>(type, payload);
}
