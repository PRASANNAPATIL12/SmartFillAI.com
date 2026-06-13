import type { FieldSignature } from '@shared/types';

/**
 * Extracts a FieldSignature from a form element.
 * Handles all the ways a label can be associated with an input in the wild:
 *   - <label for="id">
 *   - <label> wrapping the input
 *   - aria-label attribute
 *   - aria-labelledby pointing to another element
 *   - placeholder (last resort for label text)
 *   - legend of enclosing fieldset
 */
export function extractSignature(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
): FieldSignature {
  return {
    label: resolveLabel(el),
    placeholder: el.getAttribute('placeholder') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '',
    ariaLabel: el.getAttribute('aria-label') ?? '',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    inputType: el.tagName === 'TEXTAREA'
      ? 'textarea'
      : el.tagName === 'SELECT'
        ? 'select'
        : (el as HTMLInputElement).type?.toLowerCase() ?? 'text',
    maxLength: 'maxLength' in el && (el as HTMLInputElement).maxLength > 0
      ? (el as HTMLInputElement).maxLength
      : null,
    surroundingText: resolveSurroundingText(el),
    element: el,
  };
}

/**
 * Scan the page for all visible, interactive form fields.
 * Returns one FieldSignature per field, skipping fields inside iframes
 * (we can't access cross-origin iframes).
 */
export function extractAllFields(root: Document | Element = document): FieldSignature[] {
  const selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"])'
    + ':not([type="reset"]):not([type="image"]),'
    + 'textarea,'
    + 'select';

  const elements = Array.from(root.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(selector));

  return elements
    .filter(el => isVisible(el))
    .map(el => extractSignature(el));
}

// ── Label resolution ──────────────────────────────────────────────────────────

function resolveLabel(el: HTMLElement): string {
  // 1. aria-labelledby → points to one or more element IDs
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }

  // 2. Explicit <label for="id">
  const id = el.getAttribute('id');
  if (id) {
    const explicitLabel = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (explicitLabel) {
      return labelText(explicitLabel);
    }
  }

  // 3. Native labels collection (handles wrapping <label>)
  const inputEl = el as HTMLInputElement;
  if (inputEl.labels && inputEl.labels.length > 0) {
    return labelText(inputEl.labels[0]);
  }

  // 4. Parent label (in case .labels isn't populated in old JSDOM)
  const parentLabel = el.closest('label');
  if (parentLabel) return labelText(parentLabel);

  // 5. Fieldset legend as context
  const legend = el.closest('fieldset')?.querySelector('legend');
  if (legend) return legend.textContent?.trim() ?? '';

  // 6. Preceding sibling text node or element
  const prevText = el.previousElementSibling?.textContent?.trim();
  if (prevText) return prevText;

  return '';
}

/** Strip the input's own value/placeholder text from the label's textContent. */
function labelText(label: HTMLLabelElement | HTMLElement): string {
  // Clone to avoid mutating the DOM
  const clone = label.cloneNode(true) as HTMLElement;
  // Remove nested inputs/selects/textareas from the clone
  clone.querySelectorAll('input, textarea, select, button').forEach(n => n.remove());
  return clone.textContent?.trim() ?? '';
}

function resolveSurroundingText(el: HTMLElement): string {
  const parts: string[] = [];

  const prev = el.previousElementSibling?.textContent?.trim();
  if (prev) parts.push(prev);

  const next = el.nextElementSibling?.textContent?.trim();
  if (next) parts.push(next);

  // Parent div/span/p (but not the whole form)
  const parent = el.parentElement;
  if (parent && !['FORM', 'BODY', 'HTML'].includes(parent.tagName)) {
    const parentClone = parent.cloneNode(true) as HTMLElement;
    parentClone.querySelectorAll('input, textarea, select').forEach(n => n.remove());
    const parentText = parentClone.textContent?.trim() ?? '';
    if (parentText) parts.push(parentText);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  // offsetParent is null for elements with display:none ancestors
  if (el.offsetParent === null && style.position !== 'fixed') return false;
  return true;
}
