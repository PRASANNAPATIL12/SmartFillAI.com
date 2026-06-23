/**
 * Date parsing utilities shared between the content script (date-handler.ts)
 * and the background service worker (field-learner.ts normalizeFieldValue).
 * Neither layer can import from the other, so this lives in the shared layer.
 */

export const MONTH_NAMES: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse a date string in any common format and return ISO 8601 (YYYY-MM-DD or YYYY-MM).
 * Returns null if the string cannot be recognized as a date.
 */
export function toISODate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // Already ISO: 2024-03-15 or 1995-06
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

  // MM/YYYY or MM-YYYY (month-year only)
  const my = s.match(/^(\d{1,2})[/\-.](\d{4})$/);
  if (my) return `${my[2]}-${my[1].padStart(2, '0')}`;

  // "March 1995" or "Mar 1995"
  const monthYear = s.match(/^([a-z]+)\s+(\d{4})$/i);
  if (monthYear) {
    const mm = MONTH_NAMES[monthYear[1].toLowerCase()];
    if (mm) return `${monthYear[2]}-${mm}`;
  }

  // "15 March 1995" or "15 Mar 1995"
  const dayMonthYear = s.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
  if (dayMonthYear) {
    const mm = MONTH_NAMES[dayMonthYear[2].toLowerCase()];
    if (mm) return `${dayMonthYear[3]}-${mm}-${dayMonthYear[1].padStart(2, '0')}`;
  }

  // "March 15, 1995" or "March 15 1995"
  const monthDayYear = s.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (monthDayYear) {
    const mm = MONTH_NAMES[monthDayYear[1].toLowerCase()];
    if (mm) return `${monthDayYear[3]}-${mm}-${monthDayYear[2].padStart(2, '0')}`;
  }

  // "15-Jun-2026" (Angular Material DD-MMM-YYYY)
  const ddMmmYyyy = s.match(/^(\d{1,2})-([a-z]{3})-(\d{4})$/i);
  if (ddMmmYyyy) {
    const mm = MONTH_NAMES[ddMmmYyyy[2].toLowerCase()];
    if (mm) return `${ddMmmYyyy[3]}-${mm}-${ddMmmYyyy[1].padStart(2, '0')}`;
  }

  // Bare year: "1995" → "1995-01-01" (best guess for fill; caller may truncate)
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;

  return null;
}
