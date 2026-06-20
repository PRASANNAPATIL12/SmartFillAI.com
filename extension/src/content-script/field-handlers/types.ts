/**
 * Field-handler abstraction (open/closed dispatch).
 *
 * Each form-field "kind" (plain text, native <select>, ARIA combobox,
 * button-triggered dropdown, radio group, …) is encapsulated in ONE handler
 * implementing this interface. `fillElement` and the learning capture path
 * route through the registry instead of a hard-coded if/else, so adding a new
 * field kind = add one handler file + register it. Existing handlers and flows
 * are never touched.
 *
 * Handlers DELEGATE to the existing fill/capture functions (fillSelect,
 * fillCombobox, fillButtonDropdown, fillPlainInput, getComboboxDisplayValue) —
 * no fill logic is reimplemented here. This keeps behavior byte-identical while
 * decoupling dispatch from implementation.
 */

import type { FieldSignature } from '@shared/types';

/** Extra context a handler may need to fill a field. */
export interface FillContext {
  /** The matched profile canonical_key (drives alias expansion in dropdowns). */
  canonicalKey?: string;
  /** The field signature, when available (options, label, etc.). */
  sig?: FieldSignature;
}

export interface FieldHandler {
  /** Stable identifier for this kind, e.g. 'text' | 'select' | 'combobox'. */
  kind: string;

  /** True when this handler owns the given element. Evaluated in registry order. */
  match(el: HTMLElement): boolean;

  /** Write `value` into the element. Returns true if the write was applied. */
  fill(el: HTMLElement, value: string, ctx: FillContext): Promise<boolean>;

  /**
   * Read the value the user currently has in the field (for learning).
   * Returns null/'' when there's nothing meaningful to learn.
   */
  capture(el: HTMLElement): string | null;

  /** Optional: list the selectable option labels (choice widgets only). */
  readOptions?(el: HTMLElement): string[];
}
