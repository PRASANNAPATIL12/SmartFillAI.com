/**
 * Field Matcher — deterministic, local, zero network calls.
 *
 * Step 1   : SKIP            — exclude fields we should never touch
 * Step 1.5 : OPTION-SET      — decisive dropdown options override label regex
 * Step 1.6 : FORM FINGERPRINT — whole-form match across ATS family (Phase AD.1)
 * Step 2   : FIELD CACHE     — per-domain field fingerprint → known match
 * Step 3   : ESSAY           — detect long-form AI-generation candidates
 * Step 4   : RULES           — autocomplete → inputType → text patterns
 * Step 5   : EMBEDDING       — option-text semantic match (lives in fillSelect)
 * Step 6   : LLM             — Gemini ANSWER_FIELD (lives in answer-field.ts)
 *
 * matchField itself is sync — async work (loading fingerprints, embeddings,
 * LLM) happens outside and is passed in via parameters.
 */

import type { DocumentType, FieldSignature, MatchResult, ProfileEntry, FieldCacheEntry, FillAction } from '@shared/types';
import { resolveCountry } from './content-script/country-aliases';
import { expandValueAliases, hasValueAliases } from './content-script/value-aliases';
import { validateLearnedValue } from './content-script/value-validation';
import type { FormFingerprint } from './content-script/form-fingerprinter';
import { findFingerprintEntry } from './content-script/form-fingerprinter';

/**
 * Phase AD.2 — confidence band thresholds. Tuned so:
 *   • Autocomplete (0.99), high-quality patterns (≥0.93), and fingerprint
 *     replays sit in the FILL band — silent fills, green badge.
 *   • Lower-confidence pattern matches (0.80–0.89) land in REVIEW — we fill
 *     but flag yellow so the user can quickly correct.
 *   • UNKNOWN and below-threshold matches go to FLAG — no fill, learn prompt.
 */
export const FILL_THRESHOLD = 0.90;
export const REVIEW_THRESHOLD = 0.70;

/**
 * Derive the fill-action band from a MatchResult. Pure function; safe to call
 * multiple times (matchField stamps it on the result, but consumers that
 * synthesize their own MatchResults can call this directly).
 */
export function computeFillAction(result: MatchResult): FillAction | undefined {
  // SKIP / ESSAY / FILE_UPLOAD bypass the regular fill path entirely.
  if (result.status === 'SKIP') return undefined;
  if (result.status === 'ESSAY' || result.status === 'FILE_UPLOAD') return undefined;

  // UNKNOWN always flags — never fill a field whose canonical key we couldn't determine.
  if (result.status === 'UNKNOWN') return 'flag';

  // MATCHED: band by confidence.
  const c = result.confidence ?? 0;
  if (c >= FILL_THRESHOLD) return 'fill';
  if (c >= REVIEW_THRESHOLD) return 'review';
  return 'flag';
}

/**
 * Stamp `fillAction` onto a MatchResult and return it. Used at the end of
 * matchField so every consumer sees the band without having to call
 * computeFillAction themselves.
 */
function withFillAction(result: MatchResult): MatchResult {
  const fillAction = computeFillAction(result);
  if (fillAction) result.fillAction = fillAction;
  return result;
}

/**
 * Find a profile entry for the given canonical_key AND validate its value
 * passes the shape check. Pre-existing bad values from older sessions (e.g.
 * `phone_country_code = "243839891002"`) would otherwise still get applied
 * to forms. By treating invalid entries as missing, we degrade gracefully:
 * the field stays UNKNOWN and the user can re-learn it cleanly.
 */
function findDefaultEntry(profile: ProfileEntry[], canonicalKey: string): ProfileEntry | undefined {
  const candidates = profile
    .filter(p => p.canonical_key === canonicalKey)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const entry of candidates) {
    if (validateLearnedValue(canonicalKey, entry.value)) return entry;
  }
  return undefined;
}

export function findAllValidEntries(profile: ProfileEntry[], canonicalKey: string): ProfileEntry[] {
  return profile
    .filter(p => p.canonical_key === canonicalKey && validateLearnedValue(canonicalKey, p.value))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

// Simple noun canonical keys whose value is a short literal (a country, a
// city, a name). When one of these is matched only because the keyword
// appears INSIDE a long question, the match is almost certainly wrong.
const SIMPLE_NOUN_KEYS = new Set([
  'country', 'city', 'state', 'zip_code', 'street_address', 'address_line2',
  'current_location', 'preferred_location',
  'first_name', 'last_name', 'full_name', 'middle_name', 'nationality',
]);
const QUESTION_RE = /\?|\b(are|do|does|did|have|has|will|would|can|could|should|is|was|were)\s+you\b/i;

/**
 * True when `canonical` is a simple-noun key but the field's label reads like
 * a (long) question — i.e. the keyword is incidental, not the field's purpose.
 * Example: "Are you legally authorized to work in the country…" matches the
 * `country` rule but is really a yes/no question.
 */
function isIncidentalNounMatch(sig: FieldSignature, canonical: string): boolean {
  if (!SIMPLE_NOUN_KEYS.has(canonical)) return false;
  const text = combine(sig);
  if (!QUESTION_RE.test(text)) return false;
  return text.trim().split(/\s+/).length > 6; // long question → keyword is incidental
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match a single field against the user's profile.
 *
 * @param sig         Extracted field signature
 * @param profile     User's profile entries
 * @param cache       Domain-level field cache (empty Map is fine on first visit)
 * @param domain      Current page hostname (for cache fingerprint)
 * @param fingerprint Loaded form-level fingerprint for this page, if any
 *                    (Phase AD.1 — one fingerprint per page, applied to every field)
 */
export function matchField(
  sig: FieldSignature,
  profile: ProfileEntry[],
  cache: Map<string, FieldCacheEntry>,
  domain: string,
  fingerprint?: FormFingerprint,
): MatchResult {
  return withFillAction(matchFieldInternal(sig, profile, cache, domain, fingerprint));
}

function matchFieldInternal(
  sig: FieldSignature,
  profile: ProfileEntry[],
  cache: Map<string, FieldCacheEntry>,
  domain: string,
  fingerprint?: FormFingerprint,
): MatchResult {
  // Step 1: SKIP
  const skipReason = shouldSkip(sig);
  if (skipReason) return { status: 'SKIP', reason: skipReason };

  // File upload detection (before any cache tier — file inputs never use them)
  if (sig.inputType === 'file') return classifyFileField(sig);

  // Step 1.5: Option-set awareness — when the dropdown's visible options are
  // semantically decisive (only [Yes, No]; 200 country names; gender aliases;
  // degree aliases; etc.), force the canonical_key from the option set
  // INSTEAD of trusting potentially-misleading label regex matches. This
  // runs before any cache tier because caches may carry a past mis-match
  // (e.g. yes/no field cached as country because label contained "country").
  const optionSetMatch = classifyByOptionSet(sig, profile);
  if (optionSetMatch) return optionSetMatch;

  // Step 1.6: Form-fingerprint cache (Phase AD.1) — whole-form match keyed
  // by ${atsId}::${structuralHash}. When present, every field whose nameHash
  // appears in the fingerprint's field list gets its canonical_key in an
  // O(1) lookup. Generalizes learning across all companies on the same ATS:
  // a fingerprint learned on Greenhouse/Databricks applies to Greenhouse/Stripe.
  if (fingerprint) {
    const fpMatch = fingerprintMatch(sig, fingerprint, profile);
    if (fpMatch) return fpMatch;
  }

  // Step 2: Per-field cache lookup
  const cached = cacheMatch(sig, cache, domain);
  if (cached) {
    // Validate the cached entry still exists AND its value is structurally
    // sane. Resume re-parsing or profile resets generate new entry IDs;
    // older sessions may have learned corrupted values (e.g. an entire
    // option-list textContent captured as a phone_country_code). Both
    // cases fall through here so the field gets re-matched cleanly.
    if (cached.profileEntryId) {
      const entry = profile.find(e => e.id === cached.profileEntryId);
      if (entry && validateLearnedValue(entry.canonical_key, entry.value)) {
        cached.alternativeCount = findAllValidEntries(profile, entry.canonical_key).length;
        return cached;
      }
    }
    // Stale or invalid cache hit — fall through to rule matching.
  }

  // Step 3: Essay detection
  if (isEssay(sig)) return { status: 'ESSAY', reason: 'essay field detected', matchStep: 3 };

  // Step 4: Deterministic rules
  const rule = ruleMatch(sig);
  if (rule) {
    // Guard against incidental-keyword matches. A long question label like
    // "Are you legally authorized to work in the country in which you are
    // applying?" contains the word "country" and would otherwise match the
    // `country` rule — then we'd fill a Yes/No question with a country name.
    // Drop these to UNKNOWN so the LLM-answer path (PR2) handles them; never
    // cross-fill a simple noun value into a question field.
    if (isIncidentalNounMatch(sig, rule.canonical)) {
      return {
        status: 'UNKNOWN',
        reason: `question-style label; incidental "${rule.canonical}" keyword ignored`,
        matchStep: 4,
      };
    }
    const entry = findDefaultEntry(profile, rule.canonical);
    if (entry) {
      return {
        status: 'MATCHED',
        profileEntryId: entry.id,
        confidence: rule.confidence,
        reason: rule.reason,
        matchStep: 4,
        alternativeCount: findAllValidEntries(profile, rule.canonical).length,
      };
    }
    // We know what it IS, but the user hasn't filled that profile entry
    // yet, OR the stored entry's value failed shape validation. Either
    // way, treat as UNKNOWN so the user can learn it cleanly.
    return {
      status: 'UNKNOWN',
      reason: `rule matched canonical "${rule.canonical}" but no valid profile entry exists`,
      matchStep: 4,
    };
  }

  return { status: 'UNKNOWN', reason: 'no rule matched' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: SKIP
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_TYPES = new Set(['password', 'hidden', 'submit', 'button', 'reset', 'image', 'color', 'range']);

function shouldSkip(sig: FieldSignature): string | null {
  if (SKIP_TYPES.has(sig.inputType)) return `input type "${sig.inputType}"`;

  const combined = combine(sig);

  // Captcha
  if (/\bcaptcha\b|recaptcha|hcaptcha|turnstile|cf-turnstile/i.test(combined)) return 'captcha field';

  // OTP / 2FA
  if (/\botp\b|one.?time.?pass(word|code)|2fa|mfa|verify.?code|verification.?code|sms.?code|auth.?code/i.test(combined)) return 'OTP/2FA field';

  // Credit card (out of scope — password manager territory)
  if (/card.?number|credit.?card|debit.?card|\bcvv\b|\bcvc\b|card.?expir/i.test(combined)) return 'credit card field';

  // Search boxes
  if (/\bsearch\b|\bquery\b|site.?search/i.test(combined) && !sig.label) return 'search field';

  // Honeypot fields (hidden via CSS but not type="hidden") — skip to avoid detection.
  // Exception: file inputs are LEGITIMATELY hidden on sites that style them with
  // custom buttons (Angular Material's <span class="mdc-button__label"> wrapping the
  // input, plus Happiest Minds, iCIMS, and many other custom HR portals).
  // For file inputs we trust the detector's extractFileInputs pass to filter out
  // unreachable ones via the anchor walk.
  if (sig.element && sig.inputType !== 'file' && isHoneypot(sig.element)) {
    return 'honeypot field';
  }

  return null;
}

function isHoneypot(el: HTMLElement): boolean {
  // Elements that are visually hidden but not type="hidden"
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (style.opacity === '0') return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return true;
    // Off-screen: absolute positioned way off-screen
    if (
      parseFloat(style.position === 'absolute' ? style.left : '0') < -1000 ||
      parseFloat(style.position === 'absolute' ? style.top : '0') < -1000
    ) return true;
  } catch {
    // getComputedStyle not available (e.g., in tests) — don't mark as honeypot
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1.6: Form-fingerprint match (Phase AD.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to resolve a field against a previously-learned whole-form fingerprint.
 * The fingerprint is loaded once per page (by the content-script orchestrator);
 * each call here is a sync lookup against its in-memory field list.
 *
 * Returns MATCHED when the field's nameHash is present in the fingerprint AND
 * the user has a structurally-valid profile entry for the stored canonical_key.
 * Otherwise returns null so the waterfall continues with Step 2 (per-field
 * cache), Step 3 (essay), Step 4 (rules) — strict fallback, no regression.
 */
function fingerprintMatch(
  sig: FieldSignature,
  fp: FormFingerprint,
  profile: ProfileEntry[],
): MatchResult | null {
  const entry = findFingerprintEntry(fp, sig);
  if (!entry || !entry.canonicalKey) return null;

  // Defence-in-depth — the fingerprint guarantees a canonical_key mapping,
  // but the profile entry for that key may be missing or its value may have
  // been corrupted since the fingerprint was written. findDefaultEntry
  // handles both cases (it validates the entry's shape before returning).
  const profileEntry = findDefaultEntry(profile, entry.canonicalKey);
  if (!profileEntry) return null;

  return {
    status: 'MATCHED',
    profileEntryId: profileEntry.id,
    confidence: entry.confidence,
    reason: `fingerprint:${fp.atsId} (${entry.useCount} prior uses)`,
    matchStep: 1,
    alternativeCount: findAllValidEntries(profile, entry.canonicalKey).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Cache lookup
// ─────────────────────────────────────────────────────────────────────────────

export function fingerprint(sig: FieldSignature, domain: string): string {
  // Stable key: domain + name attr + id attr + lowercased label
  const raw = `${domain}::${sig.name}::${sig.id}::${sig.label.toLowerCase()}::${sig.inputType}`;
  return djb2(raw);
}

function cacheMatch(
  sig: FieldSignature,
  cache: Map<string, FieldCacheEntry>,
  domain: string
): MatchResult | null {
  const fp = fingerprint(sig, domain);
  const entry = cache.get(fp);
  if (!entry || entry.confidence < 0.90) return null;
  return {
    status: 'MATCHED',
    profileEntryId: entry.profileEntryId,
    confidence: entry.confidence,
    reason: `cache (${entry.useCount} uses)`,
    matchStep: 2,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Essay detection
// ─────────────────────────────────────────────────────────────────────────────

const ESSAY_LABEL_PATTERNS = [
  /why.*(interest|apply|want|fit|join|role|company|team|us)/i,
  /tell.*(us|me|about|yourself|experience|background)/i,
  /describe.*(your|experience|background|strengths?|yourself|role|achieve)/i,
  /what.*(motivates?|excites?|draws?|brought|brings?|passion|goal|strength)/i,
  /how.*(you.*contribute|experience.*relate|would.*add|handle|approach)/i,
  /cover.?letter/i,
  /personal.?statement/i,
  /additional.*(info|comment|detail|context|note|remark)/i,
  /anything.*(else|further|add|share|know)/i,
  /summary|bio\b|about.?me|professional.?summary/i,
  /\bessay\b/i,
  /short.?answer|long.?answer/i,
  /please.*(explain|describe|elaborate|share|provide)/i,
];

function isEssay(sig: FieldSignature): boolean {
  const isMultiline = sig.inputType === 'textarea'
    || (sig.inputType === 'ax-textbox' && sig.element?.getAttribute('aria-multiline') === 'true');
  if (!isMultiline) return false;
  // Short textareas (e.g., maxLength < 100) are probably not essays
  if (sig.maxLength !== null && sig.maxLength < 100) return false;
  const combined = combine(sig);
  return ESSAY_LABEL_PATTERNS.some(p => p.test(combined));
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Deterministic rule matching
// ─────────────────────────────────────────────────────────────────────────────

interface Rule {
  canonical: string;
  confidence: number;
  reason: string;
  // Match conditions (evaluated in order; first truthy match wins within a rule):
  autocomplete?: string | string[];  // exact match against the autocomplete attribute
  inputType?: string;                // exact input type
  pattern?: RegExp;                  // against combined label+placeholder+name+id+aria
  negativePattern?: RegExp;          // if this matches combined text, skip the rule
  requiresTextarea?: true;
}

/**
 * Rules are ordered: highest confidence first.
 * The FIRST matching rule wins for a given field.
 * Within each canonical key, more specific rules come before generic ones.
 */
const RULES: Rule[] = [

  // ── Autocomplete attribute (HTML5 standard, most reliable) ──────────────────
  // These have 0.99 confidence because the site developer explicitly labelled them.

  { canonical: 'email',          confidence: 0.99, reason: 'autocomplete=email',           autocomplete: 'email' },
  { canonical: 'full_name',      confidence: 0.99, reason: 'autocomplete=name',            autocomplete: 'name' },
  { canonical: 'first_name',     confidence: 0.99, reason: 'autocomplete=given-name',      autocomplete: 'given-name' },
  { canonical: 'middle_name',    confidence: 0.99, reason: 'autocomplete=additional-name', autocomplete: 'additional-name' },
  { canonical: 'last_name',      confidence: 0.99, reason: 'autocomplete=family-name',     autocomplete: 'family-name' },
  { canonical: 'phone_number',   confidence: 0.99, reason: 'autocomplete=tel',             autocomplete: ['tel', 'tel-national', 'tel-local'] },
  { canonical: 'current_company',confidence: 0.99, reason: 'autocomplete=organization',    autocomplete: 'organization' },
  { canonical: 'job_title',      confidence: 0.99, reason: 'autocomplete=organization-title', autocomplete: 'organization-title' },
  { canonical: 'street_address', confidence: 0.99, reason: 'autocomplete=street-address',  autocomplete: ['street-address', 'address-line1'] },
  { canonical: 'address_line2',  confidence: 0.99, reason: 'autocomplete=address-line2',   autocomplete: 'address-line2' },
  { canonical: 'city',           confidence: 0.99, reason: 'autocomplete=address-level2',  autocomplete: 'address-level2' },
  { canonical: 'state',          confidence: 0.99, reason: 'autocomplete=address-level1',  autocomplete: 'address-level1' },
  { canonical: 'zip_code',       confidence: 0.99, reason: 'autocomplete=postal-code',     autocomplete: 'postal-code' },
  { canonical: 'phone_country_code', confidence: 0.99, reason: 'autocomplete=tel-country-code', autocomplete: 'tel-country-code' },
  { canonical: 'country',        confidence: 0.99, reason: 'autocomplete=country',         autocomplete: ['country', 'country-name'] },
  { canonical: 'date_of_birth',  confidence: 0.99, reason: 'autocomplete=bday',            autocomplete: ['bday', 'bday-day', 'bday-month', 'bday-year'] },
  { canonical: 'gender',         confidence: 0.99, reason: 'autocomplete=sex',             autocomplete: 'sex' },
  { canonical: 'website_url',    confidence: 0.92, reason: 'autocomplete=url',             autocomplete: 'url' },

  // ── Input type signals ───────────────────────────────────────────────────────
  { canonical: 'email',        confidence: 0.98, reason: 'type=email',                    inputType: 'email' },
  { canonical: 'phone_number', confidence: 0.97, reason: 'type=tel',                      inputType: 'tel',
    negativePattern: /\bext(ension)?\b|\bfax\b|\bpager\b|\bdevice/i },
  // type=date alone is ambiguous (start date? DOB? availability?) — use lower confidence
  { canonical: 'date_of_birth',confidence: 0.80, reason: 'type=date (assumed DOB)',        inputType: 'date',
    pattern: /birth|dob|born|age/i },
  { canonical: 'website_url',  confidence: 0.82, reason: 'type=url (assumed website)',     inputType: 'url',
    negativePattern: /linkedin|github|twitter|portfolio|instagram|stackoverflow/i },

  // ── Email ─────────────────────────────────────────────────────────────────────
  { canonical: 'email', confidence: 0.97, reason: 'pattern: email address',
    pattern: /\bemail.?address\b|\be[-. ]?mail\b/i },
  { canonical: 'email', confidence: 0.93, reason: 'pattern: email (label)',
    pattern: /\bemail\b/i },

  // ── Name ─────────────────────────────────────────────────────────────────────
  { canonical: 'full_name',  confidence: 0.97, reason: 'pattern: full name',
    pattern: /full.?name|your.?name|complete.?name|legal.?name/i },
  { canonical: 'first_name', confidence: 0.97, reason: 'pattern: first name',
    pattern: /first.?name|given.?name|\bfname\b|forename|first\s*$/i },
  { canonical: 'last_name',  confidence: 0.97, reason: 'pattern: last name',
    pattern: /last.?name|family.?name|sur.?name|\blname\b/i },
  { canonical: 'middle_name',confidence: 0.95, reason: 'pattern: middle name/initial',
    pattern: /middle.?name|middle.?initial|\bmiddle\b/i },
  { canonical: 'full_name',  confidence: 0.80, reason: 'pattern: name (generic)',
    pattern: /\bname\b/i,
    negativePattern: /company|organization|employer|school|university|file|username|account|tag|display/i },

  // ── Phone ────────────────────────────────────────────────────────────────────
  { canonical: 'phone_number', confidence: 0.97, reason: 'pattern: phone/mobile/cell',
    pattern: /\bphone\b|\bmobile\b|\bcell\b|\btelephone\b/i,
    negativePattern: /interview|screen|call.?to.?action|\bext(ension)?\b|\bfax\b|\bpager\b|\bdevice|\btype\b|\bprefer/i },
  { canonical: 'phone_number', confidence: 0.90, reason: 'pattern: contact number',
    pattern: /contact.?number|reach.?you/i },

  // ── Address ──────────────────────────────────────────────────────────────────
  { canonical: 'street_address', confidence: 0.96, reason: 'pattern: street/address line',
    pattern: /street|address.?line|addr.?line|\baddress\b/i,
    negativePattern: /\bemail\b|\bweb\b|url|github|linkedin/i },
  { canonical: 'address_line2', confidence: 0.97, reason: 'pattern: address line 2',
    pattern: /address.?line.?2|apt|suite|unit\b|floor\b|building/i },
  { canonical: 'preferred_location', confidence: 0.93, reason: 'pattern: preferred work city',
    pattern: /preferred.{0,10}location|prefer.{0,10}city|preferred.{0,10}office.{0,10}location/i },
  { canonical: 'current_location',   confidence: 0.93, reason: 'pattern: current/present city',
    pattern: /current.{0,10}location|current.{0,10}city|present.{0,10}location|residing.{0,10}city|home.{0,10}city|base.{0,10}location/i },
  { canonical: 'city', confidence: 0.95, reason: 'pattern: city',
    pattern: /\bcity\b|\btown\b|\blocality\b|\bmunicipality\b/i },
  { canonical: 'state', confidence: 0.94, reason: 'pattern: state/province',
    pattern: /\bstate\b|\bprovince\b|\bregion\b|\bprefecture\b/i,
    negativePattern: /status|statement|university|college/i },
  { canonical: 'zip_code', confidence: 0.97, reason: 'pattern: zip/postal code',
    pattern: /\bzip\b|postal.?code|post.?code|pincode|pin.?code/i },
  { canonical: 'phone_country_code', confidence: 0.97, reason: 'pattern: dial/calling code',
    pattern: /dial.?code|calling.?code|phone.?country|country.?code\b/i },
  { canonical: 'country', confidence: 0.95, reason: 'pattern: country',
    pattern: /\bcountry\b|\bnation\b/i,
    negativePattern: /nationality|citizenship/i },

  // ── Identity ─────────────────────────────────────────────────────────────────
  { canonical: 'date_of_birth', confidence: 0.97, reason: 'pattern: date of birth',
    pattern: /date.?of.?birth|birth.?date|\bdob\b|\bbirthday\b|born.?on/i },
  { canonical: 'joining_date',  confidence: 0.93, reason: 'pattern: joining date',
    pattern: /joining.?date|date.?of.?joining|expected.?joining|join.?by/i },
  { canonical: 'graduation_date', confidence: 0.90, reason: 'pattern: graduation date',
    pattern: /graduation.?date|date.?of.?graduation|pass.?out.?year|course.?end.?date/i },
  { canonical: 'gender', confidence: 0.94, reason: 'pattern: gender',
    pattern: /\bgender\b/i,
    negativePattern: /non.?binary|preference/i },
  { canonical: 'gender', confidence: 0.90, reason: 'pattern: sex (gender)',
    pattern: /\bsex\b/i,
    negativePattern: /sexual/i },
  { canonical: 'pronouns', confidence: 0.97, reason: 'pattern: pronouns',
    pattern: /pronoun/i },
  { canonical: 'nationality', confidence: 0.95, reason: 'pattern: nationality/citizenship',
    pattern: /nationality|citizenship|citizen.?of/i },

  // ── Education ────────────────────────────────────────────────────────────────
  { canonical: 'university', confidence: 0.94, reason: 'pattern: university/college',
    pattern: /university|college|school.?name|institution|institute.?of/i,
    negativePattern: /high.?school.?diploma|gpa|degree|major/i },
  { canonical: 'degree', confidence: 0.94, reason: 'pattern: degree/major',
    pattern: /\bdegree\b|\bmajor\b|field.?of.?study|course.?of.?study|\bprogram\b/i },
  { canonical: 'gpa', confidence: 0.98, reason: 'pattern: GPA',
    pattern: /\bgpa\b|\bcgpa\b|grade.?point.?average/i },
  { canonical: 'graduation_year', confidence: 0.95, reason: 'pattern: graduation year',
    pattern: /grad(uation)?.?year|expected.?grad|class.?of/i },
  { canonical: 'graduation_month', confidence: 0.93, reason: 'pattern: graduation month',
    pattern: /grad(uation)?.?month/i },
  { canonical: 'high_school', confidence: 0.90, reason: 'pattern: high school',
    pattern: /high.?school/i },

  // ── Work experience ──────────────────────────────────────────────────────────
  { canonical: 'current_company', confidence: 0.94, reason: 'pattern: current company/employer',
    pattern: /current.?company|current.?employer|company.?name|employer.?name|place.?of.?work/i },
  { canonical: 'current_company', confidence: 0.80, reason: 'pattern: company (generic)',
    pattern: /\bcompany\b|\bemployer\b|\borganization\b/i,
    negativePattern: /previous|former|past|prior|last.?company/i },
  { canonical: 'job_title', confidence: 0.95, reason: 'pattern: job/position title',
    pattern: /job.?title|current.?title|position.?title|role.?title|your.?title/i },
  { canonical: 'job_title', confidence: 0.85, reason: 'pattern: title (role context)',
    pattern: /\btitle\b/i,
    negativePattern: /name.?title|honorific|mr|mrs|dr\b|prof\b|publication|book/i },
  { canonical: 'years_of_experience', confidence: 0.97, reason: 'pattern: years of experience',
    pattern: /years?.?of?.?experience|experience.?years?|how.?many.?years/i },
  { canonical: 'work_authorization', confidence: 0.95, reason: 'pattern: work authorization',
    pattern: /work.?auth|authorized.?to.?work|eligible.?to.?work|visa.?status|work.?permit/i },
  { canonical: 'visa_type',          confidence: 0.95, reason: 'pattern: visa type',
    pattern: /visa.?type|type.?of.?visa|work.?visa\b|h.?1.?b\b|opt\b|stem.?opt|ead\b|visa.?categor/i },
  { canonical: 'salary_expectation', confidence: 0.95, reason: 'pattern: salary expectation',
    pattern: /salary.?expect|expected.?salary|desired.?salary|compensation.?expect/i },
  { canonical: 'notice_period', confidence: 0.95, reason: 'pattern: notice period',
    pattern: /notice.?period|availability.?date|can.?join|available.?from/i },
  { canonical: 'start_date', confidence: 0.88, reason: 'pattern: start date',
    pattern: /start.?date|joining.?date|available.?start/i },

  // ── Social / web presence ────────────────────────────────────────────────────
  { canonical: 'linkedin_url',    confidence: 0.99, reason: 'pattern: LinkedIn',     pattern: /linkedin/i },
  { canonical: 'github_url',      confidence: 0.99, reason: 'pattern: GitHub',       pattern: /github/i },
  { canonical: 'twitter_handle',  confidence: 0.97, reason: 'pattern: Twitter/X',    pattern: /twitter|x\.com|\bhandle\b/i },
  { canonical: 'instagram_url',   confidence: 0.97, reason: 'pattern: Instagram',    pattern: /instagram/i },
  { canonical: 'stackoverflow_url',confidence:0.98, reason: 'pattern: Stack Overflow',pattern: /stack.?overflow/i },
  { canonical: 'behance_url',     confidence: 0.98, reason: 'pattern: Behance',      pattern: /behance/i },
  { canonical: 'dribbble_url',    confidence: 0.98, reason: 'pattern: Dribbble',     pattern: /dribbble/i },
  { canonical: 'portfolio_url',   confidence: 0.93, reason: 'pattern: portfolio/personal website',
    pattern: /portfolio|personal.?website|personal.?site|personal.?page/i },
  { canonical: 'website_url',     confidence: 0.82, reason: 'pattern: website/URL',
    pattern: /\bwebsite\b|\bweb.?page\b|\burl\b|\blink\b/i,
    negativePattern: /linkedin|github|twitter|portfolio|instagram|company|job.?post/i },

  // ── Preferences / misc ───────────────────────────────────────────────────────
  { canonical: 'tshirt_size',          confidence: 0.98, reason: 'pattern: t-shirt size',          pattern: /t.?shirt|shirt.?size/i },
  { canonical: 'dietary_restrictions', confidence: 0.96, reason: 'pattern: dietary',               pattern: /dietary|food.?restrict|vegetarian|vegan|allerg|kosher|halal/i },
  { canonical: 'timezone',             confidence: 0.95, reason: 'pattern: timezone',              pattern: /time.?zone|tz\b/i },
  { canonical: 'location_preference',  confidence: 0.88, reason: 'pattern: remote/office preference', pattern: /remote|on.?site|hybrid|work.?location|office|location.?prefer/i },
  { canonical: 'disability_status',    confidence: 0.95, reason: 'pattern: disability',            pattern: /disability|disabled|accommodation/i },
  { canonical: 'veteran_status',       confidence: 0.95, reason: 'pattern: veteran',               pattern: /veteran|military.?status|armed.?forces/i },
  { canonical: 'race_ethnicity',       confidence: 0.95, reason: 'pattern: race/ethnicity',        pattern: /race\b|ethnicity|ethnic.?background/i },
  { canonical: 'referral_source',      confidence: 0.90, reason: 'pattern: how did you hear',      pattern: /how.*(hear|find|know|learn).*(about|us|role|position|company)/i },

  // ── Skills (textarea context) ────────────────────────────────────────────────
  { canonical: 'skills', confidence: 0.88, reason: 'pattern: skills (textarea)',
    pattern: /\bskills?\b|technical.?skills?|core.?competenc/i,
    requiresTextarea: true },
  { canonical: 'skills_summary', confidence: 0.85, reason: 'pattern: skills summary',
    pattern: /\bskills?\b|technical.?skills?/i },
];

// ─────────────────────────────────────────────────────────────────────────────
// Rule evaluation
// ─────────────────────────────────────────────────────────────────────────────

interface RuleMatch {
  canonical: string;
  confidence: number;
  reason: string;
}

function ruleMatch(sig: FieldSignature): RuleMatch | null {
  const combined = combine(sig);
  const ac = sig.autocomplete.toLowerCase().trim();

  for (const rule of RULES) {
    // requiresTextarea guard
    if (rule.requiresTextarea && sig.inputType !== 'textarea'
        && !(sig.inputType === 'ax-textbox' && sig.element?.getAttribute('aria-multiline') === 'true')) continue;

    let matched = false;

    // Autocomplete attribute check
    if (rule.autocomplete) {
      const acceptable = Array.isArray(rule.autocomplete)
        ? rule.autocomplete
        : [rule.autocomplete];
      if (acceptable.includes(ac)) matched = true;
    }

    // Input type check
    if (!matched && rule.inputType) {
      matched = sig.inputType === rule.inputType;
    }

    // Text pattern check
    if (!matched && rule.pattern) {
      matched = rule.pattern.test(combined);
    }

    if (!matched) continue;

    // Negative guard
    if (rule.negativePattern && rule.negativePattern.test(combined)) continue;

    return { canonical: rule.canonical, confidence: rule.confidence, reason: rule.reason };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1.5: Option-set classification
// ─────────────────────────────────────────────────────────────────────────────
//
// The label is the primary signal in Step 4 rules, but it can be misleading:
//   "Are you legally authorized to work in the country..."  ← contains "country"
//                                                              but is yes/no
// The dropdown's option set is a more reliable signal in these cases. When
// the option list is decisive — only [Yes, No]; 200 country names; degree
// aliases; etc. — force the canonical_key from the options.
//
// Sources: sig.options is populated by detector.ts for native <select> and
// for ARIA listboxes that are already in the DOM. For widgets that lazy-
// mount their panel on click, sig.options is undefined and this step bails;
// rules + Step 6 LLM verification (Phase B) cover those.

/** Categorical canonical_keys whose value-aliases tables are dense enough to use for option-set classification. */
const OPTION_SET_KEYS = ['gender', 'degree', 'education_level', 'employment_type', 'work_authorization'] as const;

function classifyByOptionSet(sig: FieldSignature, profile: ProfileEntry[]): MatchResult | null {
  const opts = sig.options;
  if (!opts || opts.length === 0) return null;

  // Guard: if the label clearly identifies this as a city / location field,
  // don't override with option-set classification. Prevents "Preferred Location"
  // from being classified as 'country' because UK/USA appear in the option list.
  const combinedLabel = combine(sig).toLowerCase();
  if (/preferred.{0,10}location|current.{0,10}location|work.{0,10}city|home.{0,10}city|base.{0,10}location/i
      .test(combinedLabel)) {
    return null;
  }

  const trimmedLower = opts
    .map(o => o.trim().toLowerCase())
    .filter(o => o.length > 0);
  if (trimmedLower.length === 0) return null;

  const combined = combine(sig).toLowerCase();

  // ── (a) Yes/No detection ───────────────────────────────────────────────
  // Exactly 2 options, both literal "yes"/"no". Disambiguate yes_no vs.
  // work_authorization by looking for work-context keywords in the label.
  if (
    trimmedLower.length === 2 &&
    trimmedLower.every(o => o === 'yes' || o === 'no') &&
    new Set(trimmedLower).size === 2
  ) {
    const isWorkAuth = /\b(work|authoriz|eligible|visa|sponsor|legal(ly)?)\b/.test(combined);
    const canonical = isWorkAuth ? 'work_authorization' : 'yes_no';
    return finalizeOptionSetMatch(canonical, profile, `option-set: Yes/No${isWorkAuth ? ' + work context' : ''}`);
  }

  // ── (b) Country picker ─────────────────────────────────────────────────
  // 50+ options where ≥ 70% resolve to known countries.
  if (opts.length >= 50) {
    let countryHits = 0;
    for (const o of opts) {
      if (resolveCountry(o)) countryHits++;
    }
    if (countryHits / opts.length >= 0.7) {
      const isCallingCode = sig.inputType === 'tel' || /phone|dial|calling[- ]?code/.test(combined);
      const canonical = isCallingCode ? 'phone_country_code' : 'country';
      return finalizeOptionSetMatch(canonical, profile, `option-set: ${countryHits}/${opts.length} country names`);
    }
  }

  // ── (c) Categorical alias-table hit ───────────────────────────────────
  // For each aliased canonical_key (gender, degree, etc.), count how many
  // options match at least one alias for that key. The key with the highest
  // hit ratio ≥ 0.5 wins.
  let bestKey: string | null = null;
  let bestRatio = 0;
  for (const key of OPTION_SET_KEYS) {
    if (!hasValueAliases(key)) continue;
    let hits = 0;
    for (const o of opts) {
      // expandValueAliases returns [value] for unrecognized inputs and a
      // longer alias array for recognized ones. length > 1 means the option
      // matched a known group for this key.
      if (expandValueAliases(key, o).length > 1) hits++;
    }
    const ratio = hits / opts.length;
    if (ratio > bestRatio && ratio >= 0.5) {
      bestRatio = ratio;
      bestKey = key;
    }
  }
  if (bestKey) {
    return finalizeOptionSetMatch(
      bestKey,
      profile,
      `option-set: ${Math.round(bestRatio * 100)}% match alias table for "${bestKey}"`
    );
  }

  return null;
}

function finalizeOptionSetMatch(
  canonical: string,
  profile: ProfileEntry[],
  reason: string
): MatchResult {
  const entry = findDefaultEntry(profile, canonical);
  if (entry) {
    return {
      status: 'MATCHED',
      profileEntryId: entry.id,
      confidence: 0.95,
      reason,
      matchStep: 0,
      alternativeCount: findAllValidEntries(profile, canonical).length,
    };
  }
  return {
    status: 'UNKNOWN',
    reason: `${reason} but no valid profile entry for "${canonical}"`,
    matchStep: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File upload classification
// ─────────────────────────────────────────────────────────────────────────────

const RESUME_PATTERN = /\bresume\b|\bcv\b|\bcurriculum[-_\s]*vitae\b/i;
const COVER_LETTER_PATTERN = /\bcover[-_\s]?letter\b|\bmotivation[-_\s]?letter\b|\bletter[-_\s]?of[-_\s]?(motivation|interest|intent)\b/i;
const IMAGE_ONLY_PATTERN = /^image\//;

function findSectionLabel(el: HTMLElement): string {
  let node: HTMLElement | null = el.parentElement;
  for (let depth = 0; depth < 6 && node; depth++) {
    for (let sib: Element | null = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      const text = sib.textContent?.trim() ?? '';
      if (text.length > 0 && text.length < 80) return text;
    }
    const heading = node.querySelector('h1, h2, h3, h4, h5, h6, legend, strong, [class*="label"]');
    if (heading && !heading.querySelector('input, textarea, select')) {
      const text = heading.textContent?.trim() ?? '';
      if (text.length > 0 && text.length < 80) return text;
    }
    node = node.parentElement;
  }
  return '';
}

function classifyFileField(sig: FieldSignature): MatchResult {
  const combined = combine(sig);
  const accept = sig.accept ?? '';

  // Image-only inputs (profile photos, avatars) — skip
  if (accept && IMAGE_ONLY_PATTERN.test(accept) && !(/\.pdf|\.doc/i.test(accept))) {
    return { status: 'SKIP', reason: 'image-only file input (photo/avatar)' };
  }

  // Check combined field signals + ancestor section headings
  const sectionLabel = sig.element ? findSectionLabel(sig.element) : '';
  const allText = combined + ' ' + sectionLabel;

  let docType: DocumentType | null = null;
  let confidence = 0;
  let reason = '';

  // Test cover letter FIRST — "Cover Letter" contains "letter" but not "resume"
  if (COVER_LETTER_PATTERN.test(allText)) {
    docType = 'cover_letter';
    confidence = 0.95;
    reason = 'file field: cover letter pattern matched';
  } else if (RESUME_PATTERN.test(allText)) {
    docType = 'resume';
    confidence = 0.95;
    reason = 'file field: resume/CV pattern matched';
  }
  // No blind fallback — if we can't tell the type, don't guess

  if (!docType) {
    return { status: 'UNKNOWN', reason: 'file input with no document-type signal' };
  }

  return {
    status: 'FILE_UPLOAD',
    docType,
    confidence,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Combine all text signals into one searchable string. */
function combine(sig: FieldSignature): string {
  return [
    sig.label,
    sig.placeholder,
    sig.ariaLabel,
    sig.name,
    sig.id,
    sig.surroundingText,
  ]
    .filter(Boolean)
    .join(' ');
}

/** djb2 hash — fast, no crypto dependency needed. */
function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return (hash >>> 0).toString(16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports (for tests and cache utilities)
// ─────────────────────────────────────────────────────────────────────────────

export { combine, djb2 };
