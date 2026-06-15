/**
 * Combobox / custom dropdown handling.
 *
 * Modern ATS vendors (Greenhouse, Workday, Lever, Ashby, Workday, Lever)
 * implement Country/State/Department/etc. as ARIA comboboxes — an <input>
 * that filters a popup listbox of options. A plain native-setter write
 * leaves the dropdown's internal state untouched: the input shows the
 * value but the listbox never commits a selection, so when the user
 * submits the form the field reads as empty.
 *
 * The proven recipe:
 *   1. Focus the input.
 *   2. Type each character (set value + dispatch input event) so the
 *      combobox's filter logic kicks in.
 *   3. Wait briefly for the listbox to render its filtered options.
 *   4. Click the first option whose visible text matches our value or
 *      one of its aliases.
 *
 * If we can't find a matching option, we leave the input populated
 * (better than nothing) and let the user manually confirm.
 */

import { expandCountryAliases } from './country-aliases';

// ── Detection ────────────────────────────────────────────────────────────────

export function isCombobox(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  // Explicit ARIA combobox role
  if (el.getAttribute('role') === 'combobox') return true;
  // ARIA combobox via autocomplete attr (most common in Greenhouse/Workday)
  const ariaAuto = el.getAttribute('aria-autocomplete');
  if (ariaAuto === 'list' || ariaAuto === 'both') return true;
  // Has aria-controls pointing to a listbox
  const controls = el.getAttribute('aria-controls');
  if (controls) {
    const target = document.getElementById(controls);
    if (target?.getAttribute('role') === 'listbox') return true;
  }
  // Parent wrapper has role=combobox
  const wrapper = el.closest('[role="combobox"]');
  if (wrapper) return true;
  // aria-haspopup=listbox
  const haspopup = el.getAttribute('aria-haspopup');
  if (haspopup === 'listbox' || haspopup === 'true') return true;
  return false;
}

// ── Listbox lookup ────────────────────────────────────────────────────────────

function findListbox(el: HTMLInputElement | HTMLTextAreaElement): HTMLElement | null {
  // 1. aria-controls → element by id
  const controls = el.getAttribute('aria-controls');
  if (controls) {
    const byId = document.getElementById(controls);
    if (byId) return byId;
  }
  // 2. Ancestor [role="combobox"] → look for descendant [role="listbox"]
  const wrapper = el.closest('[role="combobox"]') ?? el.parentElement;
  if (wrapper) {
    const listbox = wrapper.querySelector<HTMLElement>('[role="listbox"]');
    if (listbox) return listbox;
  }
  // 3. Global fallback — find any visible listbox (only one is usually open at a time)
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

function writeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = el instanceof HTMLTextAreaElement ? nativeTextareaSetter : nativeInputSetter;
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Match a value against an option's visible text.
 * Returns true if any alias is a case-insensitive substring of the option.
 */
function optionMatches(option: HTMLElement, aliases: string[]): boolean {
  const text = (option.textContent ?? '').toLowerCase().trim();
  if (!text) return false;
  return aliases.some(a => {
    const al = a.toLowerCase().trim();
    if (!al) return false;
    return text === al || text.includes(al);
  });
}

/**
 * Combobox fill — async because we wait for the listbox to render.
 * Returns true on successful commit, false otherwise.
 */
export async function fillCombobox(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  if (el.disabled || el.readOnly) return false;

  // Pick the set of strings we'll try matching against options
  const aliases = canonicalKey === 'country'
    ? expandCountryAliases(value)
    : [value];

  // 1. Focus to open the combobox
  el.focus();
  await sleep(30);

  // 2. Type the value so the combobox filters its options
  writeValue(el, aliases[0]);

  // 3. Wait for the listbox to render
  let listbox: HTMLElement | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(80);
    listbox = findListbox(el);
    if (listbox && getOptions(listbox).length > 0) break;
  }

  if (!listbox) {
    // No listbox appeared — input value is set; let the form take it as-is
    el.dataset.dittoFilled = 'true';
    return true;
  }

  // 4. Find a matching option
  const options = getOptions(listbox);
  let pick: HTMLElement | undefined;
  for (const opt of options) {
    if (optionMatches(opt, aliases)) { pick = opt; break; }
  }
  // If no alias matched, fall back to the FIRST visible option (the
  // combobox has already filtered the list by what we typed).
  if (!pick && options.length === 1) pick = options[0];

  if (!pick) {
    el.dataset.dittoFilled = 'true';
    return true; // leave typed value; user can pick manually
  }

  // 5. Click it (mousedown + click is more reliable than click alone for some libs)
  pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  pick.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
  pick.click();

  // 6. Let any onChange handlers settle
  await sleep(50);

  el.dataset.dittoFilled = 'true';
  return true;
}
