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
    options: gatherDropdownOptions(el),
    element: el,
  };
}

/**
 * Best-effort discovery of a dropdown's option texts. Used by matcher's
 * `classifyByOptionSet()` to override regex classification when the option
 * set is more decisive than the label.
 *
 * Sources tried, in order:
 *   1. Native `<select>` — `el.options[i].text` (always works).
 *   2. `aria-controls` → element by id → `[role="option"]` text (catches
 *      pre-rendered ARIA listboxes, e.g. Greenhouse / Workday / many MUI).
 *   3. `aria-owns` → same pattern as aria-controls.
 *   4. Sibling listbox: a visible `[role="listbox"]` in the same form-row
 *      container (up to 3 ancestors). Catches HeadlessUI's pattern.
 *
 * Capped at 500 options to avoid pathological pages.
 * Returns `undefined` when no options are discoverable (the listbox lazy-
 * mounts on click). The fill path will re-read at click-time for those.
 */
function gatherDropdownOptions(el: HTMLElement): string[] | undefined {
  // 1. Native <select>
  if (el instanceof HTMLSelectElement) {
    const opts = Array.from(el.options)
      .map(o => (o.text ?? '').trim())
      .filter(Boolean);
    return opts.length > 0 ? opts.slice(0, 500) : undefined;
  }

  // 2. aria-controls
  const controlsId = el.getAttribute('aria-controls');
  if (controlsId) {
    const lb = document.getElementById(controlsId);
    if (lb) {
      const opts = readListboxOptions(lb);
      if (opts.length > 0) return opts.slice(0, 500);
    }
  }

  // 3. aria-owns (alternative pattern)
  const ownsId = el.getAttribute('aria-owns');
  if (ownsId) {
    const lb = document.getElementById(ownsId);
    if (lb) {
      const opts = readListboxOptions(lb);
      if (opts.length > 0) return opts.slice(0, 500);
    }
  }

  // 4. Sibling listbox in the same form-row container
  let container: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 3 && container; depth++) {
    const lb = container.querySelector<HTMLElement>('[role="listbox"]');
    if (lb && lb !== el && isVisible(lb)) {
      const opts = readListboxOptions(lb);
      if (opts.length > 0) return opts.slice(0, 500);
    }
    container = container.parentElement;
  }

  return undefined;
}

function readListboxOptions(lb: Element): string[] {
  return Array.from(lb.querySelectorAll<HTMLElement>('[role="option"], li[role="option"]'))
    .map(o => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 0 && t.length < 200);
}

/**
 * Scan the page for all visible, interactive form fields.
 * Returns one FieldSignature per field, skipping fields inside iframes
 * (we can't access cross-origin iframes).
 */
export function extractAllFields(root: Document | Element = document): FieldSignature[] {
  const selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"])'
    + ':not([type="reset"]):not([type="image"]):not([type="radio"]):not([type="checkbox"]),'
    + 'textarea,'
    + 'select';
  // Radios and checkboxes are excluded above; both are re-added as grouped
  // fields by extractRadioGroups() / extractCheckboxGroups() — ONE logical
  // field per group (by form+name OR shared container) instead of N.

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
    ...extractRadioGroups(root, seen),
    ...extractCheckboxGroups(root, seen),
  ];
}

/**
 * Group <input type="radio"> elements into ONE logical field per (form, name).
 * Individual radios are excluded from the primary scan; here we emit a single
 * FieldSignature with inputType:'radio-group' and options = the radio labels, so
 * the matcher classifies the group (yes/no, gender, …) via classifyByOptionSet
 * and the radio-group handler fills it by clicking the matching option.
 *
 * `element` is the FIRST radio (the representative); the handler re-derives the
 * full group from it via the shared `name`, so fill/capture see the whole set.
 */
function extractRadioGroups(root: Document | Element, seen: Set<HTMLElement>): FieldSignature[] {
  const radios = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    .filter(r => isVisible(r) && !seen.has(r));

  const groups = new Map<string, HTMLInputElement[]>();
  for (const r of radios) {
    const scopeId = r.form ? (r.form.getAttribute('id') || r.form.getAttribute('name') || 'form') : 'noform';
    const key = `${scopeId}::${r.name || r.id || 'unnamed'}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const sigs: FieldSignature[] = [];
  for (const members of groups.values()) {
    if (members.length === 0) continue;
    members.forEach(m => seen.add(m));
    const rep = members[0];
    const options = members.map(radioOptionLabel).filter(t => t.length > 0);
    const base = extractSignature(rep);
    sigs.push({
      ...base,
      label: radioGroupQuestion(members) || base.label || rep.name || 'Choice',
      inputType: 'radio-group',
      options,
      element: rep,
    });
  }
  return sigs;
}

/**
 * Group <input type="checkbox"> into ONE logical field per group, mirroring
 * extractRadioGroups. Two grouping strategies (in order):
 *
 *   1. Shared `name` (Greenhouse multi-select: `question_<id>[]` on every box)
 *      — strongest signal, used first.
 *   2. Nearest common ancestor (<fieldset>, [role="group"], or container with
 *      ≥2 sibling checkboxes) — catches sets where each box has a unique name.
 *
 * Single ungrouped checkboxes (consent boxes — "I agree to terms") still emit
 * with their own label as the question, so they can be remembered and refilled
 * like any other Q→A asset.
 */
function extractCheckboxGroups(root: Document | Element, seen: Set<HTMLElement>): FieldSignature[] {
  const boxes = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter(b => isVisible(b) && !seen.has(b));

  const groups = new Map<string, HTMLInputElement[]>();

  // Strategy 1: group by (form, name) when name is shared.
  for (const b of boxes) {
    if (!b.name) continue;
    const scopeId = b.form ? (b.form.getAttribute('id') || b.form.getAttribute('name') || 'form') : 'noform';
    const key = `name::${scopeId}::${b.name}`;
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }

  // Strategy 2: any box not yet grouped — group by nearest fieldset / role=group container.
  const namedSet = new Set<HTMLInputElement>();
  for (const arr of groups.values()) for (const b of arr) namedSet.add(b);

  for (const b of boxes) {
    if (namedSet.has(b)) continue;
    const container = b.closest('fieldset, [role="group"]') as HTMLElement | null;
    const key = container ? `container::${container.outerHTML.length}::${(container.getAttribute('id') ?? container.className).slice(0, 40)}::${container.tagName}` : `solo::${b.id || (b.outerHTML?.length ?? 0)}`;
    const arr = groups.get(key) ?? [];
    arr.push(b);
    groups.set(key, arr);
  }

  const sigs: FieldSignature[] = [];
  for (const members of groups.values()) {
    if (members.length === 0) continue;
    members.forEach(m => seen.add(m));
    const rep = members[0];
    const options = members.map(checkboxOptionLabel).filter(t => t.length > 0);
    const base = extractSignature(rep);

    // Label resolution: group question > rep's own label > name fallback.
    // A single checkbox is treated as a consent-style yes/no — keep its own label.
    const groupQ = members.length > 1 ? checkboxGroupQuestion(members) : '';
    const label = groupQ || base.label || checkboxOptionLabel(rep) || rep.name || 'Choice';

    sigs.push({
      ...base,
      label,
      inputType: 'checkbox-group',
      options,
      element: rep,
    });
  }
  return sigs;
}

/** Visible label for one checkbox option (mirrors radioOptionLabel). */
function checkboxOptionLabel(c: HTMLInputElement): string {
  if (c.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(c.id)}"]`);
    const t = lbl?.textContent?.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  const wrap = c.closest('label');
  const wt = wrap?.textContent?.replace(/\s+/g, ' ').trim();
  if (wt) return wt;
  const aria = c.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const sib = c.nextElementSibling as HTMLElement | null;
  const st = sib?.textContent?.replace(/\s+/g, ' ').trim();
  if (st) return st;
  return (c.value || '').trim();
}

/**
 * The group's QUESTION — usually NOT a fieldset/legend (most ATSes don't use
 * those). Walk up looking for: legend, [role="group"][aria-labelledby],
 * aria-label on a group container, or a preceding heading/label sibling text
 * that looks like a question (≥10 chars, not itself an option label).
 */
function checkboxGroupQuestion(members: HTMLInputElement[]): string {
  const rep = members[0];

  const legend = rep.closest('fieldset')?.querySelector('legend')?.textContent?.replace(/\s+/g, ' ').trim();
  if (legend) return legend;

  const groupEl = rep.closest('[role="group"]');
  const labelledby = groupEl?.getAttribute('aria-labelledby');
  if (labelledby) {
    const txt = labelledby.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .join(' ').trim();
    if (txt) return txt;
  }
  const ariaLabel = groupEl?.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  // Walk up the DOM looking for the nearest preceding heading/label-like text
  // that introduces this group. Bounded depth to avoid grabbing page-level text.
  const optionLabels = new Set(members.map(m => checkboxOptionLabel(m).toLowerCase()));
  let cur: HTMLElement | null = rep.parentElement;
  for (let depth = 0; depth < 6 && cur; depth++, cur = cur.parentElement) {
    for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
      const text = (sib.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 10 || text.length > 240) continue;
      if (optionLabels.has(text.toLowerCase())) continue;
      // Prefer label/heading-ish elements but accept any element with a
      // plausible question — Greenhouse uses <label> as the question heading.
      return text;
    }
  }
  return '';
}

/** Visible label for a single radio OPTION (e.g. "Male", "Yes"). */
function radioOptionLabel(r: HTMLInputElement): string {
  if (r.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
    const t = lbl?.textContent?.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  const wrap = r.closest('label');
  const wt = wrap?.textContent?.replace(/\s+/g, ' ').trim();
  if (wt) return wt;
  const aria = r.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const sib = r.nextElementSibling as HTMLElement | null;
  const st = sib?.textContent?.replace(/\s+/g, ' ').trim();
  if (st) return st;
  return (r.value || '').trim();
}

/** The group's QUESTION label (fieldset legend or radiogroup container label). */
function radioGroupQuestion(members: HTMLInputElement[]): string {
  const rep = members[0];
  const legend = rep.closest('fieldset')?.querySelector('legend')?.textContent?.replace(/\s+/g, ' ').trim();
  if (legend) return legend;
  const groupEl = rep.closest('[role="radiogroup"]');
  const labelledby = groupEl?.getAttribute('aria-labelledby');
  if (labelledby) {
    const txt = labelledby.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .join(' ').trim();
    if (txt) return txt;
  }
  const ariaLabel = groupEl?.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;
  return '';
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
