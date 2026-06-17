import type { FieldSignature } from '@shared/types';

/**
 * Extracts a FieldSignature from a form element.
 * Handles all the ways a label can be associated with an input in the wild:
 *   - <label for="id">
 *   - <label> wrapping the input
 *   - aria-label attribute
 *   - aria-labelledby pointing to another element
 *   - placeholder (last resort for label text)
 *   - legend of enclosing fieldset
 */
export function extractSignature(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
): FieldSignature {
  return {
    label: resolveLabel(el),
    placeholder: el.getAttribute('placeholder') ?? '',
    name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '',
    ariaLabel: el.getAttribute('aria-label') ?? '',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    inputType: el.tagName === 'TEXTAREA'
      ? 'textarea'
      : el.tagName === 'SELECT'
        ? 'select'
        : (el as HTMLInputElement).type?.toLowerCase() ?? 'text',
    maxLength: 'maxLength' in el && (el as HTMLInputElement).maxLength > 0
      ? (el as HTMLInputElement).maxLength
      : null,
    surroundingText: resolveSurroundingText(el),
    accept: el.tagName === 'INPUT' ? (el as HTMLInputElement).accept ?? '' : '',
    element: el,
  };
}

/**
 * Scan the page for all visible, interactive form fields.
 * Returns one FieldSignature per field, skipping fields inside iframes
 * (we can't access cross-origin iframes).
 */
export function extractAllFields(root: Document | Element = document): FieldSignature[] {
  const selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"])'
    + ':not([type="reset"]):not([type="image"]),'
    + 'textarea,'
    + 'select';

  const elements = Array.from(root.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(selector));

  const seen = new Set<HTMLElement>();
  const sigs: FieldSignature[] = [];
  for (const el of elements) {
    if (!isVisible(el)) continue;
    seen.add(el);
    sigs.push(extractSignature(el));
  }

  // Additional discovery passes for non-standard widgets that don't render as
  // a visible <input>/<select>/<textarea>:
  //   • extractButtonDropdowns — phone country-code button pickers
  //   • extractFileInputs       — input[type=file] that's display:none but
  //                                 reachable through a styled label/button
  //   • extractDropzones        — drag-and-drop <div>s with no inner input
  return [
    ...sigs,
    ...extractButtonDropdowns(root),
    ...extractFileInputs(root, seen),
    ...extractDropzones(root, seen),
  ];
}

/**
 * Find button-triggered phone country code pickers adjacent to <input type="tel">.
 *
 * Heuristic: for each visible tel input, check its container for a sibling/cousin
 * button that either:
 *   (a) has aria-haspopup / aria-expanded, OR
 *   (b) shows a calling-code pattern (+NNN) or emoji flag in its text.
 *
 * Returns synthetic FieldSignatures with `autocomplete: "tel-country-code"` so the
 * matcher always assigns canonical_key = "phone_country_code".
 */
function extractButtonDropdowns(root: Document | Element): FieldSignature[] {
  const results: FieldSignature[] = [];
  const FLAG_RE    = /^[\u{1F1E0}-\u{1F1FF}]{2}/u;
  const CODE_RE    = /^\+\d{1,4}(\s|$)/;
  const seen = new Set<HTMLElement>();

  const telInputs = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="tel"]')
  ).filter(el => isVisible(el));

  for (const telEl of telInputs) {
    // Search container: 2 levels up from the tel input
    const container = telEl.parentElement?.parentElement ?? telEl.parentElement;
    if (!container) continue;

    const candidates = Array.from(container.querySelectorAll<HTMLElement>(
      'button, [role="button"], [aria-haspopup], [aria-expanded]'
    )).filter(el => isVisible(el) && el !== (telEl as HTMLElement) && !seen.has(el));

    for (const btn of candidates) {
      const text          = (btn.textContent ?? '').trim();
      const hasAriaSignal = btn.hasAttribute('aria-haspopup') || btn.hasAttribute('aria-expanded');
      const looksLikePicker = FLAG_RE.test(text) || CODE_RE.test(text);

      if (!hasAriaSignal && !looksLikePicker) continue;

      seen.add(btn);

      const ariaLabel = btn.getAttribute('aria-label')?.trim() ?? '';
      const label     = ariaLabel || 'Phone Country Code';

      results.push({
        label,
        placeholder: '',
        name:        btn.getAttribute('name') ?? '',
        id:          btn.getAttribute('id')   ?? '',
        ariaLabel,
        // Synthetic autocomplete so the matcher always hits the phone_country_code rule.
        autocomplete: 'tel-country-code',
        inputType:   'button',
        maxLength:   null,
        surroundingText: [
          telEl.getAttribute('aria-label') ?? '',
          telEl.getAttribute('placeholder') ?? '',
          telEl.getAttribute('name') ?? '',
        ].join(' ').trim(),
        element: btn,
      });
      break; // one picker per tel input
    }
  }

  return results;
}

/**
 * Find input[type="file"] that's hidden (display:none, opacity:0, etc.) but
 * functionally reachable via a visible label, wrapping label, or sibling button.
 *
 * This is the Happiest Minds / iCIMS / Bullhorn pattern: the real file input
 * lives at `display:none` and a styled <button>Choose File</button> click-
 * delegates to it. `extractAllFields()`'s primary isVisible() filter rejects
 * the hidden input, so we'd never enter it into matchMap — fill silently fails
 * even though setting `.files` on the hidden input works perfectly.
 *
 * Strategy: include the input if EITHER it's visible OR an anchor (label /
 * sibling button) is visible. Enrich `surroundingText` with the anchor's text
 * so `classifyFileField()` can pick up resume/cover-letter hints that live
 * only on the visible trigger.
 */
const UPLOAD_BUTTON_PATTERN =
  /upload|attach|choose.*file|select.*file|browse|\bresume\b|\bcv\b|cover.?letter/i;

function findFileInputAnchor(input: HTMLInputElement): HTMLElement | null {
  if (isVisible(input)) return input;

  // 1. Explicit <label for="id">
  const id = input.getAttribute('id');
  if (id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (lbl && isVisible(lbl)) return lbl;
  }

  // 2. Parent <label> (input nested inside)
  const parentLabel = input.closest('label');
  if (parentLabel && isVisible(parentLabel)) return parentLabel;

  // 3. Sibling/cousin button/[role=button]/label in same form-row container.
  //    Walk up max 3 levels — most upload rows nest within 2 wrappers.
  let container: HTMLElement | null = input.parentElement;
  for (let depth = 0; depth < 3 && container; depth++) {
    const cands = Array.from(container.querySelectorAll<HTMLElement>(
      'button, [role="button"], label, a'
    ));
    for (const c of cands) {
      if (c === input || !isVisible(c)) continue;
      const onclick = c.getAttribute('onclick') ?? '';
      if (id && onclick.includes(id)) return c;
      const text = (c.textContent ?? '').trim();
      const aria = c.getAttribute('aria-label') ?? '';
      if (UPLOAD_BUTTON_PATTERN.test(text) || UPLOAD_BUTTON_PATTERN.test(aria)) {
        return c;
      }
    }
    container = container.parentElement;
  }

  return null;
}

/**
 * Walk up to 8 ancestor levels gathering text content (excluding nested
 * form fields). Used to enrich the surroundingText of a hidden file input
 * so classifyFileField can find "Upload Resume" labels that live outside
 * the input's immediate parent.
 *
 * Early-terminates when we hit a level whose text already contains
 * resume/cv/cover-letter — prevents contamination from form-wide text
 * on pages with multiple file uploads where both labels would otherwise
 * appear in every input's surroundingText.
 */
const DOC_SIGNAL_PATTERN = /\bresume\b|\bcv\b|curriculum[-_\s]*vitae|cover[-_\s]?letter|motivation[-_\s]?letter/i;

function gatherAncestorText(input: HTMLElement, maxDepth = 8): string {
  const parts: string[] = [];
  let node: HTMLElement | null = input.parentElement;

  for (let depth = 0; depth < maxDepth && node; depth++) {
    if (node.tagName === 'BODY') break;

    const clone = node.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, textarea, select, script, style').forEach(n => n.remove());
    const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();

    if (text && !parts.some(p => p.includes(text) || text.includes(p))) {
      parts.push(text.slice(0, 250));
    }

    // Early-terminate: this level already provides the doc-type signal.
    // Walking further up risks pulling in the sibling row's "Cover Letter"
    // label and contaminating a resume input (or vice versa).
    if (text && DOC_SIGNAL_PATTERN.test(text)) break;

    node = node.parentElement;
  }

  return parts.join(' ').slice(0, 700);
}

function extractFileInputs(
  root: Document | Element,
  seen: Set<HTMLElement>
): FieldSignature[] {
  const results: FieldSignature[] = [];
  const fileInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]'));

  for (const input of fileInputs) {
    if (seen.has(input)) continue;            // already returned by primary pass
    if (!input.isConnected) continue;

    const sig = extractSignature(input);

    // ALWAYS include hidden file inputs — classifyFileField + findSectionLabel
    // in matcher.ts already require explicit resume/cv/cover-letter text to
    // classify as FILE_UPLOAD, so unrelated hidden inputs (image uploads,
    // honeypots) stay UNKNOWN and never get filled. This is more reliable
    // than gating on anchor visibility, which is brittle for custom HR
    // portals where the trigger button might be a <div> or far from the input.
    //
    // Enrich surroundingText with:
    //   1) The anchor button/label text if findable
    //   2) Ancestor text walked up 6 levels (catches "Upload Resume*" labels
    //      placed several wrappers away from the hidden input)
    const anchor = findFileInputAnchor(input);
    const anchorText  = anchor ? (anchor.textContent ?? '').trim() : '';
    const anchorAria  = anchor ? (anchor.getAttribute('aria-label') ?? '').trim() : '';
    const anchorClass = anchor ? (anchor.getAttribute('class') ?? '') : '';
    const ancestorText = isVisible(input) ? '' : gatherAncestorText(input);

    sig.surroundingText = [sig.surroundingText, anchorText, anchorAria, anchorClass, ancestorText]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 800);

    seen.add(input);
    results.push(sig);
  }

  return results;
}

/**
 * Detect drag-and-drop upload zones — <div>s with no nested <input> until the
 * user drops a file. Workday / SmartRecruiters / Ashby / Filepond patterns.
 *
 * Emits a synthetic FieldSignature with `inputType: 'file'` and `element` set
 * to the dropzone div. The filler branches on `dataset.dittoDropzone === 'true'`
 * to dispatch synthetic DragEvents instead of setting `.files`.
 */
const DROPZONE_SELECTOR = [
  '[class*="dropzone" i]',
  '[class*="drop-zone" i]',
  '[class*="file-drop" i]',
  '[class*="upload-area" i]',
  '[class*="upload-zone" i]',
  '[class*="filepond" i]',
  '[data-dropzone]',
  '[aria-label*="drop file" i]',
  '[aria-label*="upload resume" i]',
  '[aria-label*="drag" i]',
].join(',');

const DROPZONE_TEXT_PATTERN =
  /drag\s*(?:and|&)?\s*drop|drop\s*(?:your\s*)?(?:file|resume|cv)|drop\s*here|upload\s*(?:your\s*)?(?:resume|cv|file)|choose\s*(?:a\s*)?file|browse\s*(?:files?|to\s*upload)/i;

function extractDropzones(
  root: Document | Element,
  seen: Set<HTMLElement>
): FieldSignature[] {
  const results: FieldSignature[] = [];
  const candidates = new Set<HTMLElement>();

  // (a) explicit class/data/aria match
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(DROPZONE_SELECTOR))) {
    candidates.add(el);
  }

  // (b) <div role=button> / <div tabindex> whose text reads like a dropzone
  const fallback = Array.from(root.querySelectorAll<HTMLElement>(
    'div[role="button"], div[tabindex]'
  ));
  for (const el of fallback) {
    const text = (el.textContent ?? '').trim();
    if (text && text.length < 300 && DROPZONE_TEXT_PATTERN.test(text)) {
      candidates.add(el);
    }
  }

  for (const div of candidates) {
    if (seen.has(div)) continue;
    if (!div.isConnected || !isVisible(div)) continue;

    // If the dropzone already has a <input type="file"> inside, the input
    // pass will handle it. Don't double-emit; that would attach the file
    // twice (once via .files, once via DragEvent).
    if (div.querySelector('input[type="file"]')) continue;

    // Mark for filler.ts to choose the DragEvent path.
    div.dataset.dittoDropzone = 'true';

    const text = (div.textContent ?? '').trim().slice(0, 200);
    const aria = div.getAttribute('aria-label')?.trim() ?? '';
    const cls  = div.getAttribute('class') ?? '';

    seen.add(div);
    results.push({
      label:           aria || 'File Upload',
      placeholder:     '',
      name:            '',
      id:              div.getAttribute('id') ?? '',
      ariaLabel:       aria,
      autocomplete:    '',
      inputType:       'file',
      maxLength:       null,
      surroundingText: [text, aria, cls].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 500),
      accept:          div.getAttribute('data-accept') ?? '',
      element:         div,
    });
  }

  return results;
}

// ── Label resolution ──────────────────────────────────────────────────────────

function resolveLabel(el: HTMLElement): string {
  // 1. aria-labelledby → points to one or more element IDs
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }

  // 2. Explicit <label for="id">
  const id = el.getAttribute('id');
  if (id) {
    const explicitLabel = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (explicitLabel) {
      return labelText(explicitLabel);
    }
  }

  // 3. Native labels collection (handles wrapping <label>)
  const inputEl = el as HTMLInputElement;
  if (inputEl.labels && inputEl.labels.length > 0) {
    return labelText(inputEl.labels[0]);
  }

  // 4. Parent label (in case .labels isn't populated in old JSDOM)
  const parentLabel = el.closest('label');
  if (parentLabel) return labelText(parentLabel);

  // 5. Fieldset legend as context
  const legend = el.closest('fieldset')?.querySelector('legend');
  if (legend) return legend.textContent?.trim() ?? '';

  // 6. Preceding sibling text node or element
  const prevText = el.previousElementSibling?.textContent?.trim();
  if (prevText) return prevText;

  return '';
}

/** Strip the input's own value/placeholder text from the label's textContent. */
function labelText(label: HTMLLabelElement | HTMLElement): string {
  // Clone to avoid mutating the DOM
  const clone = label.cloneNode(true) as HTMLElement;
  // Remove nested inputs/selects/textareas from the clone
  clone.querySelectorAll('input, textarea, select, button').forEach(n => n.remove());
  return clone.textContent?.trim() ?? '';
}

function resolveSurroundingText(el: HTMLElement): string {
  const parts: string[] = [];

  const prev = el.previousElementSibling?.textContent?.trim();
  if (prev) parts.push(prev);

  const next = el.nextElementSibling?.textContent?.trim();
  if (next) parts.push(next);

  // Parent div/span/p (but not the whole form)
  const parent = el.parentElement;
  if (parent && !['FORM', 'BODY', 'HTML'].includes(parent.tagName)) {
    const parentClone = parent.cloneNode(true) as HTMLElement;
    parentClone.querySelectorAll('input, textarea, select').forEach(n => n.remove());
    const parentText = parentClone.textContent?.trim() ?? '';
    if (parentText) parts.push(parentText);
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  // offsetParent is null for elements with display:none ancestors
  if (el.offsetParent === null && style.position !== 'fixed') return false;
  return true;
}
