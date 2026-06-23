/** Plain <input>/<textarea>. Fallback handler — matches last in the registry. */
import type { FieldHandler, FillContext } from './types';
import { fillPlainInput } from '../filler';

const DATE_CANONICAL_KEYS = new Set([
  'date_of_birth', 'joining_date', 'start_date', 'graduation_date',
]);

/**
 * For <input type="number"> fields that represent a single date component
 * (day or year), extract just that component from the ISO date string.
 * Month inputs are typically <select> and handled in select-handler.ts.
 */
function extractDateComponent(iso: string, el: HTMLInputElement): string | null {
  const ac = (el.autocomplete ?? '').toLowerCase();
  if (ac === 'bday-day')  return String(parseInt(iso.split('-')[2] ?? '0', 10));
  if (ac === 'bday-year') return iso.split('-')[0] ?? '';
  return null;
}

export const textHandler: FieldHandler = {
  kind: 'text',

  match(el: HTMLElement): boolean {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    let fillValue = value;

    // Extract day/year component for number inputs used as date parts
    if (el instanceof HTMLInputElement && el.type === 'number'
        && ctx.canonicalKey && DATE_CANONICAL_KEYS.has(ctx.canonicalKey)) {
      const component = extractDateComponent(value, el);
      if (component !== null) fillValue = component;
    }

    return fillPlainInput(el as HTMLInputElement | HTMLTextAreaElement, fillValue);
  },

  capture(el: HTMLElement): string {
    return (el as HTMLInputElement).value ?? '';
  },
};
