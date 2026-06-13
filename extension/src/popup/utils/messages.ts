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

/** popup → active tab content script */
export async function sendToActiveTab<T = unknown>(
  type: string,
  payload?: unknown
): Promise<T> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active tab');

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id!, { type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        // Common when content script isn't injected (chrome:// pages, PDFs, etc.)
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
