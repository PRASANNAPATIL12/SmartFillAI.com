/**
 * Proactive page-level banner for SmartFillAI.
 *
 * The motto: the user must immediately know we're here to help.
 * The instant we detect a form, this banner slides in from the top-right
 * announcing the match count and offering a one-click fill.
 *
 * States:
 *   - ready   → "Fill N of M fields"          (primary CTA enabled)
 *   - empty   → "No matched data yet"         (links to popup)
 *   - filling → "Filling…"                    (spinner)
 *   - success → "✓ Filled N fields"           (auto-dismisses)
 */

import { getOverlayShadow } from './overlay';

export interface BannerReadyTarget {
  matched: number;
  total:   number;
  onFill:  () => void;
  onClose: () => void;
}

export interface BannerEmptyTarget {
  total:        number;
  onOpenPopup:  () => void;
  onClose:      () => void;
}

const BANNER_ID = 'sfa-banner';

let autoDismissTimer: ReturnType<typeof setTimeout> | undefined;

function getBanner(): HTMLElement | null {
  const sh = getOverlayShadow();
  return sh.getElementById(BANNER_ID);
}

function ensureBanner(extraClass = ''): HTMLElement {
  const sh = getOverlayShadow();
  clearTimeout(autoDismissTimer);

  let banner = sh.getElementById(BANNER_ID);
  if (banner) banner.remove();

  banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.className = ('sfa-banner ' + extraClass).trim();
  sh.appendChild(banner);
  return banner;
}

export function showReadyBanner(target: BannerReadyTarget): void {
  const banner = ensureBanner();
  const fieldWord = target.total === 1 ? 'field' : 'fields';
  const action    = target.matched === target.total
    ? `Fill ${target.matched} ${fieldWord}`
    : `Fill ${target.matched} of ${target.total} ${fieldWord}`;

  banner.innerHTML = `
    <div class="sfa-banner-header">
      <span class="sfa-banner-brand">SmartFillAI</span>
      <span class="sfa-banner-spacer"></span>
      <button class="sfa-banner-close" data-action="close" title="Dismiss">×</button>
    </div>
    <div class="sfa-banner-title">Form detected. Ready to autofill.</div>
    <div class="sfa-banner-actions">
      <button class="sfa-banner-primary" data-action="fill">${escapeHtml(action)}</button>
    </div>
  `;

  banner.querySelector<HTMLButtonElement>('[data-action="fill"]')
    ?.addEventListener('click', target.onFill);
  banner.querySelector<HTMLButtonElement>('[data-action="close"]')
    ?.addEventListener('click', target.onClose);
}

export function showEmptyBanner(target: BannerEmptyTarget): void {
  const banner = ensureBanner('empty');
  const fieldWord = target.total === 1 ? 'field' : 'fields';

  banner.innerHTML = `
    <div class="sfa-banner-header">
      <span class="sfa-banner-brand">SmartFillAI</span>
      <span class="sfa-banner-spacer"></span>
      <button class="sfa-banner-close" data-action="close" title="Dismiss">×</button>
    </div>
    <div class="sfa-banner-title">Form detected (${target.total} ${fieldWord}). Add your data and we'll fill it next time.</div>
    <div class="sfa-banner-actions">
      <button class="sfa-banner-secondary" data-action="open">Open SmartFillAI</button>
    </div>
  `;

  banner.querySelector<HTMLButtonElement>('[data-action="open"]')
    ?.addEventListener('click', target.onOpenPopup);
  banner.querySelector<HTMLButtonElement>('[data-action="close"]')
    ?.addEventListener('click', target.onClose);
}

export function showFillingBanner(): void {
  const banner = getBanner();
  if (!banner) return;
  const primary = banner.querySelector<HTMLButtonElement>('.sfa-banner-primary');
  if (primary) {
    primary.disabled = true;
    primary.textContent = 'Filling…';
  }
}

export function showSuccessBanner(filledCount: number): void {
  const banner = ensureBanner('success');
  const word = filledCount === 1 ? 'field' : 'fields';

  banner.innerHTML = `
    <div class="sfa-banner-header">
      <span class="sfa-banner-brand">SmartFillAI</span>
      <span class="sfa-banner-spacer"></span>
      <button class="sfa-banner-close" data-action="close" title="Dismiss">×</button>
    </div>
    <div class="sfa-banner-title">✓ Filled ${filledCount} ${word}</div>
  `;

  banner.querySelector<HTMLButtonElement>('[data-action="close"]')
    ?.addEventListener('click', hideBanner);

  autoDismissTimer = setTimeout(hideBanner, 2500);
}

export function hideBanner(): void {
  clearTimeout(autoDismissTimer);
  const sh = getOverlayShadow();
  sh.getElementById(BANNER_ID)?.remove();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
