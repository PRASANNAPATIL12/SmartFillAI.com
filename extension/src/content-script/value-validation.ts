/**
 * Shape-based validation of values about to be saved into the profile, OR
 * about to be applied from the profile to a form field.
 *
 * The motivating bug: `tryLearnField` captures `el.textContent.trim()` for
 * button-triggered dropdowns. When the picker panel is open / partially
 * visible in the DOM, the button's textContent may contain the *entire
 * option list concatenated* — e.g. "243839891002" from "+1+93+358+355+213…"
 * for a country picker. Once that garbage enters the profile, it propagates
 * across pages forever.
 *
 * Two protections:
 *   1. Validate at LEARN time — refuse to save values that don't fit the
 *      canonical_key's shape.
 *   2. Validate at FILL time — treat invalid stored entries as if no entry
 *      exists, so pre-existing bad values from older sessions don't fill
 *      forms with garbage.
 */

import { resolveCountry } from './country-aliases';
import { expandValueAliases, hasValueAliases } from './value-aliases';

/** Shape validators per canonical_key. Returning true means the value is structurally sane. */
const VALIDATORS: Record<string, (value: string) => boolean> = {
  phone_country_code: v => /^\+?\d{1,4}$/.test(v.trim()),
  // A country entry must be a NAME (or ISO code), never a bare calling code.
  // "+1"/"+91" here means the widget's collapsed display was mis-captured —
  // reject so it heals away and gets re-learned from the clicked option text.
  country:            v => !/^\+?\d{1,4}$/.test(v.trim()) && resolveCountry(v) !== null,
  email:              v => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()),
  phone_number:       v => {
    const digits = v.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 20;
  },
  zip_code:           v => /^[A-Za-z0-9 -]{3,12}$/.test(v.trim()),
  website_url:        v => /^https?:\/\/\S{3,}$/i.test(v.trim()) || /^[\w-]+\.[\w./-]+$/i.test(v.trim()),
  linkedin_url:       v => /linkedin\.com/i.test(v) || /^[\w-]{3,}$/i.test(v.trim()),
  github_url:         v => /github\.com/i.test(v)   || /^[\w-]{3,}$/i.test(v.trim()),
  date_of_birth:      v => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v.trim()) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(v.trim()),
  graduation_year:    v => /^(19|20)\d{2}$/.test(v.trim()),
  gpa:                v => {
    const n = Number(v.trim());
    return Number.isFinite(n) && n >= 0 && n <= 10;
  },
  years_of_experience:v => {
    const n = Number(v.trim().replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n >= 0 && n <= 70;
  },
};

/**
 * Categorical canonical_keys that use value-aliases.ts tables. We don't
 * inline their validators above because `hasValueAliases` is the source of
 * truth and any new alias key we add to value-aliases.ts automatically gets
 * validated here without a code change.
 */
function validateAliasedValue(canonicalKey: string, value: string): boolean {
  // expandValueAliases returns [value] (length 1) for unrecognized inputs
  // and a longer alias array (length ≥ 2) when the value matches a group.
  return expandValueAliases(canonicalKey, value).length > 1;
}

/**
 * Universal fallback: rejects values that look like garbage captured from
 * a panel's textContent — extremely long, multi-line, or containing patterns
 * that don't belong in a single form-field value.
 */
function passesUniversalSanityCheck(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (v.length > 200) return false;                     // catches "entire option list" capture
  if (/\n.*\n/.test(v)) return false;                   // multi-newline → almost always panel text
  if ((v.match(/\+\d/g) ?? []).length >= 4) return false; // "+1+93+358+355..." pattern
  return true;
}

/**
 * Return true if the value is structurally valid for the given canonical_key.
 * Unknown canonical_keys pass through the universal sanity check only.
 *
 * Used by:
 *   • tryLearnField — before doLearnField (reject bad saves)
 *   • matcher / fill path — before applying a stored entry (reject bad applies)
 */
export function validateLearnedValue(canonicalKey: string | undefined, value: string): boolean {
  if (!value) return false;
  if (!passesUniversalSanityCheck(value)) return false;

  if (!canonicalKey) return true; // already passed universal check

  const specific = VALIDATORS[canonicalKey];
  if (specific) return specific(value);

  if (hasValueAliases(canonicalKey)) return validateAliasedValue(canonicalKey, value);

  // No shape rule defined → accept (universal sanity already passed).
  return true;
}
