/**
 * Button-triggered custom dropdown (phone country-code pickers, intl-tel-input,
 * and any element that isn't a native input/textarea/select). Matches FIRST so
 * non-form widgets never fall through to the text path.
 */
import type { FieldHandler, FillContext } from './types';
import { fillButtonDropdown } from '../combobox';

const ARIA_WIDGET_ROLES = new Set([
  'combobox', 'listbox', 'textbox', 'searchbox',
  'radio', 'radiogroup', 'checkbox', 'switch', 'spinbutton',
]);

export const buttonDropdownHandler: FieldHandler = {
  kind: 'button-dropdown',

  match(el: HTMLElement): boolean {
    if (el instanceof HTMLButtonElement) return true;
    if (el.getAttribute('role') === 'button') return true;
    const role = el.getAttribute('role');
    if (role && ARIA_WIDGET_ROLES.has(role)) return false;
    return el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT';
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    return fillButtonDropdown(el, value, ctx.canonicalKey);
  },

  capture(el: HTMLElement): string {
    return (el.textContent ?? '').trim();
  },
};
