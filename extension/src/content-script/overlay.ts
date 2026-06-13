/**
 * Floating pill overlay — appears near matched fields to indicate Ditto
 * can fill them and provides a click-to-fill shortcut.
 *
 * Uses Shadow DOM so the pill's styles never bleed into or conflict with
 * the host page's CSS.
 */

import type { MatchResult, ProfileEntry } from '@shared/types';

interface PillTarget {
  el: HTMLElement;
  entry: ProfileEntry;
  result: MatchResult;
}

// ── Shadow host + pill element ────────────────────────────────────────────────

const HOST_ID = 'ditto-overlay-host';
let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let pillEl: HTMLElement | null = null;

function ensureHost(): ShadowRoot {
  if (shadow) return shadow;

  host = document.createElement('div');
  host.id = HOST_ID;
  // The host itself has no layout impact — zero size, fixed position
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
  });

  shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .pill {
      position: fixed;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px 4px 8px;
      background: #4f46e5;
      color: #fff;
      border-radius: 20px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(79,70,229,0.4);
      pointer-events: all;
      user-select: none;
      transition: background 0.15s, transform 0.1s;
      opacity: 0;
      transform: scale(0.9);
      animation: fadein 0.15s ease forwards;
    }
    .pill:hover  { background: #4338ca; transform: scale(1.02); }
    .pill:active { background: #3730a3; }
    .pill.essay  { background: #059669; box-shadow: 0 2px 8px rgba(5,150,105,0.4); }
    .pill.essay:hover { background: #047857; }
    .pill .icon  { font-size: 14px; line-height: 1; }
    .pill .label { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .pill .value { opacity: 0.75; max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
    .pill .sep   { opacity: 0.4; }
    @keyframes fadein {
      to { opacity: 1; transform: scale(1); }
    }
  `;
  shadow.appendChild(style);

  document.documentElement.appendChild(host);
  return shadow;
}

// ── Public API ────────────────────────────────────────────────────────────────

type FillCallback = (target: PillTarget) => void;

let _fillCallback: FillCallback | null = null;
let _hideTimer: ReturnType<typeof setTimeout> | undefined;
let _currentTarget: PillTarget | null = null;

export function initOverlay(onFill: FillCallback): void {
  _fillCallback = onFill;
}

export function showPill(target: PillTarget): void {
  _currentTarget = target;
  clearTimeout(_hideTimer);

  const sh = ensureHost();

  if (!pillEl) {
    pillEl = document.createElement('div');
    pillEl.className = 'pill';
    pillEl.addEventListener('mouseenter', () => clearTimeout(_hideTimer));
    pillEl.addEventListener('mouseleave', () => schedulePillHide(200));
    pillEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (_fillCallback && _currentTarget) {
        _fillCallback(_currentTarget);
        hidePill();
      }
    });
    sh.appendChild(pillEl);
  }

  // Rebuild content
  const isEssay = target.result.status === 'ESSAY';
  pillEl.className = isEssay ? 'pill essay' : 'pill';

  if (isEssay) {
    pillEl.innerHTML = `
      <span class="icon">✍️</span>
      <span class="label">Generate essay</span>
    `;
  } else {
    const label = target.entry.display_label;
    const value = target.entry.sensitive ? '••••' : truncate(target.entry.value, 12);
    pillEl.innerHTML = `
      <span class="icon">⚡</span>
      <span class="label">${escapeHtml(label)}</span>
      <span class="sep">·</span>
      <span class="value">${escapeHtml(value)}</span>
    `;
  }

  // Position pill above the field
  positionPill(target.el);
}

export function hidePill(): void {
  if (pillEl) {
    pillEl.remove();
    pillEl = null;
  }
  _currentTarget = null;
}

export function schedulePillHide(delayMs = 400): void {
  clearTimeout(_hideTimer);
  _hideTimer = setTimeout(hidePill, delayMs);
}

// ── Positioning ───────────────────────────────────────────────────────────────

function positionPill(fieldEl: HTMLElement): void {
  if (!pillEl) return;

  const rect = fieldEl.getBoundingClientRect();
  const pillHeight = 26; // approximate pill height
  const MARGIN = 6;

  let top = rect.top - pillHeight - MARGIN + window.scrollY;
  let left = rect.right - 4 + window.scrollX; // right-aligned to field

  // Clamp to viewport
  const vw = document.documentElement.clientWidth;
  const pillWidth = 200; // approximate max width
  if (left + pillWidth > vw) left = vw - pillWidth - 8;
  if (top < 0) top = rect.bottom + MARGIN + window.scrollY;

  Object.assign(pillEl.style, {
    top:  `${rect.top - pillHeight - MARGIN}px`,
    left: `${Math.max(8, rect.right - pillWidth)}px`,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
