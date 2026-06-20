/** Plain <input>/<textarea>. Fallback handler — matches last in the registry. */
import type { FieldHandler } from './types';
import { fillPlainInput } from '../filler';

export const textHandler: FieldHandler = {
  kind: 'text',

  match(el: HTMLElement): boolean {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  },

  async fill(el: HTMLElement, value: string): Promise<boolean> {
    return fillPlainInput(el as HTMLInputElement | HTMLTextAreaElement, value);
  },

  capture(el: HTMLElement): string {
    return (el as HTMLInputElement).value ?? '';
  },
};
