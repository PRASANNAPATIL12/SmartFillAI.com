/** Native <select> dropdown. Delegates to fillSelect (Cache 3 + alias + embedding). */
import type { FieldHandler, FillContext } from './types';
import { fillSelect } from '../filler';

export const selectHandler: FieldHandler = {
  kind: 'select',

  match(el: HTMLElement): boolean {
    return el instanceof HTMLSelectElement;
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    const sel = el as HTMLSelectElement;
    return fillSelect(sel, value, ctx.canonicalKey);
  },

  capture(el: HTMLElement): string {
    return (el as HTMLSelectElement).value ?? '';
  },

  readOptions(el: HTMLElement): string[] {
    return Array.from((el as HTMLSelectElement).options).map(o => o.text);
  },
};
