/**
 * Field-handler registry — the single dispatch point for fill + capture.
 *
 * To support a NEW field kind: write a handler module implementing FieldHandler
 * and add it to the HANDLERS array below. Nothing else changes — `fillElement`
 * and the learning capture path resolve through here automatically.
 *
 * ORDER IS SIGNIFICANT. resolveHandler returns the FIRST handler whose match()
 * is true, so the array must preserve the original fillElement if/else
 * precedence: button-dropdown → select → combobox → text (fallback last).
 */
import type { FieldHandler } from './types';
import { buttonDropdownHandler } from './button-dropdown-handler';
import { selectHandler } from './select-handler';
import { comboboxHandler } from './combobox-handler';
import { textHandler } from './text-handler';

const HANDLERS: FieldHandler[] = [
  buttonDropdownHandler,
  selectHandler,
  comboboxHandler,
  // ← new field-kind handlers go here, before the text fallback
  textHandler,
];

/** Return the handler that owns this element (text handler is the safe fallback). */
export function resolveHandler(el: HTMLElement): FieldHandler {
  return HANDLERS.find(h => h.match(el)) ?? textHandler;
}
