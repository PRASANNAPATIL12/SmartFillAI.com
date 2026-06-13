import type { ProfileEntry, FieldCacheEntry, MatchResult, FieldSignature } from '@shared/types';
import { extractAllFields } from './detector';
import { matchField, fingerprint } from '@/matcher';
import { fillElement } from './filler';
import { sendToBackground } from './messenger';
import { fieldEmbedText } from '@/ml/step5';

// ── Page-level state ──────────────────────────────────────────────────────────
// Service workers can be terminated, but content scripts live with the tab.
// Profile is fetched once; re-fetched if the background wakes and sends PROFILE_UPDATED.

interface FieldState {
  sig: FieldSignature;
  result: MatchResult;
  entry?: ProfileEntry;
}

const matchMap = new Map<HTMLElement, FieldState>();
let profile: ProfileEntry[] = [];
let profileLoaded = false;
let scanTimer: ReturnType<typeof setTimeout> | undefined;

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  injectStyles();

  try {
    profile = await sendToBackground<ProfileEntry[]>('GET_PROFILE');
  } catch {
    profile = [];
  }

  profileLoaded = true;
  scanFields();
  // Step 5 runs after deterministic steps so it never blocks the initial render
  runStep5().catch(() => {});
}

// ── Field scanning ────────────────────────────────────────────────────────────

function scanFields(): void {
  if (!profileLoaded) return;

  const domain = window.location.hostname;
  // Task 3.2: replace with IndexedDB-backed cache
  const cache = new Map<string, FieldCacheEntry>();

  const fields = extractAllFields(document);

  for (const sig of fields) {
    const el = sig.element as HTMLElement | undefined;
    if (!el) continue;

    const result = matchField(sig, profile, cache, domain);
    const entry = result.profileEntryId
      ? profile.find(e => e.id === result.profileEntryId)
      : undefined;

    matchMap.set(el, { sig, result, entry });
    applyHint(el, result, entry);
  }
}

// ── Step 5: async embedding pass for UNKNOWN fields ──────────────────────────

async function runStep5(): Promise<void> {
  const domain = window.location.hostname;
  const unknownFields: Array<{ el: HTMLElement; sig: FieldSignature }> = [];

  for (const [el, state] of matchMap) {
    if (state.result.status === 'UNKNOWN') {
      unknownFields.push({ el, sig: state.sig });
    }
  }

  if (unknownFields.length === 0) return;

  for (const { el, sig } of unknownFields) {
    const text = fieldEmbedText(sig);
    if (!text.trim()) continue;

    try {
      const match = await sendToBackground<{ profileEntryId: string; confidence: number } | null>(
        'STEP5_MATCH',
        { fieldText: text }
      );

      if (!match) continue;

      const entry = profile.find(e => e.id === match.profileEntryId);
      if (!entry) continue;

      const result: MatchResult = {
        status: 'MATCHED',
        profileEntryId: entry.id,
        confidence: match.confidence,
        reason: 'embedding similarity (Step 5)',
        matchStep: 5,
      };

      matchMap.set(el, { sig, result, entry });
      applyHint(el, result, entry);

      // Cache this match so future page visits skip Step 5 for the same field
      const fp = fingerprint(sig, domain);
      sendToBackground('CACHE_FIELD_MATCH', {
        fingerprint: fp,
        profileEntryId: entry.id,
        confidence: match.confidence,
      }).catch(() => {});
    } catch {
      // Step 5 unavailable (model not loaded, network error) — leave as UNKNOWN
    }
  }
}

// ── Fill operations ───────────────────────────────────────────────────────────

function fillAll(): { filled: number; skipped: number } {
  let filled = 0;
  let skipped = 0;

  for (const [el, state] of matchMap) {
    if (state.result.status !== 'MATCHED' || !state.entry) {
      skipped++;
      continue;
    }

    if (!document.contains(el)) {
      skipped++;
      continue;
    }

    const ok = fillElement(
      el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      state.entry.value
    );

    if (ok) {
      filled++;
      // Fire-and-forget — use count update is best-effort
      sendToBackground('RECORD_USE', { id: state.entry!.id }).catch(() => {});
    } else {
      skipped++;
    }
  }

  return { filled, skipped };
}

// ── Visual hints ──────────────────────────────────────────────────────────────

function applyHint(
  el: HTMLElement,
  result: MatchResult,
  entry?: ProfileEntry
): void {
  // Clear previous state
  delete el.dataset.dittoMatch;
  delete el.dataset.dittoKey;
  delete el.dataset.dittoStatus;
  delete el.dataset.dittoFilled;

  el.dataset.dittoStatus = result.status;

  if (result.status === 'MATCHED' && entry) {
    el.dataset.dittoMatch = 'true';
    el.dataset.dittoKey = entry.canonical_key;
  } else if (result.status === 'ESSAY') {
    el.dataset.dittoMatch = 'essay';
  }
}

function injectStyles(): void {
  if (document.getElementById('ditto-styles')) return;

  const style = document.createElement('style');
  style.id = 'ditto-styles';
  // Subtle indigo outline on fillable fields; green for essay fields
  style.textContent = `
    [data-ditto-match="true"]:not([data-ditto-filled]) {
      outline: 2px solid rgba(99, 102, 241, 0.35) !important;
      outline-offset: 1px !important;
    }
    [data-ditto-filled="true"] {
      outline: 2px solid rgba(99, 102, 241, 0.65) !important;
      outline-offset: 1px !important;
    }
    [data-ditto-match="essay"] {
      outline: 2px solid rgba(16, 185, 129, 0.35) !important;
      outline-offset: 1px !important;
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

// ── Message listener (popup → content script) ─────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FILL_ALL') {
    const result = fillAll();
    sendResponse({ success: true, data: result });
    return false;
  }

  if (message.type === 'FILL_FIELD') {
    const { entryId } = message.payload as { entryId: string };
    const target = [...matchMap.entries()].find(
      ([, s]) => s.entry?.id === entryId
    );
    if (!target) {
      sendResponse({ success: false, error: 'Field not found in current scan' });
      return false;
    }
    const [el, state] = target;
    if (!state.entry) {
      sendResponse({ success: false, error: 'No profile entry for field' });
      return false;
    }
    const ok = fillElement(
      el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      state.entry.value
    );
    if (ok) sendToBackground('RECORD_USE', { id: state.entry.id }).catch(() => {});
    sendResponse({ success: ok });
    return false;
  }

  return false;
});

// ── DOM readiness + SPA support ───────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init(); });
} else {
  init();
}

// Debounced re-scan on DOM mutations (SPA route changes render new forms)
const observer = new MutationObserver(() => {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanFields, 300);
});

function startObserver(): void {
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.body) {
  startObserver();
} else {
  document.addEventListener('DOMContentLoaded', startObserver);
}
