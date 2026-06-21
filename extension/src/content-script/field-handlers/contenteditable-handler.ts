import type { FieldHandler } from './types';

export const contenteditableHandler: FieldHandler = {
  kind: 'contenteditable',

  match(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return false;
    return el.isContentEditable || el.getAttribute('role') === 'textbox';
  },

  async fill(el: HTMLElement, value: string): Promise<boolean> {
    const plainValue = value.replace(/<[^>]*>/g, '');

    el.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);

    // execCommand('insertText') triggers the editor's input handler —
    // works with ProseMirror, Tiptap, Quill, CKEditor, plain contenteditable.
    if (!document.execCommand('insertText', false, plainValue)) {
      el.innerText = plainValue;
    }

    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dataset.dittoFilled = 'true';
    return true;
  },

  capture(el: HTMLElement): string {
    return el.innerText?.trim() ?? '';
  },
};
