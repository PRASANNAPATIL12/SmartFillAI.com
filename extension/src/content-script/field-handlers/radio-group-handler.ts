/**
 * Radio group handler — the first field kind added on top of the registry,
 * proving the extension point: one new file + one line in registry.ts.
 *
 * A radio group is N <input type="radio"> sharing a `name`. The detector emits
 * one signature per group (element = representative radio). This handler
 * re-derives the full group from any member via that shared name, then:
 *   • fill  → match the stored value to a radio label (alias → partial →
 *             embedding) and click that radio.
 *   • capture → the label of the currently-checked radio (for learning).
 */
import type { FieldHandler, FillContext } from './types';
import { expandCountryAliases } from '../country-aliases';
import { expandValueAliases, hasValueAliases } from '../value-aliases';
import { selectOptionByEmbedding } from '../option-embedding';

function groupRadios(el: HTMLElement): HTMLInputElement[] {
  if (!(el instanceof HTMLInputElement)) return [];
  const name = el.name;
  if (!name) return [el];
  const scope: ParentNode = el.form ?? document;
  return Array.from(
    scope.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`)
  );
}

/** Visible label for a single radio option (mirrors detector's radioOptionLabel). */
function optionLabel(r: HTMLInputElement): string {
  if (r.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
    const t = lbl?.textContent?.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  const wrap = r.closest('label');
  const wt = wrap?.textContent?.replace(/\s+/g, ' ').trim();
  if (wt) return wt;
  const aria = r.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const sib = r.nextElementSibling as HTMLElement | null;
  const st = sib?.textContent?.replace(/\s+/g, ' ').trim();
  if (st) return st;
  return (r.value || '').trim();
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

export const radioGroupHandler: FieldHandler = {
  kind: 'radio-group',

  match(el: HTMLElement): boolean {
    return el instanceof HTMLInputElement && el.type === 'radio';
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    const radios = groupRadios(el);
    if (radios.length === 0) return false;
    const labels = radios.map(optionLabel);

    // Expand the stored value to every alias the option label might use
    // (yes/no, gender, country) — same pipeline as fillSelect/fillCombobox.
    const aliases =
      ctx.canonicalKey === 'country' || ctx.canonicalKey === 'phone_country_code'
        ? expandCountryAliases(value)
        : hasValueAliases(ctx.canonicalKey) ? expandValueAliases(ctx.canonicalKey, value) : [value];
    const wanted = aliases.map(norm).filter(Boolean);

    // 1. exact label match, 2. partial containment
    let idx = labels.findIndex(l => wanted.includes(norm(l)));
    if (idx < 0) {
      idx = labels.findIndex(l => {
        const nl = norm(l);
        return nl.length > 0 && wanted.some(w => nl.includes(w) || w.includes(nl));
      });
    }
    // 3. embedding fallback (semantic) — same helper the dropdowns use
    if (idx < 0) {
      const m = await selectOptionByEmbedding(el, value, labels);
      if (m && m.index >= 0 && m.index < radios.length) idx = m.index;
    }

    if (idx < 0) {
      // No confident option — mark for visibility, don't guess.
      el.dataset.dittoStatus = 'FILL_FAILED';
      return false;
    }

    const target = radios[idx];
    if (!target.checked) {
      target.click(); // checks it + fires native click → React/Vue onChange
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    target.dataset.dittoFilled = 'true';
    return target.checked;
  },

  capture(el: HTMLElement): string {
    const checked = groupRadios(el).find(r => r.checked);
    return checked ? optionLabel(checked) : '';
  },

  readOptions(el: HTMLElement): string[] {
    return groupRadios(el).map(optionLabel);
  },
};
