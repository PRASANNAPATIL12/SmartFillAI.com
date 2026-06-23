/**
 * Handler for date inputs:
 *   - <input type="date"> / <input type="month"> — native browser pickers
 *   - <input type="text"> used as a date picker (Angular Material matDatepicker,
 *     Flatpickr, React DatePicker, Pikaday, etc.) — detected by attributes /
 *     placeholder patterns, filled with a locale-formatted string
 *
 * Canonical storage format: ISO 8601 (YYYY-MM-DD or YYYY-MM).
 * On fill, ISO is converted to whatever display format the form expects.
 */
import type { FieldHandler } from './types';
import { fillPlainInput } from '../filler';
import { toISODate, MONTH_NAMES } from '@shared/date-utils';

// ── Display format helpers ────────────────────────────────────────────────────

const SHORT_MONTH: Record<string, string> = Object.fromEntries(
  Object.entries(MONTH_NAMES)
    .filter(([k]) => k.length === 3)        // 3-letter abbrevs
    .map(([k, v]) => [v, k.charAt(0).toUpperCase() + k.slice(1)]) // "01" → "Jan"
);

function formatISOForDisplay(iso: string, format: string): string {
  const parts = iso.split('-');
  const yr = parts[0] ?? '';
  const mo = parts[1] ?? '';
  const dy = parts[2] ?? '';
  switch (format) {
    case 'DD-MMM-YYYY': return dy ? `${dy}-${SHORT_MONTH[mo] ?? mo}-${yr}` : iso;
    case 'DD/MM/YYYY':  return dy ? `${dy}/${mo}/${yr}` : iso;
    case 'MM/DD/YYYY':  return dy ? `${mo}/${dy}/${yr}` : iso;
    case 'YYYY-MM-DD':  return iso;
    case 'MM/YYYY':     return mo ? `${mo}/${yr}` : iso;
    case 'YYYY-MM':     return mo ? `${yr}-${mo}` : iso;
    default:            return iso;
  }
}

// ── Text-based date picker detection ─────────────────────────────────────────

function isTextDatePicker(el: HTMLInputElement): boolean {
  if (el.type !== 'text') return false;
  // Angular Material
  if (el.hasAttribute('matdatepicker') || el.hasAttribute('ng-reflect-mat-datepicker')) return true;
  // Any picker that opens a calendar dialog
  const popup = el.getAttribute('aria-haspopup');
  if (popup === 'dialog' || popup === 'true') return true;
  // Flatpickr
  if (el.hasAttribute('_flatpickr') || el.hasAttribute('data-input')) return true;
  // Placeholder contains date-format tokens
  if (/\b(dd|mm|yyyy)\b/i.test(el.placeholder ?? '')) return true;
  // HTML autocomplete hint
  if ((el.autocomplete ?? '').toLowerCase() === 'bday') return true;
  return false;
}

// ── Format detection ──────────────────────────────────────────────────────────

function detectDateFormat(el: HTMLInputElement): string {
  const ph = (el.placeholder ?? '').toUpperCase().trim();
  // Check for 3-letter month abbreviation first (DD-MMM-YYYY, Angular Material India)
  if (/DD[-.\s]?MMM[-.\s]?YYYY/.test(ph)) return 'DD-MMM-YYYY';
  if (/DD[/\-.]MM[/\-.]YYYY/.test(ph))    return 'DD/MM/YYYY';
  if (/MM[/\-.]DD[/\-.]YYYY/.test(ph))    return 'MM/DD/YYYY';
  if (/YYYY[-/]MM[-/]DD/.test(ph))        return 'YYYY-MM-DD';
  if (/MM[/\-.]YYYY/.test(ph))            return 'MM/YYYY';

  // data-date-format / data-format attributes (Flatpickr, custom pickers)
  const fmt = (el.dataset.dateFormat ?? el.dataset.format ?? '').toUpperCase();
  if (fmt) return fmt;

  // Locale-based fallback
  const lang = (typeof navigator !== 'undefined' ? navigator.language : '') ?? '';
  if (/^en-US|^en-CA/i.test(lang)) return 'MM/DD/YYYY';
  // en-IN and most non-US locales use DD/MM/YYYY
  return 'DD/MM/YYYY';
}

// ── Calendar popup fallback (Angular Material / generic) ─────────────────────

function monthYearMatches(headerText: string, yr: number, mo: number): boolean {
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const text = headerText.toLowerCase();
  const targetMonth = MONTHS[mo - 1];
  return text.includes(String(yr)) && (targetMonth ? text.includes(targetMonth) : false);
}

function isAfterTarget(headerText: string, yr: number, mo: number): boolean {
  // Returns true if the displayed month/year is AFTER the target (so we click "prev")
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const text = headerText.toLowerCase();
  const dispYearMatch = text.match(/\d{4}/);
  if (!dispYearMatch) return false;
  const dispYear = parseInt(dispYearMatch[0], 10);
  if (dispYear !== yr) return dispYear > yr;
  const dispMonthIdx = MONTHS.findIndex(m => text.includes(m));
  if (dispMonthIdx === -1) return false;
  return dispMonthIdx + 1 > mo;
}

async function fillCalendarPicker(input: HTMLInputElement, iso: string): Promise<boolean> {
  const parts = iso.split('-').map(Number);
  const yr = parts[0];
  const mo = parts[1];
  const dy = parts[2];
  if (!yr || !mo || !dy) return false;

  // Find toggle button (Angular Material or generic calendar icon)
  const toggleBtn = input.parentElement?.querySelector<HTMLElement>(
    '.mat-datepicker-toggle button, [aria-label*="calendar" i], [aria-label*="picker" i], [aria-label*="date" i] button'
  );
  if (!toggleBtn) return false;

  toggleBtn.click();
  await new Promise(r => setTimeout(r, 300));

  const overlay = document.querySelector<HTMLElement>(
    '.mat-calendar, .mat-datepicker-popup, [role="dialog"] .datepicker-calendar, [role="dialog"] table'
  );
  if (!overlay) return false;

  // Navigate to target month (max 48 steps to allow multi-year navigation)
  for (let i = 0; i < 48; i++) {
    const headerBtn = overlay.querySelector<HTMLElement>(
      '.mat-calendar-period-button, .calendar-caption button, [aria-label*="month" i]'
    );
    const headerText = headerBtn?.textContent ?? overlay.querySelector('.mat-calendar-header')?.textContent ?? '';
    if (monthYearMatches(headerText, yr, mo)) break;
    const goBack = isAfterTarget(headerText, yr, mo);
    const navBtn = overlay.querySelector<HTMLElement>(
      goBack
        ? '.mat-calendar-previous-button, [aria-label*="previous" i]'
        : '.mat-calendar-next-button, [aria-label*="next" i]'
    );
    if (!navBtn) break;
    navBtn.click();
    await new Promise(r => setTimeout(r, 120));
  }

  // Click the target day cell
  const cells = overlay.querySelectorAll<HTMLElement>(
    '.mat-calendar-body-cell:not([aria-disabled="true"]), td.day:not(.disabled), [role="gridcell"]:not([aria-disabled="true"])'
  );
  for (const cell of cells) {
    const cellContent = cell.querySelector('.mat-calendar-body-cell-content, .day-number') ?? cell;
    const cellNum = parseInt(cellContent.textContent?.trim() ?? '0', 10);
    if (cellNum === dy) {
      cell.click();
      await new Promise(r => setTimeout(r, 100));
      return true;
    }
  }
  return false;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const dateHandler: FieldHandler = {
  kind: 'date',

  match(el: HTMLElement): boolean {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === 'date' || el.type === 'month') return true;
    return isTextDatePicker(el);
  },

  async fill(el: HTMLElement, value: string): Promise<boolean> {
    const input = el as HTMLInputElement;

    // Native date/month inputs — always use ISO directly
    if (input.type === 'date' || input.type === 'month') {
      let iso = toISODate(value);
      if (!iso) return false;
      if (input.type === 'month' && iso.length > 7) iso = iso.slice(0, 7);
      return fillPlainInput(input, iso);
    }

    // Text-based date pickers — format conversion required
    const iso = toISODate(value);
    if (!iso) return false;
    const fmt = detectDateFormat(input);
    const display = formatISOForDisplay(iso, fmt);
    const ok = await fillPlainInput(input, display);

    // Fallback: if the field stayed empty (Angular model didn't accept typed text),
    // interact with the calendar popup
    if (!input.value) {
      return fillCalendarPicker(input, iso);
    }
    return ok;
  },

  capture(el: HTMLElement): string | null {
    const raw = (el as HTMLInputElement).value?.trim();
    if (!raw) return null;
    // Normalize to ISO before storing — ensures consistent canonical format
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(raw)) return raw;
    return toISODate(raw) ?? raw;
  },
};
