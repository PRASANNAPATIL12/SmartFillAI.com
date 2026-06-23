/**
 * Floating overlay for Ditto — renders inside Shadow DOM to avoid page CSS conflicts.
 * Contains:
 *  - Fill pill (indigo) — hover-triggered, click fills the matched field
 *  - Learn pill (amber) — blur-triggered, click saves a new profile entry
 *  - Essay panel (modal) — triggered by essay pill click, generates AI response
 */

import type { MatchResult, ProfileEntry, FillAction } from '@shared/types';

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

const HOST_ID = 'smartfillai-overlay-host';
let host:   HTMLElement | null = null;
let shadow: ShadowRoot  | null = null;
let pillEl: HTMLElement | null = null;

/** Exported so the banner module can render into the same Shadow DOM. */
export function getOverlayShadow(): ShadowRoot {
  return ensureHost();
}

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

    /* ── Proactive page banner ── */
    .sfa-banner {
      position: fixed;
      top: 16px; right: 16px;
      min-width: 280px; max-width: 360px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-left: 4px solid #6366f1;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
      padding: 12px 14px;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      pointer-events: all;
      opacity: 0; transform: translateX(20px);
      animation: sfa-slide-in 0.28s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      z-index: 2;
    }
    .sfa-banner.success { border-left-color: #10b981; }
    .sfa-banner.empty   { border-left-color: #94a3b8; }
    @keyframes sfa-slide-in {
      to { opacity: 1; transform: translateX(0); }
    }
    .sfa-banner-header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 6px;
    }
    .sfa-banner-brand {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 600;
      letter-spacing: 0.02em;
      color: #6366f1;
      text-transform: uppercase;
    }
    .sfa-banner-brand::before {
      content: '✨'; font-size: 12px;
    }
    .sfa-banner-spacer { flex: 1; }
    .sfa-banner-close {
      background: none; border: none; cursor: pointer;
      font-size: 16px; color: #94a3b8; padding: 0;
      line-height: 1; width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
    }
    .sfa-banner-close:hover { color: #475569; }
    .sfa-banner-title {
      font-size: 14px; font-weight: 600;
      color: #0f172a;
      line-height: 1.35;
      margin-bottom: 10px;
    }
    .sfa-banner-actions {
      display: flex; gap: 8px;
    }
    .sfa-banner-primary {
      flex: 1;
      background: #6366f1;
      color: #fff;
      border: none; border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px; font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      font-family: inherit;
    }
    .sfa-banner-primary:hover { background: #4f46e5; }
    .sfa-banner-primary:disabled { background: #cbd5e1; cursor: default; }
    .sfa-banner-secondary {
      background: #f1f5f9;
      color: #475569;
      border: none; border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px; font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      font-family: inherit;
    }
    .sfa-banner-secondary:hover { background: #e2e8f0; }

    /* ── Update-or-Add pill ── */
    .pill.update-or-add { gap: 4px; }
    .pill.update-or-add .pill-btn {
      padding: 2px 8px; border-radius: 4px; font-size: 11px;
      font-weight: 600; cursor: pointer; border: none;
      transition: background 0.15s; line-height: 1.4;
    }
    .pill.update-or-add .btn-update {
      background: rgba(255,255,255,0.2); color: #fff;
    }
    .pill.update-or-add .btn-update:hover { background: rgba(255,255,255,0.35); }
    .pill.update-or-add .btn-add {
      background: #fff; color: #d97706;
    }
    .pill.update-or-add .btn-add:hover { background: #fef3c7; }

    /* ── Alternatives panel ── */
    .alts-panel {
      position: fixed;
      background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
      box-shadow: 0 8px 24px rgba(15,23,42,0.12);
      font-family: system-ui, -apple-system, sans-serif;
      pointer-events: all; overflow: hidden;
      min-width: 200px; max-width: 320px;
      z-index: 3;
      animation: fadein 0.15s ease forwards;
    }
    .alts-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; border-bottom: 1px solid #f1f5f9;
      font-size: 12px; font-weight: 600; color: #334155;
    }
    .alts-close {
      background: none; border: none; cursor: pointer;
      font-size: 16px; color: #94a3b8; padding: 0; line-height: 1;
    }
    .alts-close:hover { color: #475569; }
    .alts-row {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; cursor: pointer;
      font-size: 13px; color: #475569;
      transition: background 0.1s;
    }
    .alts-row:hover { background: #f8fafc; }
    .alts-row.active { background: #eff6ff; color: #1e40af; font-weight: 500; cursor: default; }
    .alts-check { width: 16px; text-align: center; font-size: 12px; color: #4f46e5; }
    .alts-value { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .alts-default {
      font-size: 10px; background: #e0e7ff; color: #4338ca;
      padding: 1px 6px; border-radius: 4px; font-weight: 500;
    }
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

// ── Update-or-Add pill ─────────────────────────────────────────────────────

export interface UpdateOrAddTarget {
  el:       HTMLElement;
  label:    string;
  oldValue: string;
  newValue: string;
  onUpdate: () => void;
  onAdd:    () => void;
}

let _uoaPillTimer: ReturnType<typeof setTimeout> | undefined;

export function showUpdateOrAddPill(target: UpdateOrAddTarget): void {
  clearTimeout(_hideTimer);
  clearTimeout(_uoaPillTimer);

  const sh  = ensureHost();
  const pel = ensurePill(sh);

  _activePillCallback = null;
  pel.className = 'pill learn update-or-add';
  // Show what was filled vs what the user changed it to.
  // "Add new" is first (prominent/default) — saves both values, new one is
  // next-fill default. "Replace" is secondary — overwrites the stored value.
  pel.innerHTML = `
    <span class="icon">💡</span>
    <span class="value old-val">${escapeHtml(truncate(target.oldValue, 9))}</span>
    <span class="sep">→</span>
    <span class="value new-val">${escapeHtml(truncate(target.newValue, 9))}</span>
    <button class="pill-btn btn-add primary" data-action="add">Add new</button>
    <button class="pill-btn btn-update" data-action="update">Replace</button>
  `;

  pel.querySelector('.btn-update')?.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    target.onUpdate();
    hidePill();
  });
  pel.querySelector('.btn-add')?.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    target.onAdd();
    hidePill();
  });

  positionPill(target.el);
  _uoaPillTimer = setTimeout(hidePill, 8000);
}

// ── Alternatives panel ─────────────────────────────────────────────────────

export interface AlternativeEntry {
  id:         string;
  value:      string;
  isDefault:  boolean;
  sensitive?: boolean;
}

let _altsPanelEl: HTMLElement | null = null;
let _altsOutsideHandler: ((e: MouseEvent) => void) | null = null;
let _altsEscHandler:     ((e: KeyboardEvent) => void) | null = null;

export function showAlternativesPanel(
  fieldEl:  HTMLElement,
  label:    string,
  entries:  AlternativeEntry[],
  onSelect: (entryId: string, value: string) => void,
): void {
  hideAlternativesPanel();
  if (entries.length < 2) return;

  const sh = ensureHost();
  const panel = document.createElement('div');
  panel.id = 'ditto-alts-panel';
  panel.className = 'alts-panel';

  const header = document.createElement('div');
  header.className = 'alts-header';
  header.innerHTML = `
    <span>${escapeHtml(truncate(label, 28))}</span>
    <button class="alts-close">×</button>
  `;
  header.querySelector('.alts-close')!.addEventListener('click', hideAlternativesPanel);
  panel.appendChild(header);

  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `alts-row${entry.isDefault ? ' active' : ''}`;
    const displayVal = entry.sensitive ? '••••••' : truncate(entry.value, 40);
    row.innerHTML = `
      <span class="alts-check">${entry.isDefault ? '✓' : ''}</span>
      <span class="alts-value">${escapeHtml(displayVal)}</span>
      ${entry.isDefault ? '<span class="alts-default">default</span>' : ''}
    `;
    if (!entry.isDefault) {
      // Prevent the input from blurring when the user presses the mouse button
      // on a row — blur fires on mousedown, click fires on mouseup. Without this,
      // the blur-triggered hideAlternativesPanel(150ms) races against the click.
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        onSelect(entry.id, entry.value);
        hideAlternativesPanel();
      });
    }
    panel.appendChild(row);
  }

  // Position below the field
  const rect = fieldEl.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const panelWidth = 280;
  Object.assign(panel.style, {
    top:  `${rect.bottom + 4}px`,
    left: `${Math.max(8, Math.min(rect.left, vw - panelWidth - 8))}px`,
  });

  sh.appendChild(panel);
  _altsPanelEl = panel;

  // Dismiss on outside click.
  // Delay registration so the click that opened the panel (mousedown→focus→
  // background call → panel created, all before mouseup/click fires) does not
  // immediately dismiss it. 200ms is safely past any realistic opening-click
  // propagation (mousedown→mouseup typically 50-150ms).
  // composedPath() is required because the panel lives inside Shadow DOM —
  // e.target is retargeted to the shadow host, so contains() is always false.
  setTimeout(() => {
    _altsOutsideHandler = (e: MouseEvent) => {
      const path: EventTarget[] = e.composedPath ? e.composedPath() : [];
      if (path.some(node => node === _altsPanelEl)) return;
      hideAlternativesPanel();
    };
    document.addEventListener('click', _altsOutsideHandler, true);
  }, 200);

  _altsEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hideAlternativesPanel();
  };
  document.addEventListener('keydown', _altsEscHandler, true);
}

export function isAlternativesPanelOpen(): boolean {
  return _altsPanelEl !== null;
}

export function hideAlternativesPanel(): void {
  _altsPanelEl?.remove();
  _altsPanelEl = null;
  if (_altsOutsideHandler) {
    document.removeEventListener('click', _altsOutsideHandler, true);
    _altsOutsideHandler = null;
  }
  if (_altsEscHandler) {
    document.removeEventListener('keydown', _altsEscHandler, true);
    _altsEscHandler = null;
  }
}

// ── Field status badge (Phase AD.2) ───────────────────────────────────────────
//
// 10×10 dot anchored just outside the input's right edge, vertically centered.
// Three colors map 1:1 to FillAction:
//   green  (fill)   — confident match, filled silently
//   yellow (review) — mid-confidence, filled but worth a glance
//   grey   (flag)   — unknown / low-confidence; we did NOT fill, prompt user
//
// Lives inside the same Shadow DOM as the pills/banner so host-page CSS
// can't restyle or hide it. Repositions on scroll/resize the same way ghosts
// do. The tooltip uses the native `title` attribute — appears on hover
// without any custom positioning logic, and is accessibility-readable.

interface FieldBadgeEntry {
  target: HTMLElement;
  badge: HTMLElement;
  fillAction: FillAction;
}

const _badges = new Set<FieldBadgeEntry>();
const _badgesByTarget = new WeakMap<HTMLElement, FieldBadgeEntry>();
let _badgeStyleEl: HTMLStyleElement | null = null;

function ensureBadgeStyles(sh: ShadowRoot): void {
  if (_badgeStyleEl && _badgeStyleEl.isConnected) return;
  const style = document.createElement('style');
  style.textContent = `
    .sfa-badge {
      position: fixed;
      width: 10px; height: 10px;
      border-radius: 50%;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.85), 0 1px 3px rgba(15,23,42,0.18);
      pointer-events: all;
      z-index: 2147483640;
      cursor: help;
      transition: transform 0.1s;
    }
    .sfa-badge:hover { transform: scale(1.4); }
    .sfa-badge.fill   { background: #10b981; } /* emerald-500 */
    .sfa-badge.review { background: #f59e0b; } /* amber-500 */
    .sfa-badge.flag   { background: #94a3b8; } /* slate-400 */
  `;
  sh.appendChild(style);
  _badgeStyleEl = style;
}

/**
 * Paint a status dot on a form field. Idempotent — calling repeatedly with
 * different fillAction values just updates the existing dot. Pass the same
 * target with a new fillAction to recolor (e.g., when a user heals a field
 * and its confidence shifts from review → fill).
 *
 * @param tooltip Free-text shown on hover. Recommended format:
 *                `${source}: ${canonicalKey} → ${value}`
 */
export function paintFieldBadge(
  target: HTMLElement,
  fillAction: FillAction,
  tooltip: string = '',
): void {
  if (!target.isConnected) return;

  const sh = ensureHost();
  ensureBadgeStyles(sh);

  const existing = _badgesByTarget.get(target);
  if (existing) {
    existing.badge.className = `sfa-badge ${fillAction}`;
    existing.badge.title = tooltip;
    existing.fillAction = fillAction;
    positionBadge(existing);
    return;
  }

  const badge = document.createElement('div');
  badge.className = `sfa-badge ${fillAction}`;
  badge.title = tooltip;
  sh.appendChild(badge);

  const entry: FieldBadgeEntry = { target, badge, fillAction };
  _badges.add(entry);
  _badgesByTarget.set(target, entry);
  positionBadge(entry);
}

function positionBadge(entry: FieldBadgeEntry): void {
  const rect = entry.target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // Element not yet laid out (or hidden). Keep the badge attached but
    // park it offscreen — repositionAllBadges will catch it on the next
    // scroll/resize tick once layout completes.
    entry.badge.style.display = 'none';
    return;
  }
  entry.badge.style.display = '';
  // Just OUTSIDE the input's right edge, vertically centered. This keeps
  // the dot from overlapping framework UI like Material clear-x buttons.
  entry.badge.style.top  = `${rect.top + rect.height / 2 - 5}px`;
  entry.badge.style.left = `${rect.right + 4}px`;
}

export function removeFieldBadge(target: HTMLElement): void {
  const entry = _badgesByTarget.get(target);
  if (!entry) return;
  entry.badge.remove();
  _badges.delete(entry);
  _badgesByTarget.delete(target);
}

/** Called from the same scroll/resize handler that drives ghost reposition. */
export function repositionAllBadges(): void {
  for (const entry of _badges) {
    if (!entry.target.isConnected || !entry.badge.isConnected) {
      removeFieldBadge(entry.target);
      continue;
    }
    positionBadge(entry);
  }
}

/** Called from the MutationObserver sweep — cheap, no layout reads. */
export function sweepDisconnectedBadges(): void {
  for (const entry of _badges) {
    if (!entry.target.isConnected || !entry.badge.isConnected) {
      removeFieldBadge(entry.target);
    }
  }
}
