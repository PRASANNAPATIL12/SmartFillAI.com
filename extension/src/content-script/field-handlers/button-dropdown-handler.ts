/**
 * Button-triggered custom dropdown (phone country-code pickers, intl-tel-input,
 * and any element that isn't a native input/textarea/select). Matches FIRST so
 * non-form widgets never fall through to the text path.
 */
import type { FieldHandler, FillContext } from './types';
import { fillButtonDropdown } from '../combobox';

export const buttonDropdownHandler: FieldHandler = {
  kind: 'button-dropdown',

  match(el: HTMLElement): boolean {
    return el instanceof HTMLButtonElement
      || el.getAttribute('role') === 'button'
      || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT');
  },

  async fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean> {
    console.log('[SFA-DIAG] fillElement → fillButtonDropdown', { tag: el.tagName, role: el.getAttribute('role'), value, canonicalKey: ctx.canonicalKey });
    return fillButtonDropdown(el, value, ctx.canonicalKey);
  },

  capture(el: HTMLElement): string {
    return (el.textContent ?? '').trim();
  },
};
