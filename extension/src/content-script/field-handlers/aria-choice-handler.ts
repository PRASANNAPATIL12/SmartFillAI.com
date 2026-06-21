import type { FieldHandler, FillContext } from './types';
import { expandCountryAliases } from '../country-aliases';
import { expandValueAliases, hasValueAliases } from '../value-aliases';
import { selectOptionByEmbedding } from '../option-embedding';

function groupAriaRadios(el: HTMLElement): HTMLElement[] {
  const group = el.closest('[role="radiogroup"]');
  if (group) {
    return Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
  }
  const parent = el.parentElement;
  if (parent) {
    return Array.from(parent.querySelectorAll<HTMLElement>('[role="radio"]'));
  }
  return [el];
}

function groupAriaCheckboxes(el: HTMLElement): HTMLElement[] {
  const group = el.closest('[role="group"], fieldset');
  if (group) {
    return Array.from(group.querySelectorAll<HTMLElement>('[role="checkbox"], [role="switch"]'));
  }
  return [el];
}

function ariaOptionLabel(el: HTMLElement): string {
  const computed = (el as any).computedName;
  if (typeof computed === 'string' && computed.trim()) return computed.trim();
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

const YES_VALUES = new Set(['yes', 'true', '1', 'on', 'checked']);

export const ariaChoiceHandler: FieldHandler = {
  kind: 'aria-choice',

  match(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement) return false;
    const role = el.getAttribute('role');
    return role === 'radio' || role === 'checkbox' || role === 'switch';
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    const role = el.getAttribute('role');

    if (role === 'radio') {
      return fillAriaRadio(el, value, ctx);
    }

    if (role === 'checkbox' || role === 'switch') {
      return fillAriaCheckbox(el, value, ctx);
    }

    return false;
  },

  capture(el: HTMLElement): string {
    const role = el.getAttribute('role');
    if (role === 'radio') {
      const radios = groupAriaRadios(el);
      const checked = radios.find(r => r.getAttribute('aria-checked') === 'true');
      return checked ? ariaOptionLabel(checked) : '';
    }
    if (role === 'checkbox' || role === 'switch') {
      const boxes = groupAriaCheckboxes(el);
      if (boxes.length === 1) {
        return el.getAttribute('aria-checked') === 'true' ? 'Yes' : 'No';
      }
      return boxes
        .filter(b => b.getAttribute('aria-checked') === 'true')
        .map(ariaOptionLabel)
        .filter(Boolean)
        .join(', ');
    }
    return '';
  },

  readOptions(el: HTMLElement): string[] {
    const role = el.getAttribute('role');
    if (role === 'radio') {
      return groupAriaRadios(el).map(ariaOptionLabel);
    }
    if (role === 'checkbox') {
      const boxes = groupAriaCheckboxes(el);
      if (boxes.length > 1) return boxes.map(ariaOptionLabel);
    }
    return [];
  },
};

async function fillAriaRadio(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
  const radios = groupAriaRadios(el);
  if (radios.length === 0) return false;
  const labels = radios.map(ariaOptionLabel);

  const aliases =
    ctx.canonicalKey === 'country' || ctx.canonicalKey === 'phone_country_code'
      ? expandCountryAliases(value)
      : hasValueAliases(ctx.canonicalKey) ? expandValueAliases(ctx.canonicalKey, value) : [value];
  const wanted = aliases.map(norm).filter(Boolean);

  let idx = labels.findIndex(l => wanted.includes(norm(l)));
  if (idx < 0) {
    idx = labels.findIndex(l => {
      const nl = norm(l);
      return nl.length > 0 && wanted.some(w => nl.includes(w) || w.includes(nl));
    });
  }
  if (idx < 0) {
    const m = await selectOptionByEmbedding(el, value, labels);
    if (m && m.index >= 0 && m.index < radios.length) idx = m.index;
  }

  if (idx < 0) {
    el.dataset.dittoStatus = 'FILL_FAILED';
    return false;
  }

  const target = radios[idx];
  if (target.getAttribute('aria-checked') !== 'true') {
    target.click();
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  target.dataset.dittoFilled = 'true';
  return true;
}

async function fillAriaCheckbox(el: HTMLElement, value: string, _ctx: FillContext): Promise<boolean> {
  const boxes = groupAriaCheckboxes(el);

  // Single checkbox / switch → toggle based on yes/no value
  if (boxes.length === 1) {
    const wantChecked = YES_VALUES.has(norm(value));
    const isChecked = el.getAttribute('aria-checked') === 'true';
    if (wantChecked !== isChecked) {
      el.click();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.dataset.dittoFilled = 'true';
    return true;
  }

  // Multi-checkbox group → match tokens against labels
  const labels = boxes.map(ariaOptionLabel);
  const labelsNorm = labels.map(norm);
  const tokens = value.split(/[,;|]/g).map(s => s.trim()).filter(Boolean);
  if (tokens.length === 0) return false;

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

  boxes.forEach((box, i) => {
    const isChecked = box.getAttribute('aria-checked') === 'true';
    const want = wantedIdxs.has(i);
    if (want !== isChecked) {
      box.click();
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  boxes.forEach(b => { b.dataset.dittoFilled = 'true'; });
  return true;
}
