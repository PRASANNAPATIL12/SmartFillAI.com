/**
 * Ghost text preview — light gray text drawn INSIDE matched empty inputs
 * showing what SmartFillAI will fill before the user clicks anything.
 *
 * Why not use the `placeholder` attribute?
 * Many sites style placeholders heavily (or override them). We need a
 * predictable, brand-coloured preview that vanishes the instant the user
 * starts interacting with the field.
 */

interface GhostState {
  ghost: HTMLElement;
  onFocus:  () => void;
  onInput:  () => void;
}

const ghosts = new WeakMap<HTMLElement, GhostState>();

export function showGhost(target: HTMLElement, value: string): void {
  // Don't overlay on fields that already have content or are dropdowns/file inputs.
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.value && target.value.length > 0) return;
  if (target.dataset.dittoFilled === 'true') return;
  if (!value.trim()) return;

  // If a ghost already exists for this element, refresh its text.
  const existing = ghosts.get(target);
  if (existing) {
    existing.ghost.textContent = truncate(value);
    return;
  }

  const ghost = document.createElement('div');
  ghost.className = 'smartfillai-ghost';
  ghost.textContent = truncate(value);

  const style = window.getComputedStyle(target);
  const rect  = target.getBoundingClientRect();

  Object.assign(ghost.style, {
    position:    'fixed',
    top:         `${rect.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth)}px`,
    left:        `${rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)}px`,
    width:       `${rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8}px`,
    height:      style.lineHeight,
    color:       'rgba(99, 102, 241, 0.55)',
    fontFamily:  style.fontFamily,
    fontSize:    style.fontSize,
    fontWeight:  style.fontWeight,
    lineHeight:  style.lineHeight,
    letterSpacing: style.letterSpacing,
    pointerEvents: 'none',
    whiteSpace:  'nowrap',
    overflow:    'hidden',
    textOverflow:'ellipsis',
    zIndex:      '2147483646',
    background:  'transparent',
  });

  document.documentElement.appendChild(ghost);

  const onFocus = (): void => removeGhost(target);
  const onInput = (): void => removeGhost(target);

  target.addEventListener('focus', onFocus, { once: true });
  target.addEventListener('input', onInput, { once: true });

  ghosts.set(target, { ghost, onFocus, onInput });
}

export function removeGhost(target: HTMLElement): void {
  const state = ghosts.get(target);
  if (!state) return;
  state.ghost.remove();
  target.removeEventListener('focus', state.onFocus);
  target.removeEventListener('input', state.onInput);
  ghosts.delete(target);
}

export function repositionAllGhosts(): void {
  // Called on scroll/resize. We can't iterate WeakMap, so this is a
  // best-effort: any element no longer connected gets its ghost removed.
  document.querySelectorAll('.smartfillai-ghost').forEach(g => g.remove());
}

function truncate(s: string): string {
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}
