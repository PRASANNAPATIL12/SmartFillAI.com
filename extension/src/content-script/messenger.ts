import type { MessageType } from '@shared/types';

/**
 * Typed wrapper around chrome.runtime.sendMessage for content-script → background calls.
 * Rejects if the background returns { success: false } or if the extension context is gone.
 */
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
      if (!response) {
        reject(new Error('No response received from background'));
        return;
      }
      if (!response.success) {
        reject(new Error(response.error ?? 'Background handler returned an error'));
        return;
      }
      resolve(response.data as T);
    });
  });
}
