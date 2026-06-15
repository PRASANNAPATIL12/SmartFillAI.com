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
// Stable per-frame identifier. Origin + pathname is the same across content-script
// re-injections (about:blank → real URL transitions, SPA navigations within the
// iframe), so the top frame's report map overwrites rather than accumulating.
const FRAME_ID = isTopFrame
  ? '__top__'
  : `${location.origin}${location.pathname || '/'}`;

interface FrameReport { matched: number; total: number; unfilled: number; }
const frameReports = new Map<string, FrameReport>(); // only used in top frame
let myCounts: FrameReport = { matched: 0, total: 0, unfilled: 0 };

// Pending fill aggregation (top frame only)
let pendingFilled = 0;
let pendingFillTimer: ReturnType<typeof setTimeout> | undefined;

// Anti-flicker memoization + cooldown (top frame only)
// `lastBannerSig` is the signature of the most recently rendered banner —
// if a refresh would draw the same banner, we skip the DOM thrash. The
// cooldown blocks ready/empty banners from clobbering the success banner
// during its auto-dismiss window.
let lastBannerSig = '';
let bannerCooldownUntil = 0;

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

  // Prune dead element refs before rescanning. The SPA can replace form
  // nodes between MutationObserver ticks; stale entries would otherwise
  // accumulate and inflate the banner's "Fill N of M" counters.
  for (const el of Array.from(matchMap.keys())) {
    if (!el.isConnected) matchMap.delete(el);
  }

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
  // Count fields and matches in THIS frame.
  // `unfilled` = matched AND not yet filled by us (dataset.dittoFilled !== 'true').
  // The banner's CTA count is driven by `unfilled` so it disappears the
  // instant every match has been filled, instead of re-asserting itself
  // every time the MutationObserver ticks.
  let totalDetected = 0;
  let matched = 0;
  let unfilled = 0;
  for (const [el, state] of matchMap) {
    if (state.result.status === 'SKIP') continue;
    totalDetected++;
    if (state.result.status === 'MATCHED' && state.entry) {
      matched++;
      // A field is "unfilled" when it has no value. We check the value
      // directly (not the dataset marker) because React/Vue SPAs replace
      // DOM nodes on re-render, blowing away any dataset we set. The
      // value, in contrast, is restored from the framework's state.
      const v = (el as HTMLInputElement).value ?? '';
      if (v.trim() === '') unfilled++;
    }
  }
  console.log('[SmartFillAI] refreshBanner: detected', totalDetected, 'matched', matched, 'unfilled', unfilled, 'matchMap size', matchMap.size, 'isTopFrame:', isTopFrame);

  if (isTopFrame) {
    myCounts = { matched, total: totalDetected, unfilled };
    renderAggregatedBanner();
  } else {
    // Bubble up so the top frame can aggregate counts from all iframes
    try {
      window.top?.postMessage({
        type: 'sfa:frame-report',
        frameId: FRAME_ID,
        matched,
        totalDetected,
        unfilled,
      }, '*');
    } catch {
      // window.top inaccessible in sandboxed frames — silently ignore
    }
  }
}

function renderAggregatedBanner(): void {
  if (!isTopFrame) return;
  if (bannerDismissed) return;
  // While the success banner is up, don't let ready/empty banners overwrite it.
  if (Date.now() < bannerCooldownUntil) return;

  let totalMatched  = myCounts.matched;
  let totalDetected = myCounts.total;
  let totalUnfilled = myCounts.unfilled;
  for (const report of frameReports.values()) {
    totalMatched  += report.matched;
    totalDetected += report.total;
    totalUnfilled += report.unfilled;
  }
  console.log('[SmartFillAI] aggregated → matched', totalMatched, 'unfilled', totalUnfilled, 'total', totalDetected, 'frames reporting', frameReports.size);

  // Decide the next banner state up-front, then bail out if it's identical
  // to what's already on screen — that's how we kill the post-fill flicker.
  let nextSig: string;
  let kind: 'hide' | 'ready' | 'empty';

  if (totalDetected < 2) {
    nextSig = 'hide:few-fields';
    kind = 'hide';
  } else if (totalMatched === 0) {
    nextSig = `empty:${totalDetected}`;
    kind = 'empty';
  } else if (totalUnfilled === 0) {
    // Everything matchable is already filled — nothing to offer
    nextSig = 'hide:all-filled';
    kind = 'hide';
  } else {
    nextSig = `ready:${totalUnfilled}:${totalDetected}`;
    kind = 'ready';
  }

  if (nextSig === lastBannerSig) return; // no-op: avoids animation re-play

  lastBannerSig = nextSig;

  if (kind === 'hide') {
    if (bannerVisible) { hideBanner(); bannerVisible = false; }
    return;
  }

  bannerVisible = true;
  if (kind === 'ready') {
    showReadyBanner({
      matched: totalUnfilled,
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
  lastBannerSig   = '';
  hideBanner();
}

function triggerBannerFill(): void {
  showFillingBanner();
  pendingFilled = 0;
  // Block any re-render while the fill animation runs through to "Filled N fields"
  bannerCooldownUntil = Date.now() + 5000;
  // Top frame fills its own first, then broadcasts to iframes
  requestAnimationFrame(() => {
    fillAll().then((local) => {
      pendingFilled += local.filled;
      broadcastToAllIframes({ type: 'sfa:fill-request' });
      clearTimeout(pendingFillTimer);
      // Comboboxes can take ~500ms each; allow more time for iframes
      pendingFillTimer = setTimeout(() => {
        showSuccessBanner(pendingFilled);
        // Success banner auto-dismisses in 2500ms — keep the cooldown alive
        // for that whole window so the ready banner can't overwrite it.
        bannerCooldownUntil = Date.now() + 2800;
        // Force next render after cooldown to re-evaluate from scratch
        lastBannerSig = '';
        bannerVisible = false;
      }, 1200);
    }).catch(() => {
      showSuccessBanner(0);
      bannerCooldownUntil = Date.now() + 2800;
      lastBannerSig = '';
      bannerVisible = false;
    });
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
      matched:  Number(msg.matched) || 0,
      total:    Number(msg.totalDetected) || 0,
      unfilled: Number(msg.unfilled) || 0,
    });
    renderAggregatedBanner();
    return;
  }

  // Any frame: top frame asked us to fill
  if (msg.type === 'sfa:fill-request') {
    fillAll().then((result) => {
      try {
        window.top?.postMessage({
          type: 'sfa:fill-result',
          frameId: FRAME_ID,
          filled: result.filled,
        }, '*');
      } catch { /* ignore */ }
    });
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

async function fillAll(): Promise<{ filled: number; skipped: number }> {
  let filled = 0;
  let skipped = 0;

  // Sequential fills are deliberate — comboboxes need the listbox to
  // finish committing before we move on, and many sites tie focus
  // transitions to their internal state machines.
  for (const [el, state] of matchMap) {
    if (state.result.status !== 'MATCHED' || !state.entry) {
      skipped++;
      continue;
    }

    if (!document.contains(el)) {
      skipped++;
      continue;
    }

    const ok = await fillElement(
      el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      state.entry.value,
      state.entry.canonical_key
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

async function handlePillFill(target: { el: HTMLElement; entry?: ProfileEntry }): Promise<void> {
  if (!target.entry) return; // ESSAY pills have no entry
  const ok = await fillElement(
    target.el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    target.entry.value,
    target.entry.canonical_key
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
  // the user edits a pre-filled field to a different value. We listen for
  // both blur and change so combobox option-picks are caught even when
  // focus stays on the input.
  el.dataset.dittoPreFocusValue = (el as HTMLInputElement).value ?? '';
  el.addEventListener('focus', () => {
    el.dataset.dittoPreFocusValue = (el as HTMLInputElement).value ?? '';
  });

  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const tryUpdate = (): void => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      const currentValue = ((el as HTMLInputElement).value ?? '').trim();
      if (!currentValue) return;
      if (entry.sensitive) return; // never auto-update sensitive entries
      if (currentValue === entry.value) return; // unchanged
      if (currentValue === (el.dataset.dittoPreFocusValue ?? '').trim()) return;

      if (autoSave) {
        doUpdateEntry(entry.id, currentValue).catch(() => {});
        el.dataset.dittoPreFocusValue = currentValue; // dedup against blur
      } else {
        const label = entry.display_label || 'Field';
        showLearnPill({ el, label: `Update ${label}?`, value: currentValue });
      }
    }, 200);
  };

  el.addEventListener('blur',   tryUpdate);
  el.addEventListener('change', tryUpdate);
}

function attachLearnListeners(el: HTMLElement): void {
  if (el.dataset.dittoLearnListeners === 'true') return;
  el.dataset.dittoLearnListeners = 'true';

  // Capture the original value on focus so we know if user actually typed something
  el.addEventListener('focus', () => {
    el.dataset.dittoPreFocusValue = (el as HTMLInputElement).value ?? '';
  });

  // Debounced shared handler — fires from either `blur` or `change`. The
  // change event is critical for ARIA comboboxes (Degree, Country) where
  // the user clicks an option and focus often stays on the input — blur
  // never arrives, but change does.
  let learnTimer: ReturnType<typeof setTimeout> | undefined;
  const tryLearn = (): void => {
    clearTimeout(learnTimer);
    learnTimer = setTimeout(() => {
      // Skip if Ditto already filled this field
      if (el.dataset.dittoFilled === 'true') return;

      const currentValue = ((el as HTMLInputElement).value ?? '').trim();
      const preFocus     = (el.dataset.dittoPreFocusValue ?? '').trim();

      // Require a non-empty value that's different from the pre-focus value
      if (!currentValue || currentValue === preFocus) return;

      const state = matchMap.get(el);
      if (!state || state.result.status !== 'UNKNOWN') return;

      if (autoSave) {
        // Silent save — no confirm pill needed
        doLearnField(el, state.sig, currentValue).catch(() => {});
        // Update pre-focus baseline so a subsequent blur doesn't re-learn
        el.dataset.dittoPreFocusValue = currentValue;
      } else {
        const label = state.sig.label || state.sig.ariaLabel || state.sig.placeholder || state.sig.name || state.sig.id || 'Field';
        showLearnPill({ el, label, value: currentValue });
      }
    }, 200);
  };

  el.addEventListener('blur',   tryLearn);
  el.addEventListener('change', tryLearn);
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
    if (!isTopFrame) {
      // Sub-frame: fill self, report back, done
      fillAll().then((local) => sendResponse({ success: true, data: local }))
               .catch(() => sendResponse({ success: true, data: { filled: 0, skipped: 0 } }));
      return true;
    }
    // Top frame: fill self async, then broadcast to all iframes and aggregate
    let aggregateFilled  = 0;
    let aggregateSkipped = 0;
    let responsesReceived = 0;
    let totalFramesAsked  = 0;
    let finalized = false;

    const onFrameResult = (e: MessageEvent): void => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type !== 'sfa:fill-result') return;
      aggregateFilled += Number(d.filled) || 0;
      responsesReceived++;
      if (!finalized && responsesReceived >= totalFramesAsked) finalize();
    };
    window.addEventListener('message', onFrameResult);

    const finalize = (): void => {
      if (finalized) return;
      finalized = true;
      window.removeEventListener('message', onFrameResult);
      sendResponse({ success: true, data: { filled: aggregateFilled, skipped: aggregateSkipped } });
    };

    fillAll().then((local) => {
      aggregateFilled  = local.filled;
      aggregateSkipped = local.skipped;

      document.querySelectorAll('iframe').forEach((iframe) => {
        try {
          iframe.contentWindow?.postMessage({ type: 'sfa:fill-request' }, '*');
          totalFramesAsked++;
        } catch { /* ignore */ }
      });

      if (totalFramesAsked === 0) finalize();
      // Comboboxes take ~500ms; give iframes generous time
      else setTimeout(() => { if (!finalized) finalize(); }, 1500);
    }).catch(() => finalize());

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
    fillElement(
      el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      state.entry.value,
      state.entry.canonical_key,
    ).then((ok) => {
      if (ok) sendToBackground('RECORD_USE', { id: state.entry!.id }).catch(() => {});
      sendResponse({ success: ok });
    }).catch(() => sendResponse({ success: false }));
    return true;
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
