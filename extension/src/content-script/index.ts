import type { ProfileEntry, FieldCacheEntry, MatchResult, FieldSignature, UserSettings } from '@shared/types';
import { extractAllFields } from './detector';
import { matchField, fingerprint } from '@/matcher';
import { fillElement } from './filler';
import { sendToBackground } from './messenger';
import { fieldEmbedText } from '@/ml/step5';
import { initOverlay, initLearnOverlay, showPill, showLearnPill, schedulePillHide } from './overlay';

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
let autoSave = true; // default; overwritten after GET_SETTINGS resolves

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  injectStyles();

  // Fetch profile and settings in parallel
  const [fetchedProfile, fetchedSettings] = await Promise.allSettled([
    sendToBackground<ProfileEntry[]>('GET_PROFILE'),
    sendToBackground<UserSettings>('GET_SETTINGS'),
  ]);

  profile   = fetchedProfile.status  === 'fulfilled' ? fetchedProfile.value  : [];
  autoSave  = fetchedSettings.status === 'fulfilled' ? fetchedSettings.value.autoSave : true;

  profileLoaded = true;
  initOverlay(handlePillFill);
  initLearnOverlay(handleLearnSave);
  await scanFields();
  // Step 5 runs after deterministic steps — async, never blocks initial render
  runStep5().catch(() => {});
}

// ── Field scanning ────────────────────────────────────────────────────────────

async function scanFields(): Promise<void> {
  if (!profileLoaded) return;

  const domain = window.location.hostname;

  // Load persistent cache from background (backed by IndexedDB)
  let cache = new Map<string, FieldCacheEntry>();
  try {
    const raw = await sendToBackground<Record<string, FieldCacheEntry>>(
      'GET_FIELD_CACHE',
      { domain }
    );
    cache = new Map(Object.entries(raw));
  } catch {
    // Proceed with empty cache if background is unavailable
  }

  const fields = extractAllFields(document);
  const newCacheEntries: Array<{ fingerprint: string; profileEntryId: string; confidence: number }> = [];

  for (const sig of fields) {
    const el = sig.element as HTMLElement | undefined;
    if (!el) continue;

    const result = matchField(sig, profile, cache, domain);
    const entry = result.profileEntryId
      ? profile.find(e => e.id === result.profileEntryId)
      : undefined;

    matchMap.set(el, { sig, result, entry });
    applyHint(el, result, entry);

    // Persist new Step-4 matches so future visits use Step-2 cache
    if (result.status === 'MATCHED' && result.matchStep === 4 && result.profileEntryId) {
      const fp = fingerprint(sig, domain);
      if (!cache.has(fp)) {
        newCacheEntries.push({
          fingerprint: fp,
          profileEntryId: result.profileEntryId,
          confidence: result.confidence ?? 0.9,
        });
      }
    }

    // Increment use count for existing cache hits (Step 2)
    if (result.matchStep === 2) {
      const fp = fingerprint(sig, domain);
      sendToBackground('INCREMENT_CACHE_USE', { fingerprint: fp }).catch(() => {});
    }
  }

  // Fire-and-forget: save new cache entries for next visit
  for (const entry of newCacheEntries) {
    sendToBackground('CACHE_FIELD_MATCH', entry).catch(() => {});
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

// ── Pill fill callback ────────────────────────────────────────────────────────

function handlePillFill(target: { el: HTMLElement; entry: ProfileEntry }): void {
  const ok = fillElement(
    target.el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    target.entry.value
  );
  if (ok) {
    sendToBackground('RECORD_USE', { id: target.entry.id }).catch(() => {});
  }
}

// ── Visual hints + hover listeners ───────────────────────────────────────────

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
    attachPillListeners(el, entry, result);
  } else if (result.status === 'ESSAY') {
    el.dataset.dittoMatch = 'essay';
  } else if (result.status === 'UNKNOWN') {
    attachLearnListeners(el);
  }
}

function attachPillListeners(el: HTMLElement, entry: ProfileEntry, result: MatchResult): void {
  if (el.dataset.dittoListeners === 'true') return;
  el.dataset.dittoListeners = 'true';

  const show = (): void => showPill({ el, entry, result });
  const hide = (): void => schedulePillHide(400);

  el.addEventListener('mouseenter', show);
  el.addEventListener('focus',      show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur',       hide);
}

function attachLearnListeners(el: HTMLElement): void {
  if (el.dataset.dittoLearnListeners === 'true') return;
  el.dataset.dittoLearnListeners = 'true';

  // Capture the original value on focus so we know if user actually typed something
  el.addEventListener('focus', () => {
    el.dataset.dittoPreFocusValue = (el as HTMLInputElement).value ?? '';
  });

  el.addEventListener('blur', () => {
    // Skip if Ditto already filled this field
    if (el.dataset.dittoFilled === 'true') return;

    const currentValue = (el as HTMLInputElement).value ?? '';
    const preFocus     = el.dataset.dittoPreFocusValue ?? '';

    // Only offer to learn if the user typed something non-empty and different
    if (!currentValue || currentValue === preFocus) return;

    const state = matchMap.get(el);
    if (!state || state.result.status !== 'UNKNOWN') return;

    if (autoSave) {
      // Silent save — no confirm pill needed
      doLearnField(el, state.sig, currentValue).catch(() => {});
    } else {
      // Show amber confirm pill
      const label = state.sig.label || state.sig.ariaLabel || state.sig.placeholder || state.sig.name || state.sig.id || 'Field';
      showLearnPill({ el, label, value: currentValue });
    }
  });
}

async function doLearnField(el: HTMLElement, sig: FieldSignature, value: string): Promise<void> {
  const { element: _el, ...serializableSig } = sig;
  try {
    const newEntry = await sendToBackground<ProfileEntry>('LEARN_FIELD', {
      sig: serializableSig,
      value,
    });
    applyLearnedEntry(el, sig, newEntry);
  } catch {
    // Silently ignore — sensitive field or background unavailable
  }
}

function handleLearnSave(target: { el: HTMLElement; label: string; value: string }): void {
  const state = matchMap.get(target.el);
  if (!state) return;
  doLearnField(target.el, state.sig, target.value).catch(() => {});
}

function applyLearnedEntry(el: HTMLElement, sig: FieldSignature, newEntry: ProfileEntry): void {
  // Add to local profile so future scans find it
  profile.push(newEntry);

  const result: MatchResult = {
    status:          'MATCHED',
    profileEntryId:  newEntry.id,
    confidence:      1.0,
    reason:          'learned by user',
    matchStep:       0,
  };

  matchMap.set(el, { sig, result, entry: newEntry });

  // Transition field from UNKNOWN → MATCHED visually
  delete el.dataset.dittoLearnListeners; // allow fill listeners to attach
  applyHint(el, result, newEntry);
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
  // scanFields is async; the returned Promise is intentionally ignored here
  scanTimer = setTimeout(() => { scanFields().catch(() => {}); }, 300);
});

function startObserver(): void {
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.body) {
  startObserver();
} else {
  document.addEventListener('DOMContentLoaded', startObserver);
}
