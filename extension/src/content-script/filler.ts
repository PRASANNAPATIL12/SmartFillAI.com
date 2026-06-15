/**
 * Value injection for form fields.
 *
 * The challenge with React/Vue/Angular "controlled" inputs is that setting
 * el.value directly bypasses the framework's internal state tracker. The fix:
 *   1. Use the NATIVE prototype setter (captured in the extension's isolated
 *      world before any page script can shadow it) to write the raw DOM value.
 *   2. Dispatch synthetic 'input' + 'change' events so the framework re-reads
 *      el.value and syncs its own state.
 */

import { isCombobox, fillCombobox } from './combobox';

// Capture native setters from the extension's isolated world.
// Page scripts cannot touch these because isolated worlds have separate prototypes.
const nativeInputSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value'
)?.set;

const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value'
)?.set;

const nativeSelectSetter = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  'value'
)?.set;

/**
 * Fill a form element with a value.
 * Returns true if the value was set, false if the field was skipped.
 *
 * Async because ARIA comboboxes need to wait for the popup listbox to
 * render before we can click an option. Plain inputs and native <select>
 * resolve synchronously.
 */
export async function fillElement(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  if (el.disabled || (el as HTMLInputElement).readOnly) return false;

  try {
    if (el instanceof HTMLSelectElement) {
      return fillSelect(el, value);
    }

    // ARIA combobox / custom dropdown — needs the type-then-click recipe
    if (isCombobox(el)) {
      return await fillCombobox(el as HTMLInputElement | HTMLTextAreaElement, value, canonicalKey);
    }

    const setter =
      el instanceof HTMLTextAreaElement ? nativeTextareaSetter : nativeInputSetter;

    if (setter) {
      setter.call(el, value);
    } else {
      (el as HTMLInputElement | HTMLTextAreaElement).value = value;
    }

    // Notify frameworks that the value changed
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    el.dataset.dittoFilled = 'true';
    return true;
  } catch {
    return false;
  }
}

function fillSelect(el: HTMLSelectElement, value: string): boolean {
  const options = Array.from(el.options);

  // 1. Exact value attribute match
  let target = options.find(o => o.value === value);

  // 2. Case-insensitive text match
  if (!target) {
    const lv = value.toLowerCase().trim();
    target = options.find(o => o.text.toLowerCase().trim() === lv);
  }

  // 3. Partial containment (e.g., "Male" matches option text "Male / Man")
  if (!target) {
    const lv = value.toLowerCase().trim();
    target =
      options.find(o => o.text.toLowerCase().includes(lv)) ??
      options.find(o => lv.includes(o.text.toLowerCase().trim()) && o.text.trim().length > 2);
  }

  if (!target) return false;

  if (nativeSelectSetter) {
    nativeSelectSetter.call(el, target.value);
  } else {
    el.value = target.value;
  }

  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  el.dataset.dittoFilled = 'true';
  return true;
}
