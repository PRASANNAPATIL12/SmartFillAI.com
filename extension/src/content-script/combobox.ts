/**
 * Combobox / custom dropdown handling.
 *
 * Modern ATS vendors (Greenhouse react-select, Workday, Lever, Ashby) implement
 * Country/State/Department/Degree as ARIA comboboxes. After option click, the
 * <input>'s `.value` is often EMPTY — the selection lives in the framework's
 * state and is shown via a sibling display element. Three implications:
 *
 *  - `fillCombobox` cannot just type text and dispatch events; it must trigger
 *    the framework's selection handler (mouse + keyboard fallback).
 *  - "Has this combobox been filled?" can't be answered by `input.value`. We
 *    mark the WRAPPER element with data-ditto-filled and also expose
 *    `getComboboxDisplayValue(el)` so `tryLearnField` can read the chosen
 *    label even when `input.value` is empty.
 */

import { expandCountryAliases } from './country-aliases';
import { expandValueAliases, hasValueAliases } from './value-aliases';
import { selectOptionByEmbedding } from './option-embedding';
import { getResolvedOption, setResolvedOption } from './option-resolution-cache';

// Debug logger — mirrors index.ts's SFA_DEBUG gate so combobox failures
// stay silent for users unless they opt in via window.__SFA_DEBUG = true.
const sfaLog = (...args: unknown[]): void => {
  if ((window as unknown as { __SFA_DEBUG?: boolean }).__SFA_DEBUG === true) {
    console.log('[SmartFillAI]', ...args);
  }
};

/**
 * Mark a combobox/button-dropdown control as having failed to find a
 * matching option. Visible via `[data-ditto-status="FILL_FAILED"]` so the
 * popup / overlay can surface a "needs manual selection" indicator and
 * regression tests can assert on it.
 */
function markFillFailed(el: HTMLElement, value: string, optionTexts: string[]): void {
  el.dataset.dittoStatus = 'FILL_FAILED';
  sfaLog('dropdown fill failed', { value, optionsSample: optionTexts.slice(0, 12), optionCount: optionTexts.length });
}

// ── Detection ────────────────────────────────────────────────────────────────

export function isCombobox(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  if (el.getAttribute('role') === 'combobox') return true;
  const ariaAuto = el.getAttribute('aria-autocomplete');
  if (ariaAuto === 'list' || ariaAuto === 'both') return true;
  const controls = el.getAttribute('aria-controls');
  if (controls) {
    const target = document.getElementById(controls);
    if (target?.getAttribute('role') === 'listbox') return true;
  }
  if (el.closest('[role="combobox"]')) return true;
  const haspopup = el.getAttribute('aria-haspopup');
  if (haspopup === 'listbox' || haspopup === 'true') return true;
  return false;
}


/**
 * Read the currently-selected display label from any combobox widget.
 *
 * THE CORE CHALLENGE — react-select / Greenhouse DOM layout:
 *
 *   div.control  (no role="combobox" in many versions)
 *     div.value-container
 *       div.single-value        ← "Associate's Degree"   ← what we want
 *       div.input-container
 *         input[aria-autocomplete="list"]  ← el  (we start here)
 *
 * The old code used `el.parentElement` as the "wrapper" and ran querySelector
 * inside it. That only searches INSIDE input-container — single-value is a
 * SIBLING of input-container, not a descendant. querySelector found nothing,
 * returned '', and tryLearnField bailed out with `if (!value) return`.
 *
 * FIX: walk UP the ancestor chain (max 6 levels). At depth 1 we reach
 * input-container (nothing), at depth 2 we reach value-container and
 * querySelector finds single-value immediately. Works for deeply-nested
 * custom wrappers too.
 *
 * Class selectors cover both naming conventions:
 *   hyphen-case  : "single-value"  → react-select classNamePrefix pattern
 *   camelCase    : "singleValue"   → emotion CSS-in-JS (e.g. css-abc-singleValue)
 */
export function getComboboxDisplayValue(el: HTMLElement): string {
  // 1. Some frameworks keep the committed value in input.value.
  const inputValue = ((el as HTMLInputElement).value ?? '').trim();
  if (inputValue) return inputValue;

  // 2. Walk UP through ancestors, searching at each level for a display element.
  let ancestor: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 6 && ancestor; depth++) {

    // ── Class-based patterns ───────────────────────────────────────────────
    // Covers react-select 2/3/4/5, Greenhouse, Lever, Ashby, Workday
    const byClass = ancestor.querySelector<HTMLElement>(
      '[class*="single-value"], [class*="singleValue"], ' +
      '[class*="selected-value"], [class*="selectedValue"], ' +
      '[class*="value-text"], [class*="chosen-value"]'
    );
    if (byClass) {
      const text = (byClass.textContent ?? '').trim();
      if (
        text &&
        !byClass.contains(el) &&                      // not an ancestor of el
        !byClass.closest('[role="listbox"]')           // not inside an open dropdown
      ) {
        return text;
      }
    }

    // ── ARIA committed selection ───────────────────────────────────────────
    // Some widgets mark the selected display element aria-selected="true"
    // OUTSIDE of any listbox (i.e. it's the committed chip/tag, not a list item).
    const byAria = ancestor.querySelector<HTMLElement>('[aria-selected="true"]');
    if (byAria) {
      const text = (byAria.textContent ?? '').trim();
      if (
        text &&
        !byAria.contains(el) &&
        !byAria.closest('[role="listbox"]')            // skip highlighted option in open list
      ) {
        return text;
      }
    }

    // ── Stop at hard widget boundaries ────────────────────────────────────
    const role = ancestor.getAttribute('role');
    if (role === 'listbox' || role === 'dialog') break;

    ancestor = ancestor.parentElement;
  }

  return '';
}

/**
 * True when the combobox has a committed value.
 * Checks three things in order:
 *  1. The dittoFilled marker on the input itself (set by fillCombobox)
 *  2. The dittoFilled marker on any ancestor up to 5 levels (same walk-up as wrapper)
 *  3. Whether getComboboxDisplayValue finds a non-empty label
 */
export function isComboboxFilled(el: HTMLElement): boolean {
  if (el.dataset.dittoFilled === 'true') return true;

  // Walk up looking for the dittoFilled marker we set on the wrapper in fillCombobox.
  let ancestor: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 6 && ancestor; depth++) {
    if (ancestor.dataset.dittoFilled === 'true') return true;
    const role = ancestor.getAttribute('role');
    if (role === 'listbox' || role === 'dialog') break;
    ancestor = ancestor.parentElement;
  }

  return getComboboxDisplayValue(el).length > 0;
}

// ── Control + listbox lookup ──────────────────────────────────────────────────

/**
 * Find the react-select Control div by walking UP from the input.
 *
 * react-select DOM layout:
 *   SelectContainer
 *     Control  ← depth 2 from the input; its onMouseDown opens/closes the menu
 *       ValueContainer
 *         SingleValue / Placeholder
 *         InputContainer
 *           input  ← el (our starting point)
 *       IndicatorsContainer
 *
 * Dispatching mousedown on Control triggers react-select's onControlMouseDown
 * → onMenuOpen(). This is more reliable than el.focus() alone because most
 * react-select configs have menuOpenOnFocus: false.
 *
 * Falls back to depth-2 ancestor if no class name contains "control" (e.g.
 * when emotion CSS-in-JS generates opaque class names). Depth 2 is almost
 * always the Control div. Even if the fallback is wrong, the mousedown will
 * still bubble up to react-select's delegated root listener and open the menu.
 */
function findControlAncestor(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 6 && node; depth++) {
    if (/control/i.test(node.getAttribute('class') ?? '')) return node;
    node = node.parentElement;
  }
  // depth-2 fallback: input-container → value-container → control
  return el.parentElement?.parentElement ?? el.parentElement ?? el;
}

// ── Listbox lookup ────────────────────────────────────────────────────────────

export function findListbox(el: HTMLInputElement | HTMLTextAreaElement): HTMLElement | null {
  // 1. aria-controls is the most explicit and reliable link
  const controls = el.getAttribute('aria-controls');
  if (controls) {
    const byId = document.getElementById(controls);
    if (byId) return byId;
  }

  // 2. Walk UP through ancestors looking for a listbox descendant.
  //    Same reasoning as getComboboxDisplayValue: the listbox may be appended
  //    as a sibling of the input-container, not a descendant, so searching
  //    only el.parentElement is too shallow.
  let ancestor: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 5 && ancestor; depth++) {
    const listbox = ancestor.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) return listbox;
    const role = ancestor.getAttribute('role');
    if (role === 'dialog' || role === 'application') break;
    ancestor = ancestor.parentElement;
  }

  // 3. Last resort: any currently-visible listbox in the document
  const allListboxes = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]'));
  const visible = allListboxes.find(lb => {
    const s = window.getComputedStyle(lb);
    return s.display !== 'none' && s.visibility !== 'hidden' && lb.offsetParent !== null;
  });
  return visible ?? null;
}

function getOptions(listbox: HTMLElement): HTMLElement[] {
  return Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"], li, [data-option]'))
    .filter(o => o.offsetParent !== null);
}

// ── Fill ──────────────────────────────────────────────────────────────────────

const nativeInputSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype, 'value'
)?.set;
const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype, 'value'
)?.set;

function resetReactValueTracker(el: HTMLInputElement | HTMLTextAreaElement): void {
  const tracker = (el as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  if (tracker && typeof tracker.setValue === 'function') {
    try { tracker.setValue(''); } catch { /* frozen */ }
  }
}

function writeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  resetReactValueTracker(el);
  const setter = el instanceof HTMLTextAreaElement ? nativeTextareaSetter : nativeInputSetter;
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function optionMatches(option: HTMLElement, aliases: string[]): boolean {
  const rawText = (option.textContent ?? '').trim();
  // Strip leading emoji flag sequences so "🇮🇳 India +91" compares cleanly.
  // Keep the original for substring fallback so "+91" still matches "🇮🇳 India +91".
  const stripped = rawText.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim().toLowerCase();
  const full     = rawText.toLowerCase();
  if (!stripped && !full) return false;
  return aliases.some(a => {
    const al = a.toLowerCase().trim();
    if (!al) return false;
    // Short aliases (ISO2 codes, single-digit calling codes) use exact match only.
    // Substring matching would cause false positives: "IN" (India) matches "Finland"
    // because "finland".includes("in") is true, and Finland sorts before India.
    if (al.length <= 2) return stripped === al || full === al;
    return stripped === al || stripped.includes(al) || full.includes(al);
  });
}

/** STEP 6.3 — Keyboard fallback: some comboboxes only commit on Enter. */
function dispatchKey(el: HTMLElement, key: string): void {
  const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup',   init));
}

/**
 * Mark the input and every ancestor up to the combobox root as filled.
 * isComboboxFilled walks the same chain, so it will find the marker
 * regardless of which level React re-renders to.
 */
function markFilled(el: HTMLElement): void {
  el.dataset.dittoFilled = 'true';
  let node: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 6 && node; depth++) {
    node.dataset.dittoFilled = 'true';
    const role = node.getAttribute('role');
    if (role === 'combobox' || role === 'listbox') break;
    node = node.parentElement;
  }
}

/**
 * Dispatch a click sequence on a listbox option and verify the selection
 * was committed by checking the display value afterwards.
 *
 * Why mousedown is the key event: react-select's Option component handles
 * onMouseDown (not onClick) to call selectOption(data) and close the menu.
 * The sequence fires BEFORE the input loses focus from blur, so the
 * selection commits before react-select's onBlur can clear the input.
 *
 * Returns true only if getComboboxDisplayValue confirms a non-empty committed value.
 */
async function clickOption(
  el: HTMLInputElement | HTMLTextAreaElement,
  pick: HTMLElement,
  listbox: HTMLElement
): Promise<boolean> {
  pick.scrollIntoView?.({ block: 'nearest' });

  // react-select v5 commits on a LEFT-button pointer/mouse DOWN and checks
  // event.button === 0. A bare MouseEvent('mousedown') has button 0 but no
  // pointer events; some builds gate on pointerdown. Fire the full sequence
  // with explicit button/buttons so whichever handler the build uses fires.
  const downOpts = { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window } as MouseEventInit;
  const upOpts   = { bubbles: true, cancelable: true, button: 0, buttons: 0, view: window } as MouseEventInit;
  try { pick.dispatchEvent(new PointerEvent('pointerdown', downOpts)); } catch { /* no PointerEvent */ }
  pick.dispatchEvent(new MouseEvent('mousedown', downOpts));
  try { pick.dispatchEvent(new PointerEvent('pointerup', upOpts)); } catch { /* no PointerEvent */ }
  pick.dispatchEvent(new MouseEvent('mouseup', upOpts));
  pick.dispatchEvent(new MouseEvent('click', upOpts));
  await sleep(120);

  // If the listbox is still attached + open, the pointer path didn't commit.
  // Enter commits the highlighted option (downshift, ariakit, react-select).
  if (listbox.isConnected && findListbox(el) !== null) {
    dispatchKey(el, 'Enter');
    await sleep(80);
  }

  const committed = getComboboxDisplayValue(el).length > 0;
  return committed;
}

/**
 * Open a dropdown just long enough to read its option texts, then close it.
 * Used by the LLM answer tier so Gemini can be shown the real choices and
 * return one verbatim. Best-effort: returns [] if options can't be read
 * (the fill path's embedding match is the fallback).
 */
export async function peekOptions(el: HTMLElement): Promise<string[]> {
  // Native <select> — options are always in the DOM.
  if (el instanceof HTMLSelectElement) {
    return Array.from(el.options).map(o => (o.text ?? '').trim()).filter(Boolean);
  }

  // ARIA combobox input.
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    await sleep(40);
    if (!findListbox(el)) {
      const control = findControlAncestor(el);
      control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      control.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    }
    let lb: HTMLElement | null = null;
    for (let i = 0; i < 8; i++) {
      await sleep(70);
      lb = findListbox(el);
      if (lb && getOptions(lb).length > 0) break;
    }
    const opts = lb ? getOptions(lb).map(o => (o.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
    dispatchKey(el, 'Escape'); // close so the subsequent fill starts clean
    return opts.slice(0, 60);
  }

  // Button / div dropdown — click to open, read a visible listbox/ul, then close.
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
  el.click();
  let panel: HTMLElement | null = null;
  for (let i = 0; i < 8; i++) {
    await sleep(70);
    panel = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"], ul.country-list, .iti__country-list'))
      .find(p => {
        const s = window.getComputedStyle(p);
        return s.display !== 'none' && s.visibility !== 'hidden' && p.offsetParent !== null;
      }) ?? null;
    if (panel) break;
  }
  const opts = panel
    ? Array.from(panel.querySelectorAll<HTMLElement>('[role="option"], li, [data-option]'))
        .filter(o => o.offsetParent !== null)
        .map(o => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    : [];
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // close panel
  return opts.slice(0, 60);
}

export async function fillCombobox(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  if (el.disabled) return false;
  // readOnly on a combobox input means the user can't TYPE (isSearchable: false in
  // react-select), but the dropdown can still be opened and options clicked.
  // We do NOT bail here — we skip the writeValue step below if readOnly.

  const aliases =
    canonicalKey === 'country' || canonicalKey === 'phone_country_code'
      ? expandCountryAliases(value)
      : hasValueAliases(canonicalKey)
        ? expandValueAliases(canonicalKey, value)
        : [value];

  // ── 1. Focus the input ────────────────────────────────────────────────────
  el.focus();
  await sleep(60);

  // ── 2. Open the dropdown via mousedown on the Control ancestor ────────────
  // Most react-select configs have menuOpenOnFocus: false — el.focus() moves
  // keyboard focus but does NOT open the menu. Dispatching mousedown on the
  // Control div triggers onControlMouseDown → onMenuOpen().
  // Only fire if focus didn't already open the menu.
  if (!findListbox(el)) {
    const control = findControlAncestor(el);
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    control.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
    await sleep(60);
  }

  // ── 3. Wait for the listbox to appear with visible options ────────────────
  let listbox: HTMLElement | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(80);
    listbox = findListbox(el);
    if (listbox && getOptions(listbox).length > 0) break;
  }

  // ── 4. Primary path: find option in the UNFILTERED open list ─────────────
  // Greenhouse, Lever, Ashby and most ATSes show ALL options when the menu
  // first opens. Finding the match here means we never call writeValue at all:
  // no React re-render → DOM references stay fresh → no stale-element problem.
  if (listbox) {
    const opts = getOptions(listbox);
    const optTexts = opts.map(o => (o.textContent ?? '').replace(/\s+/g, ' ').trim());

    // Cache 3 — prior resolution for this option set + value.
    let pick: HTMLElement | undefined;
    const cachedText = await getResolvedOption(optTexts, value);
    if (cachedText) pick = opts.find((_o, i) => optTexts[i] === cachedText);

    if (!pick) pick = opts.find(o => optionMatches(o, aliases));
    if (pick) {
      const pickText = (pick.textContent ?? '').replace(/\s+/g, ' ').trim();
      const ok = await clickOption(el, pick, listbox);
      if (ok) { markFilled(el); void setResolvedOption(optTexts, value, pickText); return true; }
    }
  }

  // ── 5. Secondary path: type to filter, then retry with FRESH references ───
  // Only reached when the open list has no matching option (very long lists
  // that only render the top-N until the user types to narrow them).
  //
  // Skip for readOnly inputs (isSearchable: false in react-select) — typing
  // has no effect when the input is readonly, so the list won't filter.
  //
  // CRITICAL: after writeValue fires React's input event, the framework
  // re-renders the option list (new JSX → new DOM nodes). We MUST re-call
  // findListbox + getOptions to get fresh element references. Dispatching
  // mousedown on stale/detached nodes from before the re-render is a no-op.
  if (!el.readOnly) {
    writeValue(el, aliases[0]);
    await sleep(220); // wait for React re-render to complete
  }

  const freshListbox = findListbox(el);
  if (freshListbox) {
    const freshOptions = getOptions(freshListbox);
    let pick = freshOptions.find(o => optionMatches(o, aliases));
    if (!pick && freshOptions.length === 1) pick = freshOptions[0];
    if (pick) {
      const freshTexts = freshOptions.map(o => (o.textContent ?? '').replace(/\s+/g, ' ').trim());
      const pickText = (pick.textContent ?? '').replace(/\s+/g, ' ').trim();
      const ok = await clickOption(el, pick, freshListbox);
      if (ok) { markFilled(el); void setResolvedOption(freshTexts, value, pickText); return true; }
    }
  }

  // ── 6. Embedding fallback (Phase A.4) ─────────────────────────────────────
  // The deterministic alias paths (primary unfiltered + secondary filtered)
  // have both failed. Before resorting to "ArrowDown + Enter" (which blindly
  // picks the first option), ask the local MiniLM embedder which currently-
  // visible option is closest in meaning to the user value.
  //
  // We re-fetch the listbox + options here because step 5's typing may have
  // re-rendered the DOM. Embedding is skipped automatically inside the
  // helper for option sets > 50 (country pickers and similar).
  const embedListbox = findListbox(el);
  if (embedListbox) {
    const embedOpts = getOptions(embedListbox);
    if (embedOpts.length > 0) {
      const embedTexts = embedOpts.map(o => (o.textContent ?? '').replace(/\s+/g, ' ').trim());
      const match = await selectOptionByEmbedding(el, value, embedTexts);
      if (match && match.index >= 0 && match.index < embedOpts.length) {
        sfaLog('combobox fill via embedding', { value, picked: embedTexts[match.index], similarity: match.similarity.toFixed(3) });
        const ok = await clickOption(el, embedOpts[match.index], embedListbox);
        if (ok) { markFilled(el); void setResolvedOption(embedTexts, value, embedTexts[match.index]); return true; }
      }
    }
  }

  // ── 7. No genuine match — do NOT blind-select ────────────────────────────
  // Previously we did ArrowDown+Enter here, which blindly committed the FIRST
  // option (e.g. "United States" or "Yes") regardless of correctness. That
  // produced wrong fills — a yes/no question matched to `country` would get
  // a country name. Selecting the wrong option is worse than not filling.
  //
  // Instead: clear any filter text we typed in step 5 (so we never leave
  // "United States" sitting in a field whose real options are [Yes, No]),
  // close the menu, and report FILL_FAILED for visible feedback.
  const finalListbox = findListbox(el);
  const finalOptions = finalListbox ? getOptions(finalListbox).map(o => (o.textContent ?? '').trim()) : [];

  if (!el.readOnly && (el.value ?? '').length > 0) {
    writeValue(el, '');          // clear the typed filter text
    await sleep(40);
  }
  dispatchKey(el, 'Escape');     // close the menu without committing anything
  await sleep(40);

  markFillFailed(el, value, finalOptions);
  return false;
}

/**
 * Fill a button-triggered country/calling-code picker.
 *
 * Used for phone country code widgets that are implemented as a `<button>` or
 * custom `<div>` rather than an `<input>`.  Common in intl-tel-input,
 * react-phone-input-2, and bespoke ATS phone-number components.
 *
 * Algorithm:
 *  1. Click the trigger button to open the dropdown panel.
 *  2. Poll until a visible listbox or option list appears (up to 640ms).
 *  3. Find the matching option using the same alias + emoji-strip logic as
 *     fillCombobox.
 *  4. Click the option (mousedown + click) and verify the button text changed.
 */
export async function fillButtonDropdown(
  el: HTMLElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  const aliases =
    canonicalKey === 'country' || canonicalKey === 'phone_country_code'
      ? expandCountryAliases(value)
      : hasValueAliases(canonicalKey)
        ? expandValueAliases(canonicalKey, value)
        : [value];

  // ── 1. Click the trigger to open the panel ───────────────────────────────
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
  el.click();
  await sleep(120);

  // ── 2. Poll for a visible dropdown/listbox ──────────────────────────────
  // Some widgets append the panel to document.body (portal pattern), so we
  // can't limit the search to el's subtree.
  let panel: HTMLElement | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(80);

    // Prefer [role="listbox"] (ARIA-compliant widgets)
    const allListboxes = Array.from(
      document.querySelectorAll<HTMLElement>('[role="listbox"]')
    );
    const visibleListbox = allListboxes.find(lb => {
      const s = window.getComputedStyle(lb);
      return s.display !== 'none' && s.visibility !== 'hidden' && lb.offsetParent !== null;
    });
    if (visibleListbox) {
      const opts = Array.from(visibleListbox.querySelectorAll<HTMLElement>(
        '[role="option"], li, [data-option]'
      )).filter(o => o.offsetParent !== null);
      if (opts.length > 0) { panel = visibleListbox; break; }
    }

    // Fallback: intl-tel-input uses a <ul class="country-list">
    const ulPanels = Array.from(
      document.querySelectorAll<HTMLElement>('ul.country-list, .iti__country-list, .flag-dropdown ul')
    );
    const visibleUl = ulPanels.find(ul => {
      const s = window.getComputedStyle(ul);
      return s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (visibleUl) { panel = visibleUl; break; }
  }

  if (!panel) {
    markFillFailed(el, value, []);
    return false;
  }

  // ── 3. Find matching option ─────────────────────────────────────────────
  const options = Array.from(
    panel.querySelectorAll<HTMLElement>('[role="option"], li, [data-option]')
  ).filter(o => o.offsetParent !== null);

  const optionTexts = options.map(o => (o.textContent ?? '').replace(/\s+/g, ' ').trim());

  // Cache 3 — option-resolution lookup. If we (or another site with the same
  // option set) resolved this value before, pick that option directly.
  let pick: HTMLElement | undefined;
  const cachedText = await getResolvedOption(optionTexts, value);
  if (cachedText) {
    pick = options.find((_o, i) => optionTexts[i] === cachedText);
  }

  if (!pick) {
    pick = options.find(o => optionMatches(o, aliases));
  }

  // Phase A.4 — embedding fallback when alias matching returns nothing.
  // Skipped automatically inside selectOptionByEmbedding for very large
  // option sets (country pickers are alias-covered already).
  if (!pick) {
    const match = await selectOptionByEmbedding(el, value, optionTexts);
    if (match && match.index >= 0 && match.index < options.length) {
      pick = options[match.index];
      sfaLog('button-dropdown fill via embedding', { value, picked: optionTexts[match.index], similarity: match.similarity.toFixed(3) });
    }
  }

  if (!pick) {
    markFillFailed(el, value, optionTexts);
    return false;
  }
  const pickText = (pick.textContent ?? '').replace(/\s+/g, ' ').trim();

  // ── 4. Click the option and verify ─────────────────────────────────────
  const beforeText = el.textContent?.trim() ?? '';
  pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  pick.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
  pick.click();
  await sleep(150);

  // Verify: button text should have changed (or panel should have closed)
  const afterText = el.textContent?.trim() ?? '';
  const panelClosed = !document.body.contains(panel) || window.getComputedStyle(panel).display === 'none';
  const textChanged = afterText !== beforeText && afterText.length > 0;

  if (panelClosed || textChanged) {
    el.dataset.dittoFilled = 'true';
    delete el.dataset.dittoStatus; // clear any prior FILL_FAILED
    void setResolvedOption(optionTexts, value, pickText);
    return true;
  }

  markFillFailed(el, value, optionTexts);
  return false;
}
