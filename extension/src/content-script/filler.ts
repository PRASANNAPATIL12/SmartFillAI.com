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
 * STEP 6.1 — Reset React's internal value tracker BEFORE we write. Without
 * this, React 17+ may skip dispatching onChange because tracker.lastValue
 * matches the new value (especially after the developer's own onChange has
 * already echoed our value back through state). Setting lastValue='' makes
 * React see the upcoming write as a fresh change.
 */
function resetReactValueTracker(el: HTMLInputElement | HTMLTextAreaElement): void {
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
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  if (el.disabled || (el as HTMLInputElement).readOnly) return false;

  const before = (el as HTMLInputElement).value ?? '';

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
