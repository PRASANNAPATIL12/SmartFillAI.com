// STEP 7.6 — Debug logging gate. Set window.__SFA_DEBUG = true in DevTools
// to opt into verbose logging. Default off so users don't see the noise.
const SFA_DEBUG = (window as unknown as { __SFA_DEBUG?: boolean }).__SFA_DEBUG === true;
const sfaLog = (...args: unknown[]): void => { if (SFA_DEBUG) console.log('[SmartFillAI]', ...args); };


sfaLog(
  'content script loaded on',
  location.href,
  '| isTopFrame:', window.top === window,
  '| parentOrigin:', (window.top === window) ? '(top)' : (() => { try { return document.referrer; } catch { return 'cross-origin'; } })()
);

import type { DocumentMeta, ProfileEntry, FieldCacheEntry, MatchResult, FieldSignature, UserSettings } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';
import { extractAllFields } from './detector';
import { matchField, fingerprint } from '@/matcher';
import { fillElement, fillFileInput } from './filler';
import { resolveHandler } from './field-handlers/registry';
import { classifyAnswerKind, getSeedAnswer } from './memory-asset';
import { detectCompany } from './company-detector';
import { sendToBackground } from './messenger';
import { fieldEmbedText } from '@/ml/step5';
import { initOverlay, initLearnOverlay, initEssayOverlay, showPill, showLearnPill, schedulePillHide, showEssayPanel, showUpdateOrAddPill, showAlternativesPanel, hideAlternativesPanel, isAlternativesPanelOpen } from './overlay';
import type { EssayTarget, AlternativeEntry } from './overlay';
import {
  showReadyBanner,
  showEmptyBanner,
  showFillingBanner,
  showSuccessBanner,
  hideBanner,
} from './overlay-banner';
import { showGhost, removeGhost, repositionAllGhosts, sweepDisconnectedGhosts } from './ghost-text';
import { isCombobox, isComboboxFilled, getComboboxDisplayValue, findListbox, peekOptions, ensureAllDropdownsClosed } from './combobox';
import { resolveCountry, stripCountryCode } from './country-aliases';
import { validateLearnedValue } from './value-validation';
import { getRememberedAnswer, rememberAnswer } from './qa-cache';

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
let scanTimer:    ReturnType<typeof setTimeout> | undefined;
let maxScanTimer: ReturnType<typeof setTimeout> | undefined;

// When the page has a separate phone_country_code field, the phone_number
// input expects only the local number. Scanning matchMap for a sibling
// country-code field tells us whether to strip the prefix at fill time.
function resolvePhoneValue(storedValue: string, canonicalKey: string): string {
  if (canonicalKey !== 'phone_number') return storedValue;
  let countryValue: string | null = null;
  for (const [, s] of matchMap) {
    if (s.entry?.canonical_key === 'phone_country_code') {
      countryValue = s.entry.value;
      break;
    }
  }
  if (!countryValue) return storedValue;
  return stripCountryCode(storedValue, countryValue);
}
let documentsMeta: DocumentMeta[] = [];
let autoSave               = true;  // default; overwritten after GET_SETTINGS resolves
let blockSensitiveDomains  = true;  // default safe; overwritten after GET_SETTINGS resolves

// Patterns matched against window.location.hostname when blockSensitiveDomains is on.
// Deliberately conservative — only obvious finance/health/gov sites.
const SENSITIVE_HOSTNAME_RE = /\b(bank(ing)?|paypal|chase|wellsfargo|capitalone|citibank|usbank|fidelity|vanguard|schwab|etrade|robinhood|brokerage|mychart|hospital|healthcare|irs\.gov|ssa\.gov)\b/;

function isSensitiveDomain(hostname: string): boolean {
  return SENSITIVE_HOSTNAME_RE.test(hostname);
}

// ── Banner state ──────────────────────────────────────────────────────────────
// Once the user dismisses the banner on this page load, don't re-show it.
let bannerDismissed = false;
// Avoid flicker if scan re-runs many times — only show once and update the count.
let bannerVisible = false;

// ── Fill-session state ────────────────────────────────────────────────────────
// hasFilled: permanent once the user clicks Fill. Any MATCHED field that
//   appears after that click — including conditional dropdowns revealed by user
//   interaction (e.g. race field after selecting "No" for Hispanic/Latino) —
//   is auto-filled immediately, regardless of how much time has passed.
let hasFilled = false;
let preFillSnapshot: Set<HTMLElement> = new Set();

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

// STEP 1.5 — Anti-spam: each frame tracks its last reported counts and
// skips redundant postMessage broadcasts. Without this, every 300ms-debounced
// MutationObserver tick in non-form iframes would re-send {matched:0,total:0,
// unfilled:0} to the top frame.
let lastReportedMatched  = -1;
let lastReportedTotal    = -1;
let lastReportedUnfilled = -1;

// ── Part 2: reliable learning for ARIA comboboxes + custom dropdowns ──────────
// ARIA comboboxes (Greenhouse, react-select, downshift, Workday) commit
// option selections via setState — no native blur/change event fires that
// our per-field listeners can hear. The fix is a unified learn path called
// from FOUR triggers: per-field blur/change (fast), document focusout
// (catches "user clicked somewhere else"), document submit (last chance
// before navigation), and a periodic 2.5s sweep (catches everything else).
const LEARN_SWEEP_INTERVAL_MS = 2500;
let learnSweepTimer: ReturnType<typeof setInterval> | undefined;

// ── Service-worker keep-alive ─────────────────────────────────────────────────
// MV3 service workers sleep after ~30 s of inactivity. We send a lightweight
// PING every 25 s so the SW stays warm while the user is on a form page.
// This is not a hard guarantee (Chrome can still evict under memory pressure),
// but it eliminates the most common cause of the SW going dark mid-session.
const SW_PING_INTERVAL_MS = 25_000;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function startKeepAlive(): void {
  if (keepAliveTimer !== undefined) return;
  keepAliveTimer = setInterval(() => {
    sendToBackground('PING').catch((err: unknown) => {
      // If the extension was updated the runtime context becomes invalid.
      // Stop pinging — the tab needs a reload to get a fresh content script.
      if (err instanceof Error && err.message.includes('Extension context invalidated')) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
      }
      // Other failures (SW briefly evicted) are fine — the next real message wakes it.
    });
  }, SW_PING_INTERVAL_MS);
}

// ── Profile loading with SW-sleep fallback ────────────────────────────────────
// If the service worker is asleep and takes too long to respond, messenger.ts
// rejects after 8 s. We fall back to a chrome.storage.local snapshot written
// on the last successful fetch, so the user still gets fills even if the SW
// is slow to wake. A background retry then refreshes the data once the SW is up.
const PROFILE_CACHE_KEY = STORAGE_KEYS.PROFILE_CS_CACHE;

async function loadProfile(): Promise<ProfileEntry[]> {
  // Fast path: background is awake.
  try {
    const entries = await sendToBackground<ProfileEntry[]>('GET_PROFILE');
    // Keep the local cache warm for the next SW-sleep scenario.
    chrome.storage.local.set({ [PROFILE_CACHE_KEY]: entries }).catch(() => {});
    sfaLog('profile loaded from background:', entries.length, 'entries');
    return entries;
  } catch (firstErr) {
    sfaLog('GET_PROFILE failed on first attempt:', firstErr);
  }

  // Slow path: SW wake-up race. Wait 1 s for it to finish starting, then retry.
  await new Promise(r => setTimeout(r, 1000));
  try {
    const entries = await sendToBackground<ProfileEntry[]>('GET_PROFILE');
    chrome.storage.local.set({ [PROFILE_CACHE_KEY]: entries }).catch(() => {});
    sfaLog('profile loaded from background (retry):', entries.length, 'entries');
    return entries;
  } catch (retryErr) {
    sfaLog('GET_PROFILE failed on retry too — falling back to local cache:', retryErr);
  }

  // Final fallback: use the locally cached snapshot from the last successful session.
  try {
    const stored = await chrome.storage.local.get(PROFILE_CACHE_KEY);
    const cached = stored[PROFILE_CACHE_KEY];
    if (Array.isArray(cached) && cached.length > 0) {
      sfaLog('profile loaded from local cache (SW was asleep):', cached.length, 'entries');
      // Re-try fetching fresh data in the background once the SW has had more
      // time to wake up. Re-scan with fresh data if it differs from the cache.
      setTimeout(() => {
        sendToBackground<ProfileEntry[]>('GET_PROFILE')
          .then(fresh => {
            chrome.storage.local.set({ [PROFILE_CACHE_KEY]: fresh }).catch(() => {});
            const changed = fresh.length !== (cached as ProfileEntry[]).length
              || fresh.some((e, i) => e.value !== (cached as ProfileEntry[])[i]?.value);
            if (changed) {
              profile = fresh;
              scanFields().catch(() => {});
            }
          })
          .catch(() => {});
      }, 2000);
      return cached as ProfileEntry[];
    }
  } catch {
    // chrome.storage unavailable — very unusual, proceed with empty profile
  }

  sfaLog('profile unavailable — proceeding with empty profile');
  return [];
}

// ── Document metadata loading (mirrors loadProfile pattern) ──────────────────
const DOCUMENTS_CACHE_KEY = STORAGE_KEYS.DOCUMENTS_META_CACHE;

async function loadDocumentsMeta(): Promise<DocumentMeta[]> {
  try {
    const metas = await sendToBackground<DocumentMeta[]>('GET_DOCUMENTS');
    chrome.storage.local.set({ [DOCUMENTS_CACHE_KEY]: metas }).catch(() => {});
    sfaLog('documents loaded from background:', metas.length);
    return metas;
  } catch {
    // SW might be asleep — try local cache
  }

  try {
    const stored = await chrome.storage.local.get(DOCUMENTS_CACHE_KEY);
    const cached = stored[DOCUMENTS_CACHE_KEY];
    if (Array.isArray(cached) && cached.length > 0) {
      sfaLog('documents loaded from local cache:', cached.length);
      return cached as DocumentMeta[];
    }
  } catch { /* proceed empty */ }

  return [];
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  sfaLog('init() started');
  injectStyles();

  // Keep the SW alive while we're on this page so subsequent operations
  // (learn, cache writes, embedding) don't hit the wake-up race.
  startKeepAlive();

  // Fetch profile (with SW-sleep fallback) and settings in parallel.
  // loadProfile() already handles its own retry + local-cache fallback,
  // so Promise.allSettled here is just for settings.
  // CRITICAL PATH: profile + settings. Both are required for ghost text + matching.
  // Documents are needed only for file fills, NOT for text/select fills or ghost text,
  // so we load them async after init completes — keeps SW-sleep latency off the
  // critical path so ghost text appears as quickly as possible after page refresh.
  const [fetchedProfile, fetchedSettings] = await Promise.allSettled([
    loadProfile(),
    sendToBackground<UserSettings>('GET_SETTINGS'),
  ]);

  sfaLog('profile entries loaded:', fetchedProfile.status === 'fulfilled' ? fetchedProfile.value.length : 'FAILED');

  profile                  = fetchedProfile.status  === 'fulfilled' ? fetchedProfile.value  : [];
  autoSave                 = fetchedSettings.status === 'fulfilled' ? fetchedSettings.value.autoSave              : true;
  blockSensitiveDomains    = fetchedSettings.status === 'fulfilled' ? fetchedSettings.value.blockSensitiveDomains : true;

  // Honour the sensitive-domain blocklist before touching the page.
  if (blockSensitiveDomains && isSensitiveDomain(window.location.hostname)) {
    sfaLog('blocked on sensitive domain:', window.location.hostname);
    return;
  }

  // Background-load documents; re-scan once they arrive so file fields pick up
  // their docType hints. Ghost text on text/select fields is unaffected.
  loadDocumentsMeta().then(metas => {
    documentsMeta = metas;
    if (metas.length > 0) scanFields().catch(() => {});
  }).catch(() => { documentsMeta = []; });

  profileLoaded = true;
  initOverlay(handlePillFill);
  initLearnOverlay(handleLearnSave);
  initEssayOverlay(handleEssayOpen);

  // When the user scrolls or resizes, ghost overlays must track their inputs.
  // repositionAllGhosts() now repositions existing ghosts in place instead of
  // wiping them — fixes the flakiness where the old wipe-then-rescan approach
  // lost ghosts whenever the rescan got cancelled by ongoing DOM mutations.
  const onReposition = (): void => {
    repositionAllGhosts();
  };
  window.addEventListener('scroll', onReposition, { passive: true });
  window.addEventListener('resize', onReposition);

  // Part 2/3 — Reliable learning. Four safety nets that catch dropdown
  // selections regardless of how the framework commits them:
  //   1. focusout — catches user moving focus away
  //   2. submit — fires before a form posts; chrome.runtime.sendMessage to
  //              the service worker survives the subsequent navigation
  //   3. pagehide + beforeunload — final escape hatch for SPA navigations
  //      that don't fire a submit event
  //   4. 2.5s periodic sweep — catches selections where focus never leaves
  document.addEventListener('focusout',     handleGlobalFocusOut,         true);
  document.addEventListener('submit',       handleGlobalSubmit,           true);
  document.addEventListener('mousedown',    handleListboxOptionMousedown,  true);
  window.addEventListener('beforeunload',   handleGlobalSubmit);
  window.addEventListener('pagehide',       handleGlobalSubmit);
  if (learnSweepTimer === undefined) {
    learnSweepTimer = setInterval(runLearnSweep, LEARN_SWEEP_INTERVAL_MS);
  }

  await scanFields();
  // Safety net: re-scan after page settles. React/Next.js hydration often
  // replaces nodes after our first scan completes — the MutationObserver catches
  // most but its 300ms debounce can be cancelled by ongoing mutations. Forced
  // re-scans at 800ms and 2500ms guarantee ghosts get a chance to render even
  // if the observer never lands a stable tick during early hydration.
  setTimeout(() => { scanFields().catch(() => {}); },  800);
  setTimeout(() => { scanFields().catch(() => {}); }, 2500);

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
  sfaLog('scanFields detected', fields.length, 'fields, profile has', profile.length, 'entries');
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

  // Phase 3: auto-fill conditional fields that appeared after the user first
  // clicked Fill (e.g., "visa type" shown after "sponsorship = Yes", or a race
  // dropdown revealed after selecting "No" for Hispanic/Latino). Fires whenever
  // hasFilled is true — not limited to the 3.5s fill-session window.
  if (hasFilled) {
    for (const [el, state] of matchMap) {
      if (!preFillSnapshot.has(el)
          && state.result.status === 'MATCHED'
          && state.entry
          && !el.dataset.dittoFilled
          && !(el as HTMLInputElement).disabled
          && !(el as HTMLInputElement).readOnly) {
        preFillSnapshot.add(el);  // prevent duplicate fill on concurrent scans
        const value = state.entry.value;
        const canonicalKey = state.entry.canonical_key;
        fillElement(el, value, canonicalKey).catch(() => {});
      }
    }
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
    if (state.result.status === 'FILE_UPLOAD' && state.result.docType) {
      const hasDoc = documentsMeta.some(d => d.docType === state.result.docType);
      if (hasDoc) {
        matched++;
        if (el.dataset.dittoFilled !== 'true') unfilled++;
      }
    } else if (state.result.status === 'MATCHED' && state.entry) {
      matched++;
      // STEP 6.4 — Comboboxes (react-select etc.) often clear input.value
      // after option click; the chosen label lives in a sibling display.
      // isComboboxFilled() checks the wrapper data flag + display element.
      // For plain inputs, fall back to checking input.value directly.
      const filled = isCombobox(el)
        ? isComboboxFilled(el)
        : ((el as HTMLInputElement).value ?? '').trim() !== '';
      if (!filled) unfilled++;
    }
  }
  sfaLog('refreshBanner: detected', totalDetected, 'matched', matched, 'unfilled', unfilled, 'matchMap size', matchMap.size, 'isTopFrame:', isTopFrame);

  if (isTopFrame) {
    myCounts = { matched, total: totalDetected, unfilled };
    renderAggregatedBanner();
  } else {
    // STEP 1.5 — skip the postMessage if our state hasn't changed since
    // the last broadcast. Cuts non-form-iframe spam from ~3/sec to ~0.
    if (
      lastReportedMatched  === matched &&
      lastReportedTotal    === totalDetected &&
      lastReportedUnfilled === unfilled
    ) {
      return;
    }
    lastReportedMatched  = matched;
    lastReportedTotal    = totalDetected;
    lastReportedUnfilled = unfilled;

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
  sfaLog('aggregated → matched', totalMatched, 'unfilled', totalUnfilled, 'total', totalDetected, 'frames reporting', frameReports.size);

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
  // STEP 1.3 — cooldown must outlast the full fill phase. A page with
  // multiple comboboxes (Country, Degree, State) needs ~2.5s for fills to
  // settle plus 2.8s of success-banner display = ~5.3s minimum.
  bannerCooldownUntil = Date.now() + 6500;

  // Phase 3: snapshot elements known BEFORE the fill so scanFields() can
  // auto-fill any NEW matched fields that appear after (conditional fields).
  hasFilled = true;
  preFillSnapshot = new Set(matchMap.keys());

  // Top frame fills its own first, then broadcasts to iframes
  requestAnimationFrame(() => {
    fillAll().then((local) => {
      pendingFilled += local.filled;
      broadcastToAllIframes({ type: 'sfa:fill-request' });
      // STEP 1.1 — recompute the top frame's own counts immediately
      refreshBanner();
      // STEP 1.2 — followup scan to catch any framework value-reverts
      setTimeout(() => { scanFields().catch(() => {}); }, 600);

      clearTimeout(pendingFillTimer);
      // STEP 1.3 — wait long enough for iframe combobox fills to finish.
      // Each combobox takes up to ~560ms; 5 fields is ~2.8s; 3.5s is safe.
      pendingFillTimer = setTimeout(() => {
        showSuccessBanner(pendingFilled);
        bannerCooldownUntil = Date.now() + 2800;
        lastBannerSig = '';
        bannerVisible = false;
        // STEP 1.4 — after the success banner finishes its auto-dismiss,
        // force a final aggregation pass so the now-correct unfilled=0
        // reading takes effect and the banner stays gone.
        setTimeout(() => { renderAggregatedBanner(); }, 2900);
      }, 3500);
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
      // STEP 1.1 — recompute counts now that values are set so the next
      // frame-report carries unfilled=0 (or close to it) up to the top
      // frame. MutationObserver does NOT fire on .value property writes,
      // so without this manual call the iframe never re-reports.
      refreshBanner();
      // STEP 1.2 — some frameworks (Greenhouse/React) revert programmatic
      // value writes on re-render; do a second pass after the dust settles
      // so we catch any reverts and either re-fill or re-report accurately.
      setTimeout(() => { scanFields().catch(() => {}); }, 600);
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
      // Skip question-style fields. They are NOT profile attributes, so
      // embedding-matching them to a profile entry (e.g. "Available to join"
      // → a stale "End date year" entry) is wrong. The Q→A cache / LLM path
      // owns these.
      const label = state.sig.label || state.sig.ariaLabel || state.sig.name || '';
      if (isQuestionLikeLabel(label)) continue;
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
      // Question-style fields aren't profile attributes — don't classify them
      // to a canonical_key. The Q→A cache (B.1) and the dedicated answer-LLM
      // path (B.4) handle these.
      const label = state.sig.label || state.sig.ariaLabel || state.sig.name || '';
      if (isQuestionLikeLabel(label)) continue;
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
  // Greenhouse and other React-based ATSes often do a second render pass
  // after the initial page load (async data fetch, route hydration). This
  // replaces the <input> elements with new ones, leaving matchMap with
  // detached (stale) element references. Filling a detached element is a
  // no-op — `document.contains(el)` returns false → every field is skipped
  // → `filled = 0` → the user has to click fill a second time.
  //
  // Fix: if any matched element is no longer in the DOM, prune the dead
  // refs and run a fresh scanFields() before proceeding. scanFields() will
  // detect the new live elements, rebuild matchMap, and re-show ghost text
  // at the correct positions — all before we touch a single input value.
  const hasStaleRefs = [...matchMap.keys()].some(el => !el.isConnected);
  if (hasStaleRefs) {
    for (const el of Array.from(matchMap.keys())) {
      if (!el.isConnected) matchMap.delete(el);
    }
    await scanFields();
  }

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
      el,
      resolvePhoneValue(state.entry.value, state.entry.canonical_key),
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

  // Q→A replay — UNKNOWN fields the user has answered before. Covers BOTH
  // dropdowns ("need sponsorship?", "worked here before?") AND free-text
  // questions ("Available to join (in days)?"). Look up the answer by the
  // question label; dropdowns select the matching option, text inputs get the
  // string set directly. This is the learn-and-reuse path for fields that
  // aren't profile attributes. No AI involved.
  for (const [el, state] of matchMap) {
    if (state.result.status === 'SKIP' || state.result.status === 'FILE_UPLOAD' || state.result.status === 'ESSAY') continue;
    if (!document.contains(el)) continue;
    if (el.dataset.dittoFilled === 'true') continue;

    const ariaRole2 = el.getAttribute('role');
    const isDropdown = el instanceof HTMLSelectElement || isCombobox(el)
      || el instanceof HTMLButtonElement || ariaRole2 === 'button'
      || ariaRole2 === 'combobox';
    const isChoiceGroup = (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))
      || ariaRole2 === 'radio' || ariaRole2 === 'checkbox' || ariaRole2 === 'switch';
    const isText = (el instanceof HTMLInputElement
                     && /^(text|email|tel|url|search|number|)$/.test(el.type))
                 || el instanceof HTMLTextAreaElement
                 || el.isContentEditable || ariaRole2 === 'textbox' || ariaRole2 === 'searchbox';
    if (!isDropdown && !isText && !isChoiceGroup) continue;
    if (isText) {
      const curVal = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? ((el as HTMLInputElement).value ?? '').trim()
        : (el.innerText ?? '').trim();
      if (curVal !== '') continue;
    }

    const label = state.sig.label || state.sig.ariaLabel || state.sig.placeholder
               || state.sig.name  || state.sig.id || '';
    if (!label) continue;

    let remembered = await getRememberedAnswer(label);
    if (!remembered) {
      try {
        const fuzzy = await sendToBackground<{ answer: string | null; similarity?: number; matchedQuestion?: string }>(
          'FUZZY_QA_MATCH', { question: label }
        );
        if (fuzzy?.answer) {
          remembered = fuzzy.answer;
        }
      } catch { /* embedding model not ready — skip fuzzy */ }
    }
    if (!remembered) continue;

    // Narrative answers (essays, "why us") must be tailored to THIS company —
    // don't paste the prior employer's wording verbatim. When a company is
    // detectable, defer to the LLM tier, which re-synthesizes using this
    // remembered answer as a seed. Factual answers always replay verbatim.
    if (classifyAnswerKind(label, el) === 'narrative' && detectCompany().name) {
      continue;
    }

    const ok = await fillElement(el, remembered);
    if (ok) filled++;
  }

  // ── Final tier: LLM (Gemini) answers questions with no prior answer ──────────
  // Only reached for still-UNKNOWN dropdowns + question-style text fields that
  // the user has never answered (no qa-cache hit). Gemini answers from the
  // profile + resume; the answer is cached so the NEXT visit is a free qa hit.
  // Capped per fill to bound cost/latency; failures leave the field blank.
  const companyName = detectCompany().name;
  let llmCalls = 0;
  const LLM_CALL_CAP = 10;
  sfaLog('LLM tier: starting, company =', companyName || '(none)');
  for (const [el, state] of matchMap) {
    if (llmCalls >= LLM_CALL_CAP) break;
    if (state.result.status === 'SKIP' || state.result.status === 'FILE_UPLOAD' || state.result.status === 'ESSAY') continue;
    if (!document.contains(el)) continue;
    if (el.dataset.dittoFilled === 'true') continue;

    const ariaRole3 = el.getAttribute('role');
    const isDropdown = el instanceof HTMLSelectElement || isCombobox(el)
      || el instanceof HTMLButtonElement || ariaRole3 === 'button'
      || ariaRole3 === 'combobox';
    const isText = (el instanceof HTMLInputElement
                     && /^(text|email|tel|url|search|number|)$/.test(el.type))
                 || el instanceof HTMLTextAreaElement
                 || el.isContentEditable || ariaRole3 === 'textbox' || ariaRole3 === 'searchbox';
    const isChoiceGroup = (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))
      || ariaRole3 === 'radio' || ariaRole3 === 'checkbox' || ariaRole3 === 'switch';
    if (!isDropdown && !isText && !isChoiceGroup) continue;
    if (isText) {
      const curVal = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? ((el as HTMLInputElement).value ?? '').trim()
        : (el.innerText ?? '').trim();
      if (curVal !== '') continue;
    }

    const label = state.sig.label || state.sig.ariaLabel || state.sig.placeholder
               || state.sig.name  || state.sig.id || '';
    if (!label) continue;

    // Tiered reuse: narrative fields (essays, "why us") synthesize from a prior
    // answer (seed) adapted to this company; factual fields answer from profile.
    const kind = classifyAnswerKind(label, el);
    const seed = (kind === 'narrative' && companyName) ? await getSeedAnswer(label) : null;

    // Text fields only go to the LLM if they're actually QUESTIONS, already
    // MATCHED (matcher identified it as answerable), OR narrative with a seed.
    if (isText && state.result.status !== 'MATCHED' && !isQuestionLikeLabel(label) && !(kind === 'narrative' && seed)) continue;

    // Options for the LLM (so it returns a valid choice verbatim).
    let options: string[] = [];
    if (isDropdown || isChoiceGroup) {
      options = (state.sig.options && state.sig.options.length) ? state.sig.options : [];
      if (options.length === 0 && isDropdown) {
        const PEEK_KEYWORDS = /country|state|city|gender|degree|authoriz|sponsor|experience|education|notice|period|relocat|remote|visa|employ|status|language|ethni|race|veteran|disab/i;
        if (PEEK_KEYWORDS.test(label) || isQuestionLikeLabel(label)) {
          try { options = await peekOptions(el); } catch { options = []; }
          await ensureAllDropdownsClosed(el);
        }
      }
      if (options.length === 0 && isDropdown) continue;
    }

    llmCalls++;
    sfaLog('LLM tier: asking', label, '| status:', state.result.status,
           '| options:', options.length ? options : '(free text)', '| kind:', kind);
    let resp: { answer: string | null; confidence: number } | null = null;
    try {
      resp = await sendToBackground<{ answer: string | null; confidence: number }>(
        'ANSWER_FIELD', { question: label, options, company: companyName || undefined, seedAnswer: seed || undefined }
      );
    } catch (err) {
      sfaLog('LLM tier: ANSWER_FIELD error for', label, '|', err);
      resp = null;
    }
    if (!resp?.answer) {
      sfaLog('LLM tier: no answer for', label);
      continue;
    }

    sfaLog('LLM tier: answered', label, '→', resp.answer, '(confidence:', resp.confidence, ')');
    const ok = await fillElement(el, resp.answer);
    sfaLog('LLM tier: fill', ok ? 'OK' : 'FAILED', label);
    if (ok) {
      filled++;
      // Cache factual answers so the next visit is a free qa-cache hit. Do NOT
      // cache narrative answers: they're company-specific, and re-synthesizing
      // from the user's ORIGINAL seed each visit avoids company-to-company drift.
      if (kind !== 'narrative') {
        rememberAnswer(label, resp.answer, 'llm').catch(() => {});
        sendToBackground('STORE_QA_EMBEDDING', { question: label }).catch(() => {});
      }
    }
  }
  sfaLog('LLM tier: done, calls made:', llmCalls);

  // File-fill loop — attach documents to file upload fields and dropzones.
  // `el` may be HTMLInputElement (visible OR hidden native input) or a
  // <div data-ditto-dropzone="true"> for drag-drop zones.
  for (const [el, state] of matchMap) {
    if (state.result.status !== 'FILE_UPLOAD' || !state.result.docType) continue;
    if (!document.contains(el)) continue;
    if (el.dataset.dittoFilled === 'true') continue;

    const doc = documentsMeta.find(
      d => d.docType === state.result.docType && d.isDefault
    ) ?? documentsMeta.find(d => d.docType === state.result.docType);

    if (!doc) {
      sfaLog('file fill: no doc for type', state.result.docType,
        '(documentsMeta size:', documentsMeta.length, ')');
      continue;
    }

    // Runtime accept-attribute gate — skip if the input explicitly excludes
    // our document type. Matcher already rejects image-only inputs at scan
    // time, but accept can change between scan and fill (SPA re-renders).
    if (el instanceof HTMLInputElement && el.accept &&
        !acceptAllowsFile(el.accept, doc.mimeType, doc.fileName)) {
      sfaLog('file fill: accept gate rejected', el.accept, doc.mimeType, doc.fileName);
      continue;
    }

    try {
      const resp = await sendToBackground<{ base64: string }>(
        'GET_DOCUMENT_BYTES', { id: doc.id }
      );
      if (!resp?.base64) continue;

      const binary = atob(resp.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const ok = fillFileInput(el, bytes.buffer, doc.fileName, doc.mimeType);
      if (ok) filled++;
    } catch (err) {
      sfaLog('file fill: threw', err);
    }
  }

  return { filled, skipped };
}

/** True if the input's `accept` attribute permits the given file. */
function acceptAllowsFile(accept: string, mimeType: string, fileName: string): boolean {
  if (!accept) return true;
  const mimeL = mimeType.toLowerCase();
  const ext   = (fileName.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  const tokens = accept.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    if (tok.startsWith('.') && tok === ext) return true;
    if (tok.endsWith('/*')  && mimeL.startsWith(tok.slice(0, -1))) return true;
    if (tok === mimeL) return true;
  }
  return false;
}

// ── Pill fill callback ────────────────────────────────────────────────────────

async function handlePillFill(target: { el: HTMLElement; entry?: ProfileEntry }): Promise<void> {
  if (!target.entry) return; // ESSAY pills have no entry
  const ok = await fillElement(
    target.el,
    resolvePhoneValue(target.entry.value, target.entry.canonical_key),
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
  // For comboboxes: check the live display value — NOT the dittoFilled marker —
  // to decide whether the field still has a committed selection.
  // dittoFilled on the element and its ancestors is cleared when the field
  // is empty (so CSS outline reverts to "unfilled") and preserved when a
  // selection is shown (so the outline stays "filled" across rescans).
  if (isCombobox(el)) {
    const hasCommittedValue = getComboboxDisplayValue(el).length > 0;
    if (!hasCommittedValue) {
      // Clear the marker on el and its ancestors (set by markFilled in combobox.ts)
      delete el.dataset.dittoFilled;
      let node: HTMLElement | null = el.parentElement;
      for (let d = 0; d < 6 && node; d++) {
        delete node.dataset.dittoFilled;
        const r = node.getAttribute('role');
        if (r === 'combobox' || r === 'listbox') break;
        node = node.parentElement;
      }
    }
    // If hasCommittedValue, leave dittoFilled markers alone — they're correct.
  } else {
    delete el.dataset.dittoFilled;
  }

  // Clear previous state
  delete el.dataset.dittoMatch;
  delete el.dataset.dittoKey;
  delete el.dataset.dittoStatus;

  el.dataset.dittoStatus = result.status;

  if (result.status === 'MATCHED' && entry) {
    el.dataset.dittoMatch = 'true';
    el.dataset.dittoKey = entry.canonical_key;
    attachPillListeners(el, entry, result);
    // Alternatives panel listener — wired independently of dittoListeners so it
    // gets attached on every applyHint call (including after ADD_ALTERNATIVE).
    // openAlternativesPanel is a no-op when count < 2, so safe to wire always.
    if (!el.dataset.dittoAltsWired) {
      el.dataset.dittoAltsWired = 'true';
      // focus covers Tab-navigation entry; click covers re-clicking a field that
      // is already focused (the common "I want to change my selection" gesture).
      // Without the click handler the user must blur then re-click to reopen.
      el.addEventListener('focus', () => openAlternativesPanel(el, entry));
      el.addEventListener('click', () => {
        if (!isAlternativesPanelOpen()) openAlternativesPanel(el, entry);
      });
      el.addEventListener('blur',  () => setTimeout(hideAlternativesPanel, 150));
    }
    // Ghost text preview — show value (masked for sensitive entries).
    // Skip dropdowns entirely: the profile value ("India") rarely matches
    // what the option text shows ("India +91"), so a ghost preview would be
    // misleading. Native <select> and button-dropdowns aren't input/textarea
    // so they're already excluded; isCombobox() catches role=combobox inputs.
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !isCombobox(el)
        && !(el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))) {
      const preview = entry.sensitive ? '•••••' : resolvePhoneValue(entry.value, entry.canonical_key);
      const altCount = (result.alternativeCount ?? 1) - 1;
      const suffix = altCount > 0 ? ` (+${altCount})` : '';
      showGhost(el, preview + suffix);
    }
  } else if (result.status === 'FILE_UPLOAD') {
    el.dataset.dittoMatch = 'file';
    if (result.docType) el.dataset.dittoDocType = result.docType;
    const doc = documentsMeta.find(
      d => d.docType === result.docType && d.isDefault
    ) ?? documentsMeta.find(d => d.docType === result.docType);
    if (doc) el.dataset.dittoDocName = doc.fileName;
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

  // Read current state from matchMap at event time — NOT from the closure.
  // The closure would freeze entry/result at first-attach; matchMap is kept
  // up-to-date by every learn/update/select path so the pill always shows
  // the current stored value.
  const show = (): void => {
    const cur = matchMap.get(el);
    if (cur?.entry) showPill({ el, entry: cur.entry, result: cur.result });
    else showPill({ el, entry, result });
  };
  const hide = (): void => schedulePillHide(400);

  el.addEventListener('mouseenter', show);
  el.addEventListener('focus',      show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur',       hide);

  // Update-detection — capture the value at focus time so tryLearnField can
  // tell whether the user actually changed the field during this interaction.
  // For comboboxes, input.value is empty (react-select manages it internally);
  // read the display label from the DOM instead so the guard fires correctly.
  const capturePreFocus = (): string =>
    resolveHandler(el).capture(el) ?? '';
  el.dataset.dittoPreFocusValue = capturePreFocus();
  el.addEventListener('focus', () => {
    el.dataset.dittoPreFocusValue = capturePreFocus();
  });

  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  const trigger = (): void => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => tryLearnField(el), 200);
  };

  el.addEventListener('blur',   trigger);
  el.addEventListener('change', trigger);
}

// ── Unified learn / update entrypoint ─────────────────────────────────────────
// Called from FOUR places (per-element blur/change, document focusout, document
// submit, periodic sweep). All converge here so dedup logic lives in one spot.
//
// Branches on the field's current matchMap state:
//   UNKNOWN  → create a new profile entry (learn)
//   MATCHED  → update the existing entry if the value has changed (update)
//
// Dedup uses `dataset.dittoLastLearnedValue` (for learn) and the existing
// `dataset.dittoPreFocusValue` (for update). Both prevent the same value
// being saved twice across rapid event fires (blur + change + focusout).
/**
 * True when a label reads like a form QUESTION rather than a profile attribute.
 * Questions ("Are you authorized…?", "Available to join (in days)?", "How did
 * you hear about us?") are remembered in the Q→A cache keyed by the question,
 * NOT learned as canonical profile entries. Mirrors matcher.ts's incidental-
 * noun guard so classification and learning agree.
 */
function isQuestionLikeLabel(label: string): boolean {
  const t = (label || '').trim();
  if (!t) return false;
  if (/\?/.test(t)) return true;
  if (/\b(are|do|does|did|have|has|will|would|can|could|should|is|was|were|how|what|why|when|which|where)\b/i.test(t)
      && /\byou\b/i.test(t)) return true;
  // A long label that matched no rule is almost always a bespoke question.
  return t.split(/\s+/).length > 4;
}

function tryLearnField(el: HTMLElement): void {
  if (!el.isConnected) return;

  // Raw .value on a checkbox/radio is a control ID — meaningless. Both kinds
  // are now intercepted by their group handlers, whose capture() reads the
  // checked LABEL(s) ("Male"/"Yes"/"Supplychain, Industrial AI") which IS
  // meaningful. So no skip-guard here; the handler abstraction protects us.

  // NOTE: do NOT guard on dittoFilled here. That marker is preserved on comboboxes
  // as long as they show a committed value. Blocking on it would permanently prevent
  // user-initiated dropdown changes from updating the profile after an auto-fill.
  // The guards below (value === entry.value, dittoLastLearnedValue, preFocus) are
  // sufficient to prevent spurious re-saves of what the extension just filled.

  // STEP 6.5 — Use the full isCombobox() detection from combobox.ts so we
  // don't skip combobox-like elements when focus stays on them after the
  // user picks an option (the most common pattern in react-select / Greenhouse).
  const comboLike = isCombobox(el) || el.getAttribute('role') === 'combobox';
  // Radio/checkbox groups have no "mid-typing" state, so learning while one is
  // focused is safe (bypass the guard, like comboboxes). Plain text fields keep
  // the guard.
  const isChoice = (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))
    || el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox'
    || el.getAttribute('role') === 'switch';
  if (document.activeElement === el && !comboLike && !isChoice) return;

  const state = matchMap.get(el);
  if (!state) return;

  // STEP 6.6 — For comboboxes, the chosen value may live in a sibling
  // display element instead of input.value. Button-triggered pickers show
  // their selection as textContent (e.g. "+91" or "🇮🇳 India").
  const isButton = el instanceof HTMLButtonElement || el.getAttribute('role') === 'button'
    || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT');
  // Capture the user's value via the field-kind handler. The handler's capture()
  // maps 1:1 to the previous inline ternary (combobox → display value, button →
  // textContent, select/text → .value), so behavior is unchanged.
  const rawValue = resolveHandler(el).capture(el) ?? '';
  const value    = rawValue.trim();

  // A combobox/button that reads back as just a calling code ("+1", "+246")
  // is the mis-read collapsed display of a country/phone picker. The reliable
  // value comes from the clicked-option capture (learnDropdownSelection), not
  // from this display read — so don't learn the garbage here.
  if ((comboLike || isButton) && /^\+\d{1,4}$/.test(value)) return;

  if (!value) return;

  // ── UNKNOWN → learn ──
  if (state.result.status === 'UNKNOWN') {
    if (el.dataset.dittoLastLearnedValue === value) return; // already tried
    el.dataset.dittoLastLearnedValue = value;
    // Universal sanity check at LEARN time (catches the "entire option list
    // captured as value" bug: length > 200, multi-newline, multiple "+NN").
    if (!validateLearnedValue(undefined, value)) {
      sfaLog('learn rejected: bad value shape', value.slice(0, 80));
      return;
    }

    const label = state.sig.label || state.sig.ariaLabel || state.sig.placeholder
               || state.sig.name  || state.sig.id        || 'Field';

    // Question-style or long labels are NOT profile attributes — they're
    // form questions ("Available to join (in days)?", "How did you hear…?").
    // Remember the answer keyed by the question (qa-cache) and KEEP IT OUT of
    // the canonical profile, so we never create junk entries like
    // "end date year = 35 days". Short attribute-ish labels still flow into
    // the profile so genuine custom fields (a new social link, etc.) enrich it.
    if (isQuestionLikeLabel(label)) {
      rememberAnswer(label, value).catch(() => {});
      sendToBackground('STORE_QA_EMBEDDING', { question: label }).catch(() => {});
      return;
    }

    if (autoSave) {
      sfaLog('learn:', label, '=', value);
      doLearnField(el, state.sig, value).catch(() => {});
    } else {
      showLearnPill({ el, label, value });
    }
    return;
  }

  // ── MATCHED → multi-value Update-or-Add flow ──
  if (state.result.status === 'MATCHED' && state.entry) {
    if (state.entry.sensitive) return;
    const normalizedValue = normalizeLearnedValue(value, state.entry.canonical_key);
    if (normalizedValue === state.entry.value) return;
    const preFocus = (el.dataset.dittoPreFocusValue ?? '').trim();
    if (preFocus && normalizedValue === normalizeLearnedValue(preFocus, state.entry.canonical_key)) return;
    if (el.dataset.dittoLastLearnedValue === normalizedValue) return;
    if (el.dataset.dittoUpdatePromptShown === normalizedValue) return;
    if (!validateLearnedValue(state.entry.canonical_key, normalizedValue)) {
      sfaLog('update rejected: bad value shape for', state.entry.canonical_key, '→', normalizedValue.slice(0, 80));
      return;
    }
    el.dataset.dittoLastLearnedValue = normalizedValue;
    el.dataset.dittoUpdatePromptShown = normalizedValue;

    const canonicalKey = state.entry.canonical_key;
    const displayLabel = state.entry.display_label || 'Field';
    const entryId = state.entry.id;

    (async () => {
      try {
        const isDup = await sendToBackground<boolean>('CHECK_DUPLICATE_VALUE', {
          canonicalKey, value: normalizedValue,
        });
        if (isDup) return;

        const count = (await sendToBackground<ProfileEntry[]>('GET_ALTERNATIVES', { canonicalKey })).length;
        const maxAlts = 5;

        if (count >= maxAlts) {
          sfaLog('update (cap reached):', displayLabel, '→', normalizedValue);
          doUpdateEntry(entryId, normalizedValue).catch(() => {});
          el.dataset.dittoPreFocusValue = normalizedValue;
          return;
        }

        showUpdateOrAddPill({
          el,
          label: displayLabel,
          oldValue: state.entry!.value,
          newValue: normalizedValue,
          onUpdate: () => {
            sfaLog('update:', displayLabel, '→', normalizedValue);
            doUpdateEntry(entryId, normalizedValue).catch(() => {});
            el.dataset.dittoPreFocusValue = normalizedValue;
          },
          onAdd: () => {
            sfaLog('add alternative:', displayLabel, '→', normalizedValue);
            sendToBackground<ProfileEntry>('ADD_ALTERNATIVE', {
              canonicalKey,
              value: normalizedValue,
              displayLabel,
              category: state.entry!.category,
            }).then(newEntry => {
              // Update local profile so openAlternativesPanel sees it immediately
              profile.push(newEntry);
              chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profile }).catch(() => {});
            }).catch(() => {});
          },
        });
      } catch {
        // Fallback: silent update if background is unavailable
        doUpdateEntry(entryId, normalizedValue).catch(() => {});
      }
    })();
  }
}

/**
 * Normalize a learned country/phone-code value to its canonical country name.
 * Strips emoji flag prefixes and "+NNN" calling-code suffixes, then resolves
 * via the country lookup table.  Returns the value unchanged for non-country keys.
 *
 * Examples:
 *   "🇮🇳 India +91", key="country"             → "India"
 *   "India +91",     key="phone_country_code"   → "India"
 *   "John Smith",    key="first_name"            → "John Smith"
 */
function normalizeLearnedValue(value: string, canonicalKey: string): string {
  if (canonicalKey !== 'country' && canonicalKey !== 'phone_country_code') return value;
  let v = value.trim();
  v = v.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim();  // strip flag emoji
  v = v.replace(/\s*\+\d{1,4}\s*$/, '').trim();               // strip +NNN suffix
  if (!v) return value;
  const resolved = resolveCountry(v);
  return resolved ? resolved.name : v;
}

// Periodic sweep — catches dropdown selections where neither blur nor change
// fires (focus stays on the input after option click).
//
// Also processes MATCHED comboboxes: per-element blur/change listeners don't
// reliably fire for react-select (the library manages focus internally), so the
// sweep is the safety net for detecting when a user changed a previously-saved
// combobox value (e.g. changed Country from India → United States).
function runLearnSweep(): void {
  for (const [el, state] of matchMap) {
    if (state.result.status === 'SKIP') continue;
    if (state.result.status === 'UNKNOWN') {
      tryLearnField(el);
    } else if (state.result.status === 'MATCHED') {
      // Sweep MATCHED comboboxes, button-triggered pickers (phone country code),
      // and radio/checkbox groups — none reliably fire blur/change on the
      // representative element when the user toggles another member.
      if (isCombobox(el) || el instanceof HTMLButtonElement || el.getAttribute('role') === 'button'
          || el.getAttribute('role') === 'combobox'
          || (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox'))
          || el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox'
          || el.getAttribute('role') === 'switch') {
        tryLearnField(el);
      }
    }
  }
}

// Global focus-out — fires whenever ANY element loses focus. Fastest path
// for the "user clicked an option and then clicked elsewhere" pattern.
function handleGlobalFocusOut(e: FocusEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  // Comboboxes (react-select, Greenhouse) need more time: focusout fires during
  // mousedown on the option (before React commits the selection). 200ms is
  // enough for React 17/18 to update the single-value display node.
  // Plain inputs: 100ms is sufficient for native change events to settle.
  const delay = isCombobox(target as HTMLElement) ? 200 : 100;
  setTimeout(() => tryLearnField(target), delay);
}

// Global submit — last-chance learn before the page navigates away.
function handleGlobalSubmit(): void {
  for (const [el] of matchMap) {
    tryLearnField(el);
  }
}

// Direct option-click capture — the most timing-reliable learn trigger.
//
// Rationale: focusout fires the moment the user presses the mouse button on an
// option (before React has re-rendered), and tryLearnField called 100ms later
// may still see the OLD single-value text (or none at all if React is mid-render).
// By listening on mousedown in capture phase we know EXACTLY when an option was
// chosen, and we delay 200ms — long enough for React 17/18 to commit the new
// selection text into the single-value DOM node before we read it.
//
// Safe to call tryLearnField on ALL comboboxes: the dedup logic inside
// (dittoLastLearnedValue check + profile-value comparison) prevents double-saves.
function handleListboxOptionMousedown(e: MouseEvent): void {
  // Only genuine USER clicks — our own programmatic clickOption() dispatches
  // mousedown with isTrusted=false. Without this guard we'd "learn" whatever
  // WE just auto-filled, creating feedback loops.
  if (!e.isTrusted) return;

  const target = e.target as HTMLElement | null;
  if (!target) return;

  const optionEl = target.closest('[role="option"]') as HTMLElement | null;
  if (!optionEl) return;

  // Capture the FULL text of the option the user actually clicked
  // ("India +91", "Yes - I currently work at Databricks") — this is reliable,
  // unlike reading the collapsed widget afterward (which yields just "+91"/"+1").
  const optionText = (optionEl.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!optionText) return;

  const listbox = optionEl.closest('[role="listbox"]') as HTMLElement | null;

  // Snapshot the active element synchronously at mousedown time, BEFORE the
  // dropdown closes. Angular Material CDK overlays use RestoreFocus: they
  // return focus to whatever element was active before the overlay opened.
  // Reading document.activeElement inside the 60 ms timeout would get that
  // restored element — potentially the last autofilled combobox, not the
  // field the user actually clicked — causing wrong label associations like
  // "Current Location = Yes". Capturing it NOW avoids the mismatch.
  const activeAtMousedown = document.activeElement as HTMLElement | null;

  setTimeout(() => {
    let owner: HTMLElement | null = null;

    // Primary: the element that was active WHEN the user clicked the option.
    // For React-select the input stays focused throughout; for Angular Material
    // the trigger element is active while the panel is open. Either way the
    // synchronous snapshot is the field that owns this dropdown.
    if (activeAtMousedown && matchMap.has(activeAtMousedown) && isCombobox(activeAtMousedown)) {
      owner = activeAtMousedown;
    }

    // Fallback: reverse lookup via aria-owns/aria-controls on the listbox ID.
    // Angular Material portals are appended to <body> so DOM-walk won't find
    // them, but the trigger element references them by ID.
    if (!owner && listbox?.id) {
      for (const [el] of matchMap) {
        if (isCombobox(el)
            && (el.getAttribute('aria-owns') === listbox.id
                || el.getAttribute('aria-controls') === listbox.id)) {
          owner = el;
          break;
        }
      }
    }

    // Fallback: DOM search for a matchMap combobox whose findListbox() resolves
    // to this listbox (works for react-select siblings, aria-controls).
    if (!owner && listbox) {
      for (const [el] of matchMap) {
        if (isCombobox(el) && findListbox(el) === listbox) {
          owner = el;
          break;
        }
      }
    }

    if (owner) learnDropdownSelection(owner, optionText);
  }, 60);
}

/**
 * Learn a dropdown selection from the EXACT option text the user clicked.
 * Reliable because it doesn't depend on reading the collapsed widget display.
 *
 * Two stores, both updated:
 *   1. Q→A memory (qa-cache) keyed by the question/label — lets question-style
 *      dropdowns ("need sponsorship?", "worked here before?") be replayed on
 *      any site next time.
 *   2. Canonical profile (for attribute dropdowns — country, gender, etc.) via
 *      the normal learn/update path so they flow into the profile + sync.
 */
function learnDropdownSelection(el: HTMLElement, optionText: string): void {
  const state = matchMap.get(el);
  if (!state) return;
  const label = state.sig.label || state.sig.ariaLabel || state.sig.placeholder
             || state.sig.name  || state.sig.id || '';

  // 1. Always remember the answer keyed by the question text (works for both
  //    question-style dropdowns AND attribute dropdowns).
  if (label) {
    rememberAnswer(label, optionText).catch(() => {});
    sendToBackground('STORE_QA_EMBEDDING', { question: label }).catch(() => {});
  }

  // 2. Attribute dropdowns also flow into the canonical profile — but NOT
  //    question-style ones ("need sponsorship?", "worked here?"), which would
  //    otherwise create junk profile entries. Those live in qa-cache only.
  if (state.result.status === 'UNKNOWN') {
    if (isQuestionLikeLabel(label)) return; // qa-cache already has it
    if (el.dataset.dittoLastLearnedValue === optionText) return;
    el.dataset.dittoLastLearnedValue = optionText;
    if (!validateLearnedValue(undefined, optionText)) return;
    if (autoSave) {
      doLearnField(el, state.sig, optionText).catch(() => {});
    } else {
      showLearnPill({ el, label: label || 'Field', value: optionText });
    }
    return;
  }

  if (state.result.status === 'MATCHED' && state.entry) {
    if (state.entry.sensitive) return;
    const normalized = normalizeLearnedValue(optionText, state.entry.canonical_key);
    if (normalized === state.entry.value) return;
    if (!validateLearnedValue(state.entry.canonical_key, normalized)) return;
    if (el.dataset.dittoLastLearnedValue === normalized) return;
    el.dataset.dittoLastLearnedValue = normalized;
    if (autoSave) {
      doUpdateEntry(state.entry.id, normalized).catch(() => {});
      el.dataset.dittoPreFocusValue = normalized;
    } else {
      showLearnPill({ el, label: `Update ${state.entry.display_label || 'field'}?`, value: normalized });
    }
  }
}

function attachLearnListeners(el: HTMLElement): void {
  if (el.dataset.dittoLearnListeners === 'true') return;
  el.dataset.dittoLearnListeners = 'true';

  // Capture the original value on focus so we know if user actually typed something
  el.addEventListener('focus', () => {
    el.dataset.dittoPreFocusValue = (el as HTMLInputElement).value ?? '';
  });

  // Per-element fast path — debounced blur+change. The global focusout
  // listener and 2.5s sweep are the safety nets that catch ARIA combobox
  // option-picks (where blur/change don't reliably fire).
  let learnTimer: ReturnType<typeof setTimeout> | undefined;
  const trigger = (): void => {
    clearTimeout(learnTimer);
    learnTimer = setTimeout(() => tryLearnField(el), 200);
  };

  el.addEventListener('blur',   trigger);
  el.addEventListener('change', trigger);
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
  } catch (err) {
    // LEARN_FIELD refused this as a profile attribute — typically because the
    // canonical_key would be junk (Greenhouse-style synthetic names like
    // "question_18957398004"). Don't lose the user's input: remember it as a
    // Q→A asset keyed by the visible label. ANY field becomes a memory asset.
    const msg = String((err as Error)?.message ?? '');
    if (/junk canonical|Refusing to learn/i.test(msg)) {
      const label = sig.label || sig.ariaLabel || sig.placeholder || '';
      if (label && value) {
        rememberAnswer(label, value).catch(() => {});
        sendToBackground('STORE_QA_EMBEDDING', { question: label }).catch(() => {});
      }
    }
    // Other errors (sensitive field, background unavailable) silently ignored.
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
    // Persist updated profile to local cache so the next SW-sleep scenario
    // gets the correct (post-edit) values immediately.
    chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profile }).catch(() => {});
  } catch {
    // Network/storage error — non-fatal; user can re-edit
  }
}

async function openAlternativesPanel(el: HTMLElement, currentEntry: ProfileEntry): Promise<void> {
  try {
    const all = await sendToBackground<ProfileEntry[]>('GET_ALTERNATIVES', {
      canonicalKey: currentEntry.canonical_key,
    });
    if (all.length < 2) return;

    const entries: AlternativeEntry[] = all
      .filter(e => (e.priority ?? 999) < 999)
      .map(e => ({
        id:        e.id,
        value:     e.value,
        isDefault: (e.priority ?? 0) === 0,
        sensitive: e.sensitive,
      }));
    if (entries.length < 2) return;

    const label = currentEntry.display_label || currentEntry.canonical_key;

    showAlternativesPanel(el, label, entries, (entryId, value) => {
      sendToBackground('SET_DEFAULT_ENTRY', { entryId }).catch(() => {});
      const alt = all.find(e => e.id === entryId);
      if (!alt) return;

      // Stamp markers BEFORE filling so the post-fill input/change events
      // don't trigger an Update-or-Add pill for the value we just selected.
      el.dataset.dittoPreFocusValue   = value;
      el.dataset.dittoLastLearnedValue = value;

      fillElement(el, resolvePhoneValue(value, alt.canonical_key), alt.canonical_key);

      // Keep matchMap in sync (no gate — fill always runs regardless).
      const state = matchMap.get(el);
      if (state) matchMap.set(el, { ...state, entry: alt });
    });
  } catch {
    // Background unavailable — skip
  }
}

function applyLearnedEntry(el: HTMLElement, sig: FieldSignature, newEntry: ProfileEntry): void {
  // STEP 7.2 — The background's LEARN_FIELD now may return an UPDATED
  // existing entry (same id, new value) instead of a fresh one. Mirror that
  // in our local profile array: replace if id matches, else push.
  const existingIdx = profile.findIndex(p => p.id === newEntry.id);
  if (existingIdx >= 0) {
    profile[existingIdx] = newEntry;
  } else {
    profile.push(newEntry);
  }
  // Keep local storage cache warm so next SW-sleep scenario has fresh data.
  chrome.storage.local.set({ [PROFILE_CACHE_KEY]: profile }).catch(() => {});

  // Also propagate the new value to every matchMap entry that points at
  // this profile entry (a single canonical key can match multiple form
  // fields — e.g. First Name and Preferred First Name both = first_name).
  for (const [otherEl, state] of matchMap) {
    if (state.entry?.id === newEntry.id) {
      matchMap.set(otherEl, { ...state, entry: newEntry });
    }
  }

  const result: MatchResult = {
    status:          'MATCHED',
    profileEntryId:  newEntry.id,
    confidence:      1.0,
    reason:          'learned by user',
    matchStep:       0,
  };

  matchMap.set(el, { sig, result, entry: newEntry });

  // Transition field from UNKNOWN → MATCHED visually + clear the learn-dedup
  // marker so future edits flow through the update path cleanly.
  delete el.dataset.dittoLearnListeners;     // allow pill listeners to attach
  delete el.dataset.dittoLastLearnedValue;   // reset dedup for update path
  applyHint(el, result, newEntry, sig);
}

function injectStyles(): void {
  // No field-level outlines — the overlay pill and ghost text provide enough
  // visual feedback without drawing attention to every matched input box.
}

// ── Message listener (popup → content script) ─────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FILL_ALL') {
    // Refuse to fill on sensitive domains when the setting is enabled
    if (blockSensitiveDomains && isSensitiveDomain(window.location.hostname)) {
      sendResponse({ success: false, error: 'restricted_page' });
      return false;
    }
    if (!isTopFrame) {
      // Sub-frame: fill self, report back, recompute counts so the next
      // frame-report carries the new unfilled state up to the top frame.
      fillAll().then((local) => {
        sendResponse({ success: true, data: local });
        refreshBanner();
        setTimeout(() => { scanFields().catch(() => {}); }, 600);
      }).catch(() => sendResponse({ success: true, data: { filled: 0, skipped: 0 } }));
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
      // STEP 1.1 / 1.4 — recompute and aggregate once before responding
      refreshBanner();
      renderAggregatedBanner();
      sendResponse({ success: true, data: { filled: aggregateFilled, skipped: aggregateSkipped } });
    };

    // Cooldown so the success banner can't be overwritten while popup fill is in flight
    bannerCooldownUntil = Date.now() + 5500;

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
      // STEP 1.3 — comboboxes can take ~560ms each; wait long enough
      else setTimeout(() => { if (!finalized) finalize(); }, 3500);
    }).catch(() => finalize());

    return true; // keep channel open for async response
  }

  if (message.type === 'GET_FIELD_STATS') {
    let total = 0;
    let matched = 0;
    for (const [, state] of matchMap) {
      if (state.result.status === 'SKIP') continue;
      total++;
      if (state.result.status === 'MATCHED') matched++;
    }
    sendResponse({ success: true, data: { total, matched } });
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
    fillElement(
      el,
      resolvePhoneValue(state.entry.value, state.entry.canonical_key),
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

// Debounced re-scan on DOM mutations (SPA route changes render new forms).
//
// Two-timer pattern: a 300ms quiet-time debounce (reset on every mutation) +
// a 2 s ceiling timer (set once per burst, never reset). Whichever fires first
// wins and cancels the other. This guarantees a scan always completes even
// during React/Next.js hydration bursts that produce >300 ms of continuous
// mutations and would otherwise starve the plain debounce indefinitely.
function scheduleScan(): void {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    clearTimeout(maxScanTimer);
    maxScanTimer = undefined;
    scanFields().catch(() => {});
  }, 300);

  if (maxScanTimer === undefined) {
    maxScanTimer = setTimeout(() => {
      clearTimeout(scanTimer);
      maxScanTimer = undefined;
      scanFields().catch(() => {});
    }, 2000);
  }
}

const observer = new MutationObserver(() => {
  // Immediately remove ghost text for any field that was just removed from the
  // DOM (e.g. a login modal closed). No layout reads, so this is cheap.
  sweepDisconnectedGhosts();
  scheduleScan();
});

function startObserver(): void {
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.body) {
  startObserver();
} else {
  document.addEventListener('DOMContentLoaded', startObserver);
}
