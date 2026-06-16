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

// ── Listbox lookup ────────────────────────────────────────────────────────────

function findListbox(el: HTMLInputElement | HTMLTextAreaElement): HTMLElement | null {
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
  const text = (option.textContent ?? '').toLowerCase().trim();
  if (!text) return false;
  return aliases.some(a => {
    const al = a.toLowerCase().trim();
    if (!al) return false;
    return text === al || text.includes(al);
  });
}

/** STEP 6.3 — Keyboard fallback: some comboboxes only commit on Enter. */
function dispatchKey(el: HTMLElement, key: string): void {
  const init: KeyboardEventInit = { key, code: key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup',   init));
}

export async function fillCombobox(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  if (el.disabled || el.readOnly) return false;

  const aliases = canonicalKey === 'country'
    ? expandCountryAliases(value)
    : [value];

  // 1. Focus to open the combobox
  el.focus();
  await sleep(40);

  // 2. Type the value so the combobox filters options
  writeValue(el, aliases[0]);

  // 3. Wait for the listbox to render
  let listbox: HTMLElement | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(80);
    listbox = findListbox(el);
    if (listbox && getOptions(listbox).length > 0) break;
  }

  // 4. Find a matching option in the listbox, OR fall back to keyboard nav
  if (listbox) {
    const options = getOptions(listbox);
    let pick: HTMLElement | undefined;
    for (const opt of options) {
      if (optionMatches(opt, aliases)) { pick = opt; break; }
    }
    if (!pick && options.length === 1) pick = options[0];

    if (pick) {
      // Click sequence — most combobox libraries respond to one of these
      pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      pick.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
      pick.click();
      await sleep(80);

      // STEP 6.3 — If the listbox is still open, click didn't commit;
      // try keyboard Enter (works with downshift, ariakit, some custom libs)
      if (findListbox(el) === listbox && listbox.isConnected) {
        dispatchKey(el, 'Enter');
        await sleep(80);
      }
    } else {
      // Couldn't find an option — try ArrowDown + Enter to pick the first
      dispatchKey(el, 'ArrowDown');
      await sleep(40);
      dispatchKey(el, 'Enter');
      await sleep(80);
    }
  }

  // 5. Mark the input AND every ancestor up to the combobox root as filled.
  //    isComboboxFilled walks up the same chain, so any level it checks will
  //    find the marker. This also survives react re-renders that replace the
  //    input element — the ancestor div typically stays in the DOM.
  el.dataset.dittoFilled = 'true';
  let markNode: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 6 && markNode; depth++) {
    markNode.dataset.dittoFilled = 'true';
    const role = markNode.getAttribute('role');
    if (role === 'combobox' || role === 'listbox') break;
    markNode = markNode.parentElement;
  }

  return true;
}
