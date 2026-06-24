import type { FieldHandler, FillContext } from './types';
import { fillButtonDropdown, getComboboxDisplayValue } from '../combobox';
import { gatherDropdownOptions } from '../detector';

export const ariaComboboxHandler: FieldHandler = {
  kind: 'aria-combobox',

  match(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        || el instanceof HTMLSelectElement) return false;
    return el.getAttribute('role') === 'combobox';
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    return fillButtonDropdown(el, value, ctx.canonicalKey);
  },

  capture(el: HTMLElement): string {
    const matValue = el.querySelector?.('.mat-mdc-select-value-text, .mat-select-value-text, [class*="select-value-text"]');
    if (matValue) {
      const text = (matValue.textContent ?? '').trim();
      if (text) return text;
    }
    const display = getComboboxDisplayValue(el);
    if (display) return display;
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  },

  readOptions(el: HTMLElement): string[] {
    return gatherDropdownOptions(el) ?? [];
  },
};
