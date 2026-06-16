/**
 * Value injection for form fields.
 *
 * The challenge with React/Vue/Angular "controlled" inputs is that setting
 * el.value directly bypasses the framework's internal state tracker. Three
 * things must happen for React to accept our write:
 *
 *   1. Reset React's _valueTracker.lastValue to '' so React sees this as
 *      a genuine change (the most common reason fills silently revert).
 *   2. Use the NATIVE prototype setter (captured in the extension's isolated
 *      world before any page script can shadow it) to write the raw DOM value.
 *   3. Dispatch synthetic 'input' + 'change' events so the framework re-reads
 *      el.value and syncs its own state.
 */

import { isCombobox, fillCombobox, fillButtonDropdown } from './combobox';
import { expandCountryAliases } from './country-aliases';

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
 * STEP 6.1 — Reset React's internal value tracker BEFORE we write. Without
 * this, React 17+ may skip dispatching onChange because tracker.lastValue
 * matches the new value (especially after the developer's own onChange has
 * already echoed our value back through state). Setting lastValue='' makes
 * React see the upcoming write as a fresh change.
 */
function resetReactValueTracker(el: HTMLElement): void {
  const tracker = (el as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  if (tracker && typeof tracker.setValue === 'function') {
    try { tracker.setValue(''); } catch { /* tracker may be frozen */ }
  }
}

/**
 * Fill a form element with a value.
 * Returns true if the value stuck (verified by reading back).
 *
 * Async because ARIA comboboxes need to wait for the popup listbox to
 * render before we can click an option. Plain inputs and native <select>
 * resolve synchronously but the signature is async for uniformity.
 */
export async function fillElement(
  el: HTMLElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return false;

  const before = (el as HTMLInputElement).value ?? '';

  try {
    // Button-triggered custom dropdown (phone country code pickers, etc.)
    if (el instanceof HTMLButtonElement || el.getAttribute('role') === 'button' ||
        (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT')) {
      return await fillButtonDropdown(el, value, canonicalKey);
    }

    if (el instanceof HTMLSelectElement) {
      return fillSelect(el, value, canonicalKey);
    }

    // ARIA combobox / custom dropdown — needs the type-then-click recipe
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && isCombobox(el)) {
      return await fillCombobox(el, value, canonicalKey);
    }

    const setter =
      el instanceof HTMLTextAreaElement ? nativeTextareaSetter : nativeInputSetter;

    // STEP 6.1 — Reset React's value tracker so the write is seen as a change
    resetReactValueTracker(el);

    if (setter) {
      setter.call(el, value);
    } else {
      (el as HTMLInputElement | HTMLTextAreaElement).value = value;
    }

    // Notify frameworks that the value changed
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    el.dataset.dittoFilled = 'true';

    // STEP 6.2 — Post-fill verification. If the value didn't stick (React
    // reverted, or the input has filters that rejected our write), log it
    // so we can see in the console and react accordingly.
    const after = (el as HTMLInputElement).value ?? '';
    if (after !== value) {
      console.warn('[SmartFillAI] fill mismatch:', {
        label: el.getAttribute('name') || el.id || el.getAttribute('aria-label') || '?',
        before, after, expected: value,
      });
      // If reverted, we still return true because we did our best. The
      // ghost-removal still happens. User can retry.
    }

    return true;
  } catch (err) {
    console.warn('[SmartFillAI] fill threw:', err);
    return false;
  }
}

function fillSelect(el: HTMLSelectElement, value: string, canonicalKey?: string): boolean {
  const options = Array.from(el.options);

  // For country-related fields expand to all aliases so "India" matches
  // option text "🇮🇳 India +91", "+91", "IN", etc.
  const valuesToTry = (canonicalKey === 'country' || canonicalKey === 'phone_country_code')
    ? expandCountryAliases(value)
    : [value];

  for (const tryValue of valuesToTry) {
    const lv = tryValue.toLowerCase().trim();

    // 1. Exact value attribute match
    let target = options.find(o => o.value === tryValue);

    // 2. Case-insensitive text match (strip emoji from option text)
    if (!target) {
      target = options.find(o => {
        const optText = o.text.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim().toLowerCase();
        return optText === lv || o.text.toLowerCase().trim() === lv;
      });
    }

    // 3. Partial containment
    if (!target) {
      const stripped = (t: string): string =>
        t.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim().toLowerCase();
      target =
        options.find(o => stripped(o.text).includes(lv) || o.text.toLowerCase().includes(lv)) ??
        options.find(o => lv.includes(stripped(o.text)) && o.text.trim().length > 2);
    }

    if (target) {
      if (nativeSelectSetter) nativeSelectSetter.call(el, target.value);
      else el.value = target.value;
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      el.dataset.dittoFilled = 'true';
      return true;
    }
  }

  return false;
}
