/**
 * Content Script — injected into every page.
 * Full form detection + overlay in Tasks 2.2, 4.2, 4.3.
 * This stub confirms the content script loads without errors.
 */

import { extractAllFields } from './detector';

function init(): void {
  const fields = extractAllFields(document);
  if (fields.length === 0) return;

  // Tasks 2.2+ will: run matcher, inject overlay, handle autofill
  chrome.runtime.sendMessage({ type: 'PING' });
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Watch for SPAs that render forms after initial load
const observer = new MutationObserver(() => {
  // Debounce: wait 300ms after last mutation before re-scanning
  clearTimeout((window as any).__dittoScanTimer);
  (window as any).__dittoScanTimer = setTimeout(init, 300);
});

observer.observe(document.body, { childList: true, subtree: true });
