import type { FieldHandler, FillContext } from './types';
import { fillButtonDropdown } from '../combobox';
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
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  },

  readOptions(el: HTMLElement): string[] {
    return gatherDropdownOptions(el) ?? [];
  },
};
