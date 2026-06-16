/**
 * Ghost text preview — light gray text drawn INSIDE matched empty inputs
 * showing what SmartFillAI will fill before the user clicks anything.
 *
 * Why not use the `placeholder` attribute?
 * Many sites style placeholders heavily (or override them). We need a
 * predictable, brand-coloured preview that vanishes the instant the user
 * starts interacting with the field.
 */

interface GhostEntry {
  target: HTMLElement;
  ghost: HTMLElement;
  value: string;
  onFocus:  () => void;
  onInput:  () => void;
}

// Iterable so scroll/resize can reposition every live ghost without
// destroying-and-recreating them (which used to cause flicker and lost ghosts
// when the recreate scan got debounced or cancelled).
const entries = new Set<GhostEntry>();
const byTarget = new WeakMap<HTMLElement, GhostEntry>();

export function showGhost(target: HTMLElement, value: string): void {
  // Don't overlay on fields that already have content or are dropdowns/file inputs.
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (!target.isConnected) return;  // element was replaced by a framework re-render
  if (target.value && target.value.length > 0) return;
  if (target.dataset.dittoFilled === 'true') return;
  if (!value.trim()) return;

  // Guard against elements that have no layout yet (e.g. hidden, not yet mounted).
  // getBoundingClientRect() on a detached/invisible element returns all zeros —
  // a ghost created at (0,0) is invisible and wastes DOM nodes.
  //
  // For React/Next.js hydration races: the field exists in DOM but the page is
  // still laying out. Poll on increasing intervals up to 4 seconds. After that,
  // assume the field is permanently hidden and give up — the next scanFields()
  // call will retry if conditions change.
  let rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    if (target.dataset.dittoGhostPending !== 'true') {
      target.dataset.dittoGhostPending = 'true';
      const start = performance.now();
      const poll = (): void => {
        if (!target.isConnected) {
          delete target.dataset.dittoGhostPending;
          return;
        }
        rect = target.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          delete target.dataset.dittoGhostPending;
          showGhost(target, value);
          return;
        }
        if (performance.now() - start > 4000) {
          delete target.dataset.dittoGhostPending;
          return;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
    return;
  }

  // If a ghost already exists for this element, just refresh text + position.
  const existing = byTarget.get(target);
  if (existing) {
    if (existing.ghost.isConnected) {
      existing.ghost.textContent = truncate(value);
      existing.value = value;
      positionGhost(existing);
      return;
    }
    // Stale entry: ghost was removed from DOM. Clean up and create fresh below.
    cleanupEntry(existing);
  }

  const ghost = document.createElement('div');
  ghost.className = 'smartfillai-ghost';
  ghost.textContent = truncate(value);

  applyGhostStyle(ghost, target, rect);

  document.documentElement.appendChild(ghost);

  const onFocus = (): void => removeGhost(target);
  const onInput = (): void => removeGhost(target);

  target.addEventListener('focus', onFocus, { once: true });
  target.addEventListener('input', onInput, { once: true });

  const entry: GhostEntry = { target, ghost, value, onFocus, onInput };
  entries.add(entry);
  byTarget.set(target, entry);
}

export function removeGhost(target: HTMLElement): void {
  const entry = byTarget.get(target);
  if (!entry) return;
  cleanupEntry(entry);
}

/**
 * Called on scroll/resize. Reposition every live ghost to track its input
 * rather than wiping them — the old wipe-then-rescan approach lost ghosts
 * whenever the rescan got cancelled by ongoing DOM mutations or further scrolls.
 *
 * Also prunes ghosts whose target is no longer in the DOM (framework re-render).
 */
export function repositionAllGhosts(): void {
  for (const entry of entries) {
    if (!entry.target.isConnected || !entry.ghost.isConnected) {
      cleanupEntry(entry);
      continue;
    }
    // If the target has been filled by us or by the user, remove the ghost.
    if (entry.target.dataset.dittoFilled === 'true') {
      cleanupEntry(entry);
      continue;
    }
    const inputValue = (entry.target as HTMLInputElement).value;
    if (inputValue && inputValue.length > 0) {
      cleanupEntry(entry);
      continue;
    }
    positionGhost(entry);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function px(s: string): number {
  const v = parseFloat(s);
  return isFinite(v) ? v : 0;
}

function applyGhostStyle(ghost: HTMLElement, target: HTMLElement, rect: DOMRect): void {
  const style = window.getComputedStyle(target);
  const padTop    = px(style.paddingTop);
  const padLeft   = px(style.paddingLeft);
  const padRight  = px(style.paddingRight);
  const borderTop = px(style.borderTopWidth);
  const borderLeft= px(style.borderLeftWidth);
  // lineHeight can be "normal" — fall back to a sane default tied to font size.
  const lineHeight = style.lineHeight && style.lineHeight !== 'normal'
    ? style.lineHeight
    : `${Math.max(16, px(style.fontSize) * 1.2)}px`;

  Object.assign(ghost.style, {
    position:      'fixed',
    top:           `${rect.top + padTop + borderTop}px`,
    left:          `${rect.left + padLeft + borderLeft}px`,
    width:         `${Math.max(0, rect.width - padLeft - padRight - 8)}px`,
    height:        lineHeight,
    color:         'rgba(99, 102, 241, 0.55)',
    fontFamily:    style.fontFamily || 'inherit',
    fontSize:      style.fontSize   || '14px',
    fontWeight:    style.fontWeight || '400',
    lineHeight:    lineHeight,
    letterSpacing: style.letterSpacing || 'normal',
    pointerEvents: 'none',
    whiteSpace:    'nowrap',
    overflow:      'hidden',
    textOverflow:  'ellipsis',
    zIndex:        '2147483646',
    background:    'transparent',
    display:       'block',
    margin:        '0',
    padding:       '0',
    border:        'none',
    opacity:       '1',
    visibility:    'visible',
  });
}

function positionGhost(entry: GhostEntry): void {
  const rect = entry.target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const style = window.getComputedStyle(entry.target);
  const padTop    = px(style.paddingTop);
  const padLeft   = px(style.paddingLeft);
  const padRight  = px(style.paddingRight);
  const borderTop = px(style.borderTopWidth);
  const borderLeft= px(style.borderLeftWidth);
  entry.ghost.style.top   = `${rect.top + padTop + borderTop}px`;
  entry.ghost.style.left  = `${rect.left + padLeft + borderLeft}px`;
  entry.ghost.style.width = `${Math.max(0, rect.width - padLeft - padRight - 8)}px`;
}

function cleanupEntry(entry: GhostEntry): void {
  entry.ghost.remove();
  entry.target.removeEventListener('focus', entry.onFocus);
  entry.target.removeEventListener('input', entry.onInput);
  entries.delete(entry);
  byTarget.delete(entry.target);
}

function truncate(s: string): string {
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}
