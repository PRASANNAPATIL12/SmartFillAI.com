/**
 * Checkbox group handler — multi-select equivalent of radio-group-handler.
 *
 *   value is comma-separated ("Supplychain, Industrial AI") — the same shape
 *   the user sees and `capture()` produces. Fill checks the matching boxes
 *   and UNCHECKS any others, so repeated fills are idempotent.
 *
 * Group membership: shared `name` (Greenhouse style `question_<id>[]`) OR
 * nearest fieldset / [role="group"] container (mirrors the detector).
 *
 * Adding this whole input kind required: one new file + one line in the
 * registry. Existing handlers untouched.
 */
import type { FieldHandler, FillContext } from './types';
import { selectOptionByEmbedding } from '../option-embedding';

function groupCheckboxes(el: HTMLElement): HTMLInputElement[] {
  if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return [];

  // 1) Shared name within the same form.
  if (el.name) {
    const scope: ParentNode = el.form ?? document;
    const named = Array.from(
      scope.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`)
    );
    if (named.length > 1) return named;
  }

  // 2) Nearest fieldset / [role=group] container.
  const container = el.closest('fieldset, [role="group"]') as HTMLElement | null;
  if (container) {
    const cb = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    if (cb.length > 0) return cb;
  }

  return [el];
}

function optionLabel(c: HTMLInputElement): string {
  if (c.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(c.id)}"]`);
    const t = lbl?.textContent?.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  const wrap = c.closest('label');
  const wt = wrap?.textContent?.replace(/\s+/g, ' ').trim();
  if (wt) return wt;
  const aria = c.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const sib = c.nextElementSibling as HTMLElement | null;
  const st = sib?.textContent?.replace(/\s+/g, ' ').trim();
  if (st) return st;
  return (c.value || '').trim();
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function setChecked(box: HTMLInputElement, want: boolean): void {
  if (box.checked === want) return;
  box.click(); // toggles + fires native click → React onChange
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Parse a stored value into individual option tokens. */
function tokenize(value: string): string[] {
  // Treat comma, semicolon, or pipe as separators. Trim per token.
  return value.split(/[,;|]/g).map(s => s.trim()).filter(Boolean);
}

export const checkboxGroupHandler: FieldHandler = {
  kind: 'checkbox-group',

  match(el: HTMLElement): boolean {
    return el instanceof HTMLInputElement && el.type === 'checkbox';
  },

  async fill(el: HTMLElement, value: string, _ctx: FillContext): Promise<boolean> {
    const boxes = groupCheckboxes(el);
    if (boxes.length === 0) return false;
    const labels = boxes.map(optionLabel);
    const labelsNorm = labels.map(norm);

    const tokens = tokenize(value);
    if (tokens.length === 0) return false;

    // For each token: exact-norm match → containment → embedding fallback.
    const wantedIdxs = new Set<number>();
    for (const tok of tokens) {
      const tn = norm(tok);
      let idx = labelsNorm.findIndex(l => l === tn);
      if (idx < 0) idx = labelsNorm.findIndex(l => l.length > 0 && (l.includes(tn) || tn.includes(l)));
      if (idx < 0) {
        const m = await selectOptionByEmbedding(el, tok, labels);
        if (m && m.index >= 0 && m.index < boxes.length) idx = m.index;
      }
      if (idx >= 0) wantedIdxs.add(idx);
    }

    if (wantedIdxs.size === 0) {
      el.dataset.dittoStatus = 'FILL_FAILED';
      return false;
    }

    // Idempotent: check wanted, uncheck the rest.
    boxes.forEach((box, i) => setChecked(box, wantedIdxs.has(i)));
    boxes.forEach(b => { b.dataset.dittoFilled = 'true'; });
    return true;
  },

  capture(el: HTMLElement): string {
    return groupCheckboxes(el)
      .filter(b => b.checked)
      .map(optionLabel)
      .filter(t => t.length > 0)
      .join(', ');
  },

  readOptions(el: HTMLElement): string[] {
    return groupCheckboxes(el).map(optionLabel);
  },
};
