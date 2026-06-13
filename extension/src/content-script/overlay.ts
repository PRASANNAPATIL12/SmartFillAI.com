/**
 * Floating overlay for Ditto — renders inside Shadow DOM to avoid page CSS conflicts.
 * Contains:
 *  - Fill pill (indigo) — hover-triggered, click fills the matched field
 *  - Learn pill (amber) — blur-triggered, click saves a new profile entry
 *  - Essay panel (modal) — triggered by essay pill click, generates AI response
 */

import type { MatchResult, ProfileEntry } from '@shared/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PillTarget {
  el:       HTMLElement;
  entry?:   ProfileEntry;  // undefined for ESSAY type
  result:   MatchResult;
  question?: string;       // essay question text (ESSAY type only)
}

export interface LearnTarget {
  el:    HTMLElement;
  label: string;
  value: string;
}

export interface EssayTarget {
  el:         HTMLElement;
  question:   string;
  onGenerate: () => Promise<string>;
}

// ── Shadow host ───────────────────────────────────────────────────────────────

const HOST_ID = 'ditto-overlay-host';
let host:   HTMLElement | null = null;
let shadow: ShadowRoot  | null = null;
let pillEl: HTMLElement | null = null;

function ensureHost(): ShadowRoot {
  if (shadow) return shadow;

  host = document.createElement('div');
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: 'fixed',
    top: '0', left: '0',
    width: '0', height: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
  });

  shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    /* ── Pill ── */
    .pill {
      position: fixed;
      display: flex; align-items: center; gap: 6px;
      padding: 4px 10px 4px 8px;
      background: #4f46e5; color: #fff;
      border-radius: 20px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px; font-weight: 500; line-height: 1;
      white-space: nowrap; cursor: pointer;
      box-shadow: 0 2px 8px rgba(79,70,229,0.4);
      pointer-events: all; user-select: none;
      transition: background 0.15s, transform 0.1s;
      opacity: 0; transform: scale(0.9);
      animation: fadein 0.15s ease forwards;
    }
    .pill:hover  { background: #4338ca; transform: scale(1.02); }
    .pill:active { background: #3730a3; }
    .pill.essay  { background: #059669; box-shadow: 0 2px 8px rgba(5,150,105,0.4); }
    .pill.essay:hover { background: #047857; }
    .pill.learn  { background: #d97706; box-shadow: 0 2px 8px rgba(217,119,6,0.4); }
    .pill.learn:hover { background: #b45309; }
    .pill .icon  { font-size: 14px; line-height: 1; }
    .pill .label { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .pill .value { opacity: 0.75; max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
    .pill .sep   { opacity: 0.4; }
    @keyframes fadein { to { opacity: 1; transform: scale(1); } }

    /* ── Essay backdrop + panel ── */
    .essay-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.25);
      pointer-events: all; z-index: 0;
    }
    .essay-panel {
      position: fixed;
      top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 360px; max-width: calc(100vw - 32px);
      background: #fff; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.18);
      font-family: system-ui, -apple-system, sans-serif;
      pointer-events: all; overflow: hidden;
      z-index: 1;
      animation: fadein 0.15s ease forwards;
    }
    .ep-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px 8px;
      border-bottom: 1px solid #f1f5f9;
    }
    .ep-title { font-size: 13px; font-weight: 600; color: #1e293b; }
    .ep-close {
      background: none; border: none; cursor: pointer;
      font-size: 18px; color: #94a3b8; padding: 0; line-height: 1;
    }
    .ep-close:hover { color: #64748b; }
    .ep-question {
      margin: 10px 16px;
      font-size: 12px; color: #475569; line-height: 1.5;
      max-height: 60px; overflow-y: auto;
      background: #f8fafc; border-radius: 8px; padding: 8px 10px;
    }
    .ep-body { padding: 0 16px 16px; }
    .ep-textarea {
      width: 100%; min-height: 120px; resize: vertical;
      font-size: 12px; line-height: 1.6; color: #334155;
      border: 1px solid #e2e8f0; border-radius: 8px;
      padding: 8px 10px; box-sizing: border-box;
      font-family: inherit; outline: none;
    }
    .ep-textarea:focus { border-color: #6366f1; }
    .ep-actions {
      display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end;
    }
    .ep-btn {
      padding: 6px 14px; border-radius: 8px; font-size: 12px;
      font-weight: 500; cursor: pointer; border: none;
      transition: background 0.15s;
    }
    .ep-btn-primary   { background: #4f46e5; color: #fff; }
    .ep-btn-primary:hover { background: #4338ca; }
    .ep-btn-secondary { background: #f1f5f9; color: #475569; }
    .ep-btn-secondary:hover { background: #e2e8f0; }
    .ep-btn:disabled  { opacity: 0.5; cursor: not-allowed; }
    .ep-spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid rgba(255,255,255,0.5);
      border-top-color: #fff; border-radius: 50%;
      animation: spin 0.7s linear infinite; vertical-align: middle; margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ep-error { font-size: 11px; color: #ef4444; margin-top: 8px; }
  `;
  shadow.appendChild(style);
  document.documentElement.appendChild(host);
  return shadow;
}

// ── Pill infrastructure ───────────────────────────────────────────────────────

function ensurePill(sh: ShadowRoot): HTMLElement {
  if (pillEl) return pillEl;
  pillEl = document.createElement('div');
  pillEl.className = 'pill';
  pillEl.addEventListener('mouseenter', () => clearTimeout(_hideTimer));
  pillEl.addEventListener('mouseleave', () => schedulePillHide(200));
  pillEl.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    _activePillCallback?.();
    hidePill();
  });
  sh.appendChild(pillEl);
  return pillEl;
}

// ── State ─────────────────────────────────────────────────────────────────────

type FillCallback  = (target: PillTarget) => void;
type LearnCallback = (target: LearnTarget) => void;
type EssayCallback = (target: EssayTarget) => void;

let _fillCallback:  FillCallback  | null = null;
let _learnCallback: LearnCallback | null = null;
let _essayCallback: EssayCallback | null = null;
let _hideTimer: ReturnType<typeof setTimeout> | undefined;
let _currentTarget: PillTarget | null = null;
let _activePillCallback: (() => void) | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export function initOverlay(onFill: FillCallback): void {
  _fillCallback = onFill;
}

export function initLearnOverlay(onLearn: LearnCallback): void {
  _learnCallback = onLearn;
}

export function initEssayOverlay(onEssay: EssayCallback): void {
  _essayCallback = onEssay;
}

// ── Fill pill ─────────────────────────────────────────────────────────────────

export function showPill(target: PillTarget): void {
  _currentTarget = target;
  clearTimeout(_hideTimer);

  const sh  = ensureHost();
  const pel = ensurePill(sh);

  const isEssay = target.result.status === 'ESSAY';

  if (isEssay) {
    _activePillCallback = () => {
      if (_essayCallback && _currentTarget) {
        const q = _currentTarget.question ?? 'Essay question';
        // Essay panel is opened from content-script, not fill
        _essayCallback({
          el:         _currentTarget.el,
          question:   q,
          onGenerate: () => Promise.resolve(''), // will be replaced by actual impl
        });
      }
    };
    pel.className = 'pill essay';
    pel.innerHTML = `<span class="icon">✍️</span><span class="label">Generate essay</span>`;
  } else {
    _activePillCallback = () => _fillCallback?.(_currentTarget!);
    pel.className = 'pill';
    const label = target.entry?.display_label ?? '';
    const value = target.entry?.sensitive ? '••••' : truncate(target.entry?.value ?? '', 12);
    pel.innerHTML = `
      <span class="icon">⚡</span>
      <span class="label">${escapeHtml(label)}</span>
      <span class="sep">·</span>
      <span class="value">${escapeHtml(value)}</span>
    `;
  }

  positionPill(target.el);
}

export function hidePill(): void {
  if (pillEl) { pillEl.remove(); pillEl = null; }
  _currentTarget = null;
  _activePillCallback = null;
}

export function schedulePillHide(delayMs = 400): void {
  clearTimeout(_hideTimer);
  _hideTimer = setTimeout(hidePill, delayMs);
}

// ── Learn pill ────────────────────────────────────────────────────────────────

export function showLearnPill(target: LearnTarget): void {
  _currentTarget = null;
  clearTimeout(_hideTimer);

  const sh  = ensureHost();
  const pel = ensurePill(sh);

  _activePillCallback = () => _learnCallback?.(target);

  pel.className = 'pill learn';
  pel.innerHTML = `
    <span class="icon">💡</span>
    <span class="label">Save ${escapeHtml(truncate(target.label, 20))}?</span>
    <span class="sep">·</span>
    <span class="value">${escapeHtml(truncate(target.value, 12))}</span>
  `;

  positionPill(target.el);
  _hideTimer = setTimeout(hidePill, 5000);
}

// ── Essay panel ───────────────────────────────────────────────────────────────

export function showEssayPanel(target: EssayTarget): void {
  const sh = ensureHost();
  hideEssayPanel(); // remove any existing panel

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'ditto-essay-backdrop';
  backdrop.className = 'essay-backdrop';
  backdrop.addEventListener('click', hideEssayPanel);
  sh.appendChild(backdrop);

  // Panel
  const panel = document.createElement('div');
  panel.id = 'ditto-essay-panel';
  panel.className = 'essay-panel';
  sh.appendChild(panel);

  renderEssayIdle(panel, target);
}

export function hideEssayPanel(): void {
  const sh = shadow;
  if (!sh) return;
  sh.getElementById('ditto-essay-backdrop')?.remove();
  sh.getElementById('ditto-essay-panel')?.remove();
}

// ── Essay panel states ────────────────────────────────────────────────────────

function renderEssayIdle(panel: HTMLElement, target: EssayTarget): void {
  const shortQ = target.question.length > 160
    ? target.question.slice(0, 160) + '…'
    : target.question;

  panel.innerHTML = `
    <div class="ep-header">
      <span class="ep-title">Generate Essay</span>
      <button class="ep-close" id="ep-close">×</button>
    </div>
    <div class="ep-question">${escapeHtml(shortQ)}</div>
    <div class="ep-body">
      <div class="ep-actions">
        <button class="ep-btn ep-btn-secondary" id="ep-cancel">Cancel</button>
        <button class="ep-btn ep-btn-primary" id="ep-generate">Generate with AI</button>
      </div>
    </div>
  `;

  panel.querySelector('#ep-close')?.addEventListener('click',   hideEssayPanel);
  panel.querySelector('#ep-cancel')?.addEventListener('click',  hideEssayPanel);
  panel.querySelector('#ep-generate')?.addEventListener('click', () => {
    renderEssayGenerating(panel);
    target.onGenerate()
      .then(text  => renderEssayDone(panel, target, text))
      .catch(err  => renderEssayError(panel, target,
        err instanceof Error ? err.message : 'Generation failed. Try again.'));
  });
}

function renderEssayGenerating(panel: HTMLElement): void {
  const shortQ = panel.querySelector('.ep-question')?.textContent ?? '';
  panel.innerHTML = `
    <div class="ep-header">
      <span class="ep-title">Generate Essay</span>
    </div>
    <div class="ep-question">${escapeHtml(shortQ)}</div>
    <div class="ep-body">
      <div class="ep-actions">
        <button class="ep-btn ep-btn-primary" disabled>
          <span class="ep-spinner"></span>Generating…
        </button>
      </div>
    </div>
  `;
}

function renderEssayDone(panel: HTMLElement, target: EssayTarget, text: string): void {
  const shortQ = target.question.length > 160
    ? target.question.slice(0, 160) + '…'
    : target.question;

  panel.innerHTML = `
    <div class="ep-header">
      <span class="ep-title">Essay Generated</span>
      <button class="ep-close" id="ep-close">×</button>
    </div>
    <div class="ep-question">${escapeHtml(shortQ)}</div>
    <div class="ep-body">
      <textarea class="ep-textarea" id="ep-text">${escapeHtml(text)}</textarea>
      <div class="ep-actions">
        <button class="ep-btn ep-btn-secondary" id="ep-regen">Regenerate</button>
        <button class="ep-btn ep-btn-primary"   id="ep-insert">Insert</button>
      </div>
    </div>
  `;

  panel.querySelector('#ep-close')?.addEventListener('click', hideEssayPanel);
  panel.querySelector('#ep-regen')?.addEventListener('click', () => {
    renderEssayGenerating(panel);
    target.onGenerate()
      .then(t   => renderEssayDone(panel, target, t))
      .catch(e  => renderEssayError(panel, target,
        e instanceof Error ? e.message : 'Generation failed.'));
  });
  panel.querySelector('#ep-insert')?.addEventListener('click', () => {
    const ta = panel.querySelector<HTMLTextAreaElement>('#ep-text');
    const finalText = ta?.value ?? text;
    // Use native setter to work with React/Vue controlled inputs
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(target.el, finalText);
    } else {
      (target.el as HTMLTextAreaElement).value = finalText;
    }
    target.el.dispatchEvent(new Event('input',  { bubbles: true }));
    target.el.dispatchEvent(new Event('change', { bubbles: true }));
    (target.el as HTMLElement).dataset.dittoFilled = 'true';
    hideEssayPanel();
  });
}

function renderEssayError(panel: HTMLElement, target: EssayTarget, msg: string): void {
  panel.innerHTML = `
    <div class="ep-header">
      <span class="ep-title">Generate Essay</span>
      <button class="ep-close" id="ep-close">×</button>
    </div>
    <div class="ep-body">
      <p class="ep-error">${escapeHtml(msg)}</p>
      <div class="ep-actions">
        <button class="ep-btn ep-btn-secondary" id="ep-cancel">Cancel</button>
        <button class="ep-btn ep-btn-primary"   id="ep-retry">Try Again</button>
      </div>
    </div>
  `;

  panel.querySelector('#ep-close')?.addEventListener('click',  hideEssayPanel);
  panel.querySelector('#ep-cancel')?.addEventListener('click', hideEssayPanel);
  panel.querySelector('#ep-retry')?.addEventListener('click',  () => {
    renderEssayGenerating(panel);
    target.onGenerate()
      .then(t  => renderEssayDone(panel, target, t))
      .catch(e => renderEssayError(panel, target,
        e instanceof Error ? e.message : 'Generation failed.'));
  });
}

// ── Pill positioning ──────────────────────────────────────────────────────────

function positionPill(fieldEl: HTMLElement): void {
  if (!pillEl) return;
  const rect = fieldEl.getBoundingClientRect();
  const pillHeight = 26;
  const MARGIN = 6;
  const pillWidth = 200;
  const vw = document.documentElement.clientWidth;

  Object.assign(pillEl.style, {
    top:  `${rect.top - pillHeight - MARGIN}px`,
    left: `${Math.max(8, Math.min(rect.right - pillWidth, vw - pillWidth - 8))}px`,
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
