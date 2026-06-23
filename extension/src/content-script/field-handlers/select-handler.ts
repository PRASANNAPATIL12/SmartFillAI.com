/** Native <select> dropdown. Delegates to fillSelect (Cache 3 + alias + embedding). */
import type { FieldHandler, FillContext } from './types';
import { fillSelect } from '../filler';

const DATE_CANONICAL_KEYS = new Set([
  'date_of_birth', 'joining_date', 'start_date', 'graduation_date',
]);

/**
 * When a date canonical key fills a <select> that represents a single date
 * component (day 1-31, month 1-12 / names, or year), extract only the relevant
 * component from the ISO string so the select gets a matchable value.
 *
 * Autocomplete attribute is the authoritative signal when present.
 * Falls back to sniffing option content.
 */
function extractDateComponent(iso: string, el: HTMLSelectElement): string | null {
  const ac = (el.autocomplete ?? '').toLowerCase();
  if (ac === 'bday-day')   return String(parseInt(iso.split('-')[2] ?? '0', 10));
  if (ac === 'bday-month') return iso.split('-')[1] ?? '';
  if (ac === 'bday-year')  return iso.split('-')[0] ?? '';

  // Infer from option values/text when autocomplete is absent
  const opts = Array.from(el.options).map(o => o.text.trim());
  const isYearOpts  = opts.some(o => /^(19|20)\d{2}$/.test(o));
  const isMonthOpts = !isYearOpts
    && (opts.some(o => /^(jan|feb|mar|apr|may|jun)/i.test(o))
        || opts.some(o => /^(0?[1-9]|1[0-2])$/.test(o) && opts.length <= 13));
  const isDayOpts   = !isYearOpts && !isMonthOpts
    && opts.length <= 32
    && opts.every(o => /^\d{1,2}$/.test(o) && parseInt(o, 10) <= 31);

  if (isYearOpts)  return iso.split('-')[0] ?? '';
  if (isMonthOpts) return iso.split('-')[1] ?? '';
  if (isDayOpts)   return String(parseInt(iso.split('-')[2] ?? '0', 10));
  return null;
}

export const selectHandler: FieldHandler = {
  kind: 'select',

  match(el: HTMLElement): boolean {
    return el instanceof HTMLSelectElement;
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    const sel = el as HTMLSelectElement;
    let fillValue = value;

    // For date canonical keys, detect if this select is a partial component
    if (ctx.canonicalKey && DATE_CANONICAL_KEYS.has(ctx.canonicalKey)) {
      const component = extractDateComponent(value, sel);
      if (component !== null) fillValue = component;
    }

    return fillSelect(sel, fillValue, ctx.canonicalKey);
  },

  capture(el: HTMLElement): string {
    return (el as HTMLSelectElement).value ?? '';
  },

  readOptions(el: HTMLElement): string[] {
    return Array.from((el as HTMLSelectElement).options).map(o => o.text);
  },
};
