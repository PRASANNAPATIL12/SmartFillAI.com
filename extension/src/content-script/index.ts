console.log(
  '[SmartFillAI] content script loaded on',
  location.href,
  '| isTopFrame:', window.top === window,
  '| parentOrigin:', (window.top === window) ? '(top)' : (() => { try { return document.referrer; } catch { return 'cross-origin'; } })()
);

import type { ProfileEntry, FieldCacheEntry, MatchResult, FieldSignature, UserSettings } from '@shared/types';
import { extractAllFields } from './detector';
import { matchField, fingerprint } from '@/matcher';
import { fillElement } from './filler';
import { sendToBackground } from './messenger';
import { fieldEmbedText } from '@/ml/step5';
import { initOverlay, initLearnOverlay, initEssayOverlay, showPill, showLearnPill, schedulePillHide, showEssayPanel } from './overlay';
import type { EssayTarget } from './overlay';
import {
  showReadyBanner,
  showEmptyBanner,
  showFillingBanner,
  showSuccessBanner,
  hideBanner,
} from './overlay-banner';
import { showGhost, removeGhost, repositionAllGhosts } from './ghost-text';

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

// ── Banner state ──────────────────────────────────────────────────────────────
// Once the user dismisses the banner on this page load, don't re-show it.
let bannerDismissed = false;
// Avoid flicker if scan re-runs many times — only show once and update the count.
let bannerVisible = false;

// ── Frame coordination ───────────────────────────────────────────────────────
// Many forms (Greenhouse, Workday, Lever) live inside a cross-origin iframe.
// Each frame runs its own content script. We need ONE banner — rendered in
// the top frame — that aggregates counts from every frame. The top frame
// also coordinates the Fill action by broadcasting to every iframe.
const isTopFrame = window.top === window;
const FRAME_ID = isTopFrame ? '__top__' : Math.random().toString(36).slice(2);

interface FrameReport { matched: number; total: number; }
const frameReports = new Map<string, FrameReport>(); // only used in top frame
let myCounts: FrameReport = { matched: 0, total: 0 };

// Pending fill aggregation (top frame only)
let pendingFilled = 0;
let pendingFillTimer: ReturnType<typeof setTimeout> | undefined;

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  console.log('[SmartFillAI] init() started');
  injectStyles();

  // Fetch profile and settings in parallel
  const [fetchedProfile, fetchedSettings] = await Promise.allSettled([
    sendToBackground<ProfileEntry[]>('GET_PROFILE'),
    sendToBackground<UserSettings>('GET_SETTINGS'),
  ]);

  console.log('[SmartFillAI] profile entries loaded:', fetchedProfile.status === 'fulfilled' ? fetchedProfile.value.length : 'FAILED');

  profile   = fetchedProfile.status  === 'fulfilled' ? fetchedProfile.value  : [];
  autoSave  = fetchedSettings.status === 'fulfilled' ? fetchedSettings.value.autoSave : true;

  profileLoaded = true;
  initOverlay(handlePillFill);
  initLearnOverlay(handleLearnSave);
  initEssayOverlay(handleEssayOpen);

  // When the user scrolls or resizes, ghost overlays drift away from inputs.
  // Wipe them; the next scan will repaint them in the correct positions.
  let repositionTimer: ReturnType<typeof setTimeout> | undefined;
  const onReposition = (): void => {
    clearTimeout(repositionTimer);
    repositionAllGhosts();
    repositionTimer = setTimeout(() => { scanFields().catch(() => {}); }, 200);
  };
  window.addEventListener('scroll', onReposition, { passive: true });
  window.addEventListener('resize', onReposition);

  await scanFields();
  // Steps 5+6 run after deterministic steps — async, never blocks initial render
  runStep5().then(() => runStep6().catch(() => {})).catch(() => {});
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
  console.log('[SmartFillAI] scanFields detected', fields.length, 'fields, profile has', profile.length, 'entries');
  const newCacheEntries: Array<{ fingerprint: string; profileEntryId: string; confidence: number }> = [];

  for (const sig of fields) {
    const el = sig.element as HTMLElement | undefined;
    if (!el) continue;

    const result = matchField(sig, profile, cache, domain);
    const entry = result.profileEntryId
      ? profile.find(e => e.id === result.profileEntryId)
      : undefined;

    matchMap.set(el, { sig, result, entry });
    applyHint(el, result, entry, sig);

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

  // Refresh the proactive banner based on the new scan
  refreshBanner();
}

// ── Proactive banner (frame-aware) ────────────────────────────────────────────
// "We come first to help" — the moment we see a fillable form, announce it.
// In iframes we report counts up to the top frame; the top frame renders the
// single visible banner and coordinates fill across all frames.

function refreshBanner(): void {
  // Count fields and matches in THIS frame
  let totalDetected = 0;
  let matched = 0;
  for (const [, state] of matchMap) {
    if (state.result.status === 'SKIP') continue;
    totalDetected++;
    if (state.result.status === 'MATCHED' && state.entry) matched++;
  }
  console.log('[SmartFillAI] refreshBanner: detected', totalDetected, 'matched', matched, 'matchMap size', matchMap.size, 'isTopFrame:', isTopFrame);

  if (isTopFrame) {
    myCounts = { matched, total: totalDetected };
    renderAggregatedBanner();
  } else {
    // Bubble up so the top frame can aggregate counts from all iframes
    try {
      window.top?.postMessage({
        type: 'sfa:frame-report',
        frameId: FRAME_ID,
        matched,
        totalDetected,
      }, '*');
    } catch {
      // window.top inaccessible in sandboxed frames — silently ignore
    }
  }
}

function renderAggregatedBanner(): void {
  if (!isTopFrame) return;
  if (bannerDismissed) return;

  let totalMatched  = myCounts.matched;
  let totalDetected = myCounts.total;
  for (const report of frameReports.values()) {
    totalMatched  += report.matched;
    totalDetected += report.total;
  }
  console.log('[SmartFillAI] aggregated → matched', totalMatched, 'total', totalDetected, 'frames reporting', frameReports.size);

  // Show only when at least 2 fields are detected across all frames
  if (totalDetected < 2) {
    if (bannerVisible) { hideBanner(); bannerVisible = false; }
    return;
  }

  bannerVisible = true;

  if (totalMatched > 0) {
    showReadyBanner({
      matched: totalMatched,
      total:   totalDetected,
      onFill:  triggerBannerFill,
      onClose: dismissBanner,
    });
  } else {
    showEmptyBanner({
      total: totalDetected,
      onOpenPopup: () => { sendToBackground('PING').catch(() => {}); },
      onClose:     dismissBanner,
    });
  }
}

function dismissBanner(): void {
  bannerDismissed = true;
  bannerVisible   = false;
  hideBanner();
}

function triggerBannerFill(): void {
  showFillingBanner();
  pendingFilled = 0;
  // Top frame fills its own first
  requestAnimationFrame(() => {
    const local = fillAll();
    pendingFilled += local.filled;

    // Broadcast to every iframe at any depth via top-down recursion
    broadcastToAllIframes({ type: 'sfa:fill-request' });

    // Wait briefly for iframes to report back, then show success
    clearTimeout(pendingFillTimer);
    pendingFillTimer = setTimeout(() => {
      showSuccessBanner(pendingFilled);
      bannerVisible = false;
    }, 600);
  });
}

function broadcastToAllIframes(message: unknown, root: Document = document): void {
  root.querySelectorAll('iframe').forEach((iframe) => {
    try {
      iframe.contentWindow?.postMessage(message, '*');
    } catch {
      // cross-origin: postMessage still works even when contentWindow is restricted
    }
  });
}

// ── Cross-frame message router ────────────────────────────────────────────────
window.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return;
  const msg = data as { type: string; [k: string]: unknown };
  if (!msg.type.startsWith('sfa:')) return;

  // Top frame collects scan reports from iframes
  if (msg.type === 'sfa:frame-report' && isTopFrame) {
    const frameId = String(msg.frameId);
    frameReports.set(frameId, {
      matched: Number(msg.matched) || 0,
      total:   Number(msg.totalDetected) || 0,
    });
    renderAggregatedBanner();
    return;
  }

  // Any frame: top frame asked us to fill
  if (msg.type === 'sfa:fill-request') {
    const result = fillAll();
    try {
      window.top?.postMessage({
        type: 'sfa:fill-result',
        frameId: FRAME_ID,
        filled: result.filled,
      }, '*');
    } catch { /* ignore */ }
    // Also relay the request to any nested iframes
    broadcastToAllIframes(msg);
    return;
  }

  // Top frame aggregates fill results from iframes
  if (msg.type === 'sfa:fill-result' && isTopFrame) {
    pendingFilled += Number(msg.filled) || 0;
    return;
  }
});

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
      applyHint(el, result, entry, sig);

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

// ── Step 6: LLM batch classifier for remaining UNKNOWN fields ─────────────────

async function runStep6(): Promise<void> {
  if (profile.length === 0) return; // nothing to match against

  const domain = window.location.hostname;
  const unknownFields: Array<{ el: HTMLElement; sig: FieldSignature }> = [];

  for (const [el, state] of matchMap) {
    if (state.result.status === 'UNKNOWN') {
      const text = fieldEmbedText(state.sig);
      if (text.trim()) unknownFields.push({ el, sig: state.sig });
    }
  }

  if (unknownFields.length === 0) return;

  const fieldTexts = unknownFields.map(f => fieldEmbedText(f.sig));

  try {
    const results = await sendToBackground<
      Array<{ fieldIndex: number; profileEntryId: string | null; confidence: number }>
    >('STEP6_CLASSIFY', { fieldTexts });

    for (const r of results) {
      if (!r.profileEntryId || r.confidence < 0.7) continue;
      const { el, sig } = unknownFields[r.fieldIndex];
      const entry = profile.find(e => e.id === r.profileEntryId);
      if (!entry) continue;

      const result: MatchResult = {
        status:          'MATCHED',
        profileEntryId:  entry.id,
        confidence:      r.confidence,
        reason:          'LLM classification (Step 6)',
        matchStep:       6,
      };

      matchMap.set(el, { sig, result, entry });
      applyHint(el, result, entry, sig);

      // Cache so future visits skip Steps 5+6 for the same field
      const fp = fingerprint(sig, domain);
      sendToBackground('CACHE_FIELD_MATCH', {
        fingerprint: fp,
        profileEntryId: entry.id,
        confidence: r.confidence,
      }).catch(() => {});
    }
  } catch {
    // Step 6 unavailable (no API key, network error) — leave fields as UNKNOWN
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
      removeGhost(el);
      // Fire-and-forget — use count update is best-effort
      sendToBackground('RECORD_USE', { id: state.entry!.id }).catch(() => {});
    } else {
      skipped++;
    }
  }

  return { filled, skipped };
}

// ── Pill fill callback ────────────────────────────────────────────────────────

function handlePillFill(target: { el: HTMLElement; entry?: ProfileEntry }): void {
  if (!target.entry) return; // ESSAY pills have no entry
  const ok = fillElement(
    target.el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    target.entry.value
  );
  if (ok) {
    removeGhost(target.el);
    sendToBackground('RECORD_USE', { id: target.entry.id }).catch(() => {});
  }
}

// ── Visual hints + hover listeners ───────────────────────────────────────────

function applyHint(
  el: HTMLElement,
  result: MatchResult,
  entry?: ProfileEntry,
  sig?: FieldSignature
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
    // Ghost text preview — show value (masked for sensitive entries)
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const preview = entry.sensitive ? '•••••' : entry.value;
      showGhost(el, preview);
    }
  } else if (result.status === 'ESSAY') {
    el.dataset.dittoMatch = 'essay';
    if (sig) attachEssayPillListeners(el, sig);
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

  // Update-detection — capture the original profile value so we know if
  // the user edits a pre-filled field to a different value.
  el.dataset.dittoPreFocusValue = (el as HTMLInputElement).value ?? '';
  el.addEventListener('focus', () => {
    el.dataset.dittoPreFocusValue = (el as HTMLInputElement).value ?? '';
  });
  el.addEventListener('blur', () => {
    const currentValue = (el as HTMLInputElement).value ?? '';
    if (!currentValue) return;
    if (entry.sensitive) return; // never auto-update sensitive entries
    if (currentValue === entry.value) return; // unchanged
    if (currentValue === el.dataset.dittoPreFocusValue) return; // not actually edited

    if (autoSave) {
      // Silent update — keeps the profile in sync with the user's latest input
      doUpdateEntry(entry.id, currentValue).catch(() => {});
    } else {
      // Show the amber learn pill repurposed as an update prompt
      const label = entry.display_label || 'Field';
      showLearnPill({ el, label: `Update ${label}?`, value: currentValue });
    }
  });
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

function attachEssayPillListeners(el: HTMLElement, sig: FieldSignature): void {
  if (el.dataset.dittoEssayListeners === 'true') return;
  el.dataset.dittoEssayListeners = 'true';

  const question = sig.label || sig.ariaLabel || sig.placeholder || sig.name || sig.id || 'Essay question';
  const show = (): void => showPill({ el, result: { status: 'ESSAY' }, question });
  const hide = (): void => schedulePillHide(400);

  el.addEventListener('mouseenter', show);
  el.addEventListener('focus',      show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur',       hide);
}

function handleEssayOpen(target: EssayTarget): void {
  // Provide the real onGenerate that calls the background
  const realTarget: EssayTarget = {
    ...target,
    onGenerate: () => sendToBackground<{ essay: string }>('GENERATE_ESSAY', {
      question: target.question,
      domain:   window.location.hostname,
    }).then(r => r.essay),
  };
  showEssayPanel(realTarget);
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

  // If the field is already matched to an existing entry and the value differs,
  // treat the click as an UPDATE rather than a new LEARN.
  if (state.result.status === 'MATCHED' && state.entry && state.entry.value !== target.value) {
    doUpdateEntry(state.entry.id, target.value).catch(() => {});
    return;
  }

  doLearnField(target.el, state.sig, target.value).catch(() => {});
}

async function doUpdateEntry(id: string, value: string): Promise<void> {
  try {
    const updated = await sendToBackground<ProfileEntry>('UPDATE_ENTRY', {
      id,
      patch: { value },
    });
    // Keep local profile cache in sync so subsequent scans use the new value
    const idx = profile.findIndex(p => p.id === id);
    if (idx >= 0) profile[idx] = updated;
    // Update the matchMap entry pointer too
    for (const [el, state] of matchMap) {
      if (state.entry?.id === id) {
        matchMap.set(el, { ...state, entry: updated });
      }
    }
  } catch {
    // Network/storage error — non-fatal; user can re-edit
  }
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
  applyHint(el, result, newEntry, sig);
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
    // Fill THIS frame first
    const local = fillAll();
    if (!isTopFrame) {
      // Sub-frame: just fill itself and return — top frame coordinates the rest
      sendResponse({ success: true, data: local });
      return false;
    }
    // Top frame: also broadcast to all iframes and aggregate
    let aggregateFilled  = local.filled;
    let aggregateSkipped = local.skipped;
    let responsesReceived = 0;
    let totalFramesAsked  = 0;
    let timeoutFired = false;

    const onFrameResult = (e: MessageEvent): void => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type !== 'sfa:fill-result') return;
      aggregateFilled += Number(d.filled) || 0;
      responsesReceived++;
      if (!timeoutFired && responsesReceived >= totalFramesAsked) {
        finalize();
      }
    };
    window.addEventListener('message', onFrameResult);

    const finalize = (): void => {
      timeoutFired = true;
      window.removeEventListener('message', onFrameResult);
      sendResponse({ success: true, data: { filled: aggregateFilled, skipped: aggregateSkipped } });
    };

    document.querySelectorAll('iframe').forEach((iframe) => {
      try {
        iframe.contentWindow?.postMessage({ type: 'sfa:fill-request' }, '*');
        totalFramesAsked++;
      } catch { /* ignore */ }
    });

    if (totalFramesAsked === 0) {
      finalize();
    } else {
      setTimeout(() => { if (!timeoutFired) finalize(); }, 800);
    }
    return true; // keep channel open for async response
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
