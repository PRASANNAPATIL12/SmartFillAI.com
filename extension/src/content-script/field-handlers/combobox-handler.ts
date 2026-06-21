/** ARIA combobox / custom dropdown (react-select, Greenhouse, Workday, Lever). */
import type { FieldHandler, FillContext } from './types';
import { fillCombobox, isCombobox, getComboboxDisplayValue } from '../combobox';

export const comboboxHandler: FieldHandler = {
  kind: 'combobox',

  match(el: HTMLElement): boolean {
    return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && isCombobox(el);
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    return fillCombobox(el as HTMLInputElement | HTMLTextAreaElement, value, ctx.canonicalKey);
  },

  capture(el: HTMLElement): string {
    return getComboboxDisplayValue(el);
  },
};
