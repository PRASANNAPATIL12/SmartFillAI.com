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

/** Return the wrapper element that holds the entire combobox widget. */
function getComboboxWrapper(el: HTMLElement): HTMLElement {
  return el.closest('[role="combobox"]') as HTMLElement
      || el.parentElement
      || el;
}

/**
 * STEP 6.6 — Many comboboxes (react-select, Greenhouse) store the selected
 * label in a sibling display node, not in input.value. Look for it so
 * tryLearnField can capture the user's selection even when the input is
 * empty after option click.
 *
 * Common patterns:
 *   - <div class="select__single-value">India +91</div>
 *   - <div class="rs__single-value">India +91</div>
 *   - <span aria-selected="true">India</span>
 */
export function getComboboxDisplayValue(el: HTMLElement): string {
  // First try input.value itself (some comboboxes keep it populated)
  const inputValue = ((el as HTMLInputElement).value ?? '').trim();
  if (inputValue) return inputValue;

  const wrapper = getComboboxWrapper(el);

  // react-select / Greenhouse pattern — class contains "single-value"
  const single = wrapper.querySelector<HTMLElement>('[class*="single-value"], [class*="singleValue"]');
  const singleText = (single?.textContent ?? '').trim();
  if (singleText) return singleText;

  // ARIA selected option as last resort
  const selected = wrapper.querySelector<HTMLElement>('[aria-selected="true"]');
  const selectedText = (selected?.textContent ?? '').trim();
  if (selectedText) return selectedText;

  return '';
}

/** True when the combobox has a chosen value (input OR display has text). */
export function isComboboxFilled(el: HTMLElement): boolean {
  if (el.dataset.dittoFilled === 'true') return true;
  const wrapper = getComboboxWrapper(el);
  if (wrapper.dataset.dittoFilled === 'true') return true;
  return getComboboxDisplayValue(el).length > 0;
}

// ── Listbox lookup ────────────────────────────────────────────────────────────

function findListbox(el: HTMLInputElement | HTMLTextAreaElement): HTMLElement | null {
  const controls = el.getAttribute('aria-controls');
  if (controls) {
    const byId = document.getElementById(controls);
    if (byId) return byId;
  }
  const wrapper = el.closest('[role="combobox"]') ?? el.parentElement;
  if (wrapper) {
    const listbox = wrapper.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) return listbox;
  }
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

  const wrapper = getComboboxWrapper(el);

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

  // 5. Mark both the input and its wrapper as filled so refreshBanner /
  //    ghost guards can see the success regardless of which one they check.
  el.dataset.dittoFilled = 'true';
  if (wrapper && wrapper !== el) wrapper.dataset.dittoFilled = 'true';

  return true;
}
