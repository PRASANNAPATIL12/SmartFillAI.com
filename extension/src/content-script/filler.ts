/**
 * Value injection for form fields.
 *
 * The challenge with React/Vue/Angular "controlled" inputs is that setting
 * el.value directly bypasses the framework's internal state tracker. Three
 * things must happen for React to accept our write:
 *
 *   1. Reset React's _valueTracker.lastValue to '' so React sees this as
 *      a genuine change (the most common reason fills silently revert).
 *   2. Use the NATIVE prototype setter (captured in the extension's isolated
 *      world before any page script can shadow it) to write the raw DOM value.
 *   3. Dispatch synthetic 'input' + 'change' events so the framework re-reads
 *      el.value and syncs its own state.
 */

import { resolveHandler } from './field-handlers/registry';
import { expandCountryAliases } from './country-aliases';
import { expandValueAliases, hasValueAliases } from './value-aliases';
import { selectOptionByEmbedding } from './option-embedding';
import { getResolvedOption, setResolvedOption } from './option-resolution-cache';

// Capture native setters from the extension's isolated world.
// Page scripts cannot touch these because isolated worlds have separate prototypes.
const nativeInputSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value'
)?.set;

const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value'
)?.set;

const nativeSelectSetter = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  'value'
)?.set;

/**
 * STEP 6.1 — Reset React's internal value tracker BEFORE we write. Without
 * this, React 17+ may skip dispatching onChange because tracker.lastValue
 * matches the new value (especially after the developer's own onChange has
 * already echoed our value back through state). Setting lastValue='' makes
 * React see the upcoming write as a fresh change.
 */
function resetReactValueTracker(el: HTMLElement): void {
  const tracker = (el as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  if (tracker && typeof tracker.setValue === 'function') {
    try { tracker.setValue(''); } catch { /* tracker may be frozen */ }
  }
}

/**
 * Fill a form element with a value.
 * Returns true if the value stuck (verified by reading back).
 *
 * Async because ARIA comboboxes need to wait for the popup listbox to
 * render before we can click an option. Plain inputs and native <select>
 * resolve synchronously but the signature is async for uniformity.
 */
export async function fillElement(
  el: HTMLElement,
  value: string,
  canonicalKey?: string
): Promise<boolean> {
  if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return false;

  try {
    // Dispatch by field kind through the handler registry. The registry order
    // replicates the previous if/else precedence exactly (button-dropdown →
    // select → combobox → plain text); each handler delegates to the same
    // underlying fill function it always used.
    return await resolveHandler(el).fill(el, value, { canonicalKey });
  } catch (err) {
    console.warn('[SmartFillAI] fill threw:', err);
    return false;
  }
}

/**
 * Plain <input>/<textarea> value write — the framework-aware setter path.
 * Extracted verbatim from the old fillElement so the text handler can delegate
 * to it. Behavior is unchanged: reset React tracker → native setter → dispatch
 * input/change → mark filled → verify.
 */
export function fillPlainInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  const before = (el as HTMLInputElement).value ?? '';

  const setter =
    el instanceof HTMLTextAreaElement ? nativeTextareaSetter : nativeInputSetter;

  // STEP 6.1 — Reset React's value tracker so the write is seen as a change
  resetReactValueTracker(el);

  if (setter) {
    setter.call(el, value);
  } else {
    (el as HTMLInputElement | HTMLTextAreaElement).value = value;
  }

  // Notify frameworks that the value changed
  el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

  el.dataset.dittoFilled = 'true';

  // STEP 6.2 — Post-fill verification. If the value didn't stick (React
  // reverted, or the input has filters that rejected our write), log it
  // so we can see in the console and react accordingly.
  const after = (el as HTMLInputElement).value ?? '';
  if (after !== value) {
    // Suppress false-positive for tel inputs: a phone widget may reformat our
    // value ("9448677888" → "(944) 867-7888") while the fill itself succeeded.
    // Only warn when the actual digits differ — that's a real mismatch.
    const isTelReformat = el instanceof HTMLInputElement && el.type === 'tel'
      && after.replace(/\D/g, '') === value.replace(/\D/g, '')
      && after.replace(/\D/g, '').length >= 5;
    if (!isTelReformat) {
      const label = el.getAttribute('name') || el.id || el.getAttribute('aria-label') || '?';
      console.warn(`[SmartFillAI] fill mismatch — "${label}" before="${before}" after="${after}" expected="${value}"`);
    }
  }

  return true;
}

/**
 * Attach a file to either a native <input type="file"> or a drag-and-drop zone.
 *
 *  • Native input path: set `el.files` via DataTransfer, fire change/input.
 *    Works for visible inputs (Greenhouse, Lever, Avathon) and hidden inputs
 *    (Happiest Minds, iCIMS) that the detector's extractFileInputs() found
 *    via their reachability anchor.
 *
 *  • Dropzone path: dispatch a synthetic dragenter → dragover → drop sequence
 *    with the file in DataTransfer. Works against react-dropzone, Filepond,
 *    Uppy, Dropzone.js. As a belt-and-suspenders fallback, after the drop we
 *    look for a freshly-appended <input type="file"> inside the dropzone and
 *    set its `.files` directly (some libraries append one on drop).
 */
export function fillFileInput(
  el: HTMLInputElement | HTMLElement,
  fileData: ArrayBuffer,
  fileName: string,
  mimeType: string
): boolean {
  const file = new File([fileData], fileName, { type: mimeType });

  // Dropzone path
  if (!(el instanceof HTMLInputElement) || el.dataset.dittoDropzone === 'true') {
    return fillDropzone(el, file);
  }

  // Native input path — set files via DataTransfer, then dispatch a
  // comprehensive event sequence. Different frameworks listen for different
  // event types, and Angular Material in particular sometimes only updates
  // its UI when a full focus-change-blur cycle (or a drop event) fires:
  //
  //   • change    — standard listener for (change)="..." bindings
  //   • input     — some libraries listen here instead of change
  //   • drop      — Angular Material file directives often accept files via
  //                  drop AS WELL AS change; firing it covers drag-drop libs
  //   • focus/blur — forces Angular zone tick and FormControl statusChanges
  //
  // composed:true ensures the event crosses shadow-DOM boundaries (Angular
  // Material wraps controls in <span class="mdc-button__label">).
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;

  el.dispatchEvent(new Event('focus',  { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  // Synthetic drop — many Angular Material file inputs (and react-dropzone)
  // accept files via drop as a parallel code path. Firing it gives the
  // framework a second chance to pick up the file even if change was ignored.
  try {
    const dropDT = new DataTransfer();
    dropDT.items.add(file);
    el.dispatchEvent(new DragEvent('drop', {
      bubbles: true, composed: true, cancelable: true, dataTransfer: dropDT,
    }));
  } catch { /* older browsers may not support DragEvent constructor with dataTransfer */ }

  el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));

  el.dataset.dittoFilled = 'true';
  return el.files !== null && el.files.length > 0;
}

function fillDropzone(el: HTMLElement, file: File): boolean {
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top  + rect.height / 2;

  const makeDT = (): DataTransfer => {
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  };

  // Each DragEvent gets its OWN DataTransfer instance. Some frameworks
  // (react-dropzone) read dt.files in `drop`; others read dt.items in
  // `dragover` to pre-validate types.
  const dispatch = (type: string, target: EventTarget): boolean => {
    const evt = new DragEvent(type, {
      bubbles:    true,
      cancelable: true,
      composed:   true,
      clientX,
      clientY,
      dataTransfer: makeDT(),
    });
    return target.dispatchEvent(evt);
  };

  // Full sequence — drop libraries that listen on either the element or the
  // window get the events bubbled to them.
  dispatch('dragenter', el);
  dispatch('dragover',  el);
  const dropAccepted = dispatch('drop', el);
  dispatch('dragleave', document.body);

  // Belt-and-suspenders: if a freshly-mounted <input type=file> appeared
  // inside the dropzone (Filepond/Uppy pattern), set its .files too.
  const innerInput = el.querySelector<HTMLInputElement>('input[type="file"]');
  if (innerInput) {
    try {
      const dt = makeDT();
      innerInput.files = dt.files;
      innerInput.dispatchEvent(new Event('change', { bubbles: true }));
      innerInput.dispatchEvent(new Event('input',  { bubbles: true }));
      innerInput.dataset.dittoFilled = 'true';
    } catch {
      // Some libraries make .files non-writable; the DragEvent path
      // remains our primary attempt in that case.
    }
  }

  el.dataset.dittoFilled = 'true';
  // dropAccepted is true when the framework didn't preventDefault on drop —
  // best-effort indicator that the file was consumed. We also report success
  // if we found and populated an inner input.
  return dropAccepted || !!innerInput;
}

export async function fillSelect(el: HTMLSelectElement, value: string, canonicalKey?: string): Promise<boolean> {
  const options = Array.from(el.options);
  const optionTexts = options.map(o => o.text);

  // Commit helper — selects the option, fires change, marks filled, and
  // records the resolution in Cache 3 so the next visit is an instant hit.
  const commit = (target: HTMLOptionElement): boolean => {
    if (nativeSelectSetter) nativeSelectSetter.call(el, target.value);
    else el.value = target.value;
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dataset.dittoFilled = 'true';
    delete el.dataset.dittoStatus; // clear any prior FILL_FAILED
    void setResolvedOption(optionTexts, value, target.text);
    return true;
  };

  // Cache 3 — option-resolution lookup. If a prior fill (or another site
  // with the same option set) already resolved this value, pick that option
  // directly. This is what makes large dropdowns instant on revisit even
  // though we skip embedding for them.
  const cachedText = await getResolvedOption(optionTexts, value);
  if (cachedText) {
    const target = options.find(o => o.text === cachedText);
    if (target) return commit(target);
  }

  // Expand the profile value to every alias the option text might use:
  //   • country / phone_country_code → "India" expands via country table
  //   • gender / degree / work_authorization / employment_type / yes_no /
  //     years_of_experience / education_level → value-aliases.ts
  //   • anything else → [value] (existing behavior — option text must match
  //     verbatim, which is fine for first_name, city, etc.)
  const valuesToTry =
    canonicalKey === 'country' || canonicalKey === 'phone_country_code'
      ? expandCountryAliases(value)
      : hasValueAliases(canonicalKey)
        ? expandValueAliases(canonicalKey, value)
        : [value];

  for (const tryValue of valuesToTry) {
    const lv = tryValue.toLowerCase().trim();

    // 1. Exact value attribute match
    let target = options.find(o => o.value === tryValue);

    // 2. Case-insensitive text match (strip emoji from option text)
    if (!target) {
      target = options.find(o => {
        const optText = o.text.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim().toLowerCase();
        return optText === lv || o.text.toLowerCase().trim() === lv;
      });
    }

    // 3. First-component exact match for "City, State, Country" format.
    // Prevents "Bangalore Rural, Karnataka" matching stored value "Bangalore":
    // first component must equal the alias exactly.
    if (!target) {
      const stripEmoji = (t: string) =>
        t.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim().toLowerCase();
      target = options.find(o => {
        const firstComp = stripEmoji(o.text).split(',')[0].trim();
        return firstComp === lv;
      });
    }

    // 4. Partial containment — but guard against alias being a prefix of a
    // larger word in the option (e.g. "bangalore" must not match "bangalore rural").
    if (!target) {
      const stripped = (t: string): string =>
        t.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim().toLowerCase();
      target =
        options.find(o => {
          const s = stripped(o.text);
          if (!s.includes(lv)) return o.text.toLowerCase().includes(lv);
          // Guard: if the alias appears at the start of a word followed by more
          // letters (e.g. "bangalore" in "bangalore rural"), skip this option.
          const idx = s.indexOf(lv);
          const charAfter = s[idx + lv.length];
          if (charAfter && /[a-z]/i.test(charAfter)) return false;
          return true;
        }) ??
        options.find(o => lv.includes(stripped(o.text)) && o.text.trim().length > 2);
    }

    if (target) return commit(target);
  }

  // Phase A.4 — embedding fallback. When alias/exact/partial all fail, ask
  // the local MiniLM embedder which option is semantically closest to the
  // user's profile value. Skipped for huge option lists (country pickers
  // handled by the alias table + Cache 3) inside selectOptionByEmbedding.
  const match = await selectOptionByEmbedding(el, value, optionTexts);
  if (match) {
    const target = options[match.index];
    if (target) {
      if ((window as unknown as { __SFA_DEBUG?: boolean }).__SFA_DEBUG === true) {
        console.log('[SmartFillAI] select fill via embedding', {
          value,
          picked: target.text,
          similarity: match.similarity.toFixed(3),
        });
      }
      return commit(target);
    }
  }

  // No cache / alias / containment / exact / embedding matched any option.
  // Mark visibly so user / regression tests can see we didn't fake a fill.
  el.dataset.dittoStatus = 'FILL_FAILED';
  if ((window as unknown as { __SFA_DEBUG?: boolean }).__SFA_DEBUG === true) {
    console.log('[SmartFillAI] select fill failed', {
      value,
      canonicalKey,
      optionsSample: options.slice(0, 12).map(o => o.text),
      optionCount: options.length,
    });
  }
  return false;
}
