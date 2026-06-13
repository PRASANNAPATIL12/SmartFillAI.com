/**
 * Field Matcher — Waterfall Steps 1–4 (deterministic, local, zero network calls).
 *
 * Step 1: SKIP  — exclude fields we should never touch
 * Step 2: CACHE — domain+fingerprint → known match (fast path)
 * Step 3: ESSAY — detect long-form AI-generation candidates
 * Step 4: RULES — autocomplete attr → inputType → text patterns (200+ rules)
 *
 * Steps 5 (embedding) and 6 (LLM batch) are added in later tasks.
 *
 * Pure function: no storage I/O, no API calls, no side effects.
 */

import type { FieldSignature, MatchResult, ProfileEntry, FieldCacheEntry } from '@shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match a single field against the user's profile.
 *
 * @param sig     Extracted field signature
 * @param profile User's profile entries
 * @param cache   Domain-level cache (empty Map is fine on first visit)
 * @param domain  Current page hostname (for cache fingerprint)
 */
export function matchField(
  sig: FieldSignature,
  profile: ProfileEntry[],
  cache: Map<string, FieldCacheEntry>,
  domain: string
): MatchResult {
  // Step 1: SKIP
  const skipReason = shouldSkip(sig);
  if (skipReason) return { status: 'SKIP', reason: skipReason };

  // Step 2: Cache lookup
  const cached = cacheMatch(sig, cache, domain);
  if (cached) return cached;

  // Step 3: Essay detection
  if (isEssay(sig)) return { status: 'ESSAY', reason: 'essay field detected', matchStep: 3 };

  // Step 4: Deterministic rules
  const rule = ruleMatch(sig);
  if (rule) {
    const entry = profile.find(p => p.canonical_key === rule.canonical);
    if (entry) {
      return {
        status: 'MATCHED',
        profileEntryId: entry.id,
        confidence: rule.confidence,
        reason: rule.reason,
        matchStep: 4,
      };
    }
    // We know what it IS, but the user hasn't filled that profile entry yet
    return {
      status: 'UNKNOWN',
      reason: `rule matched canonical "${rule.canonical}" but no profile entry exists`,
      matchStep: 4,
    };
  }

  return { status: 'UNKNOWN', reason: 'no rule matched' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: SKIP
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_TYPES = new Set(['password', 'hidden', 'file', 'submit', 'button', 'reset', 'image', 'color', 'range']);

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

  // Honeypot fields (hidden via CSS but not type="hidden") — skip to avoid detection
  if (sig.element && isHoneypot(sig.element)) return 'honeypot field';

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
  if (sig.inputType !== 'textarea') return false;
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
  { canonical: 'country',        confidence: 0.99, reason: 'autocomplete=country',         autocomplete: ['country', 'country-name'] },
  { canonical: 'date_of_birth',  confidence: 0.99, reason: 'autocomplete=bday',            autocomplete: ['bday', 'bday-day', 'bday-month', 'bday-year'] },
  { canonical: 'gender',         confidence: 0.99, reason: 'autocomplete=sex',             autocomplete: 'sex' },
  { canonical: 'website_url',    confidence: 0.92, reason: 'autocomplete=url',             autocomplete: 'url' },

  // ── Input type signals ───────────────────────────────────────────────────────
  { canonical: 'email',        confidence: 0.98, reason: 'type=email',                    inputType: 'email' },
  { canonical: 'phone_number', confidence: 0.97, reason: 'type=tel',                      inputType: 'tel' },
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
    negativePattern: /interview|screen|call.?to.?action/i },
  { canonical: 'phone_number', confidence: 0.90, reason: 'pattern: contact number',
    pattern: /contact.?number|reach.?you/i },

  // ── Address ──────────────────────────────────────────────────────────────────
  { canonical: 'street_address', confidence: 0.96, reason: 'pattern: street/address line',
    pattern: /street|address.?line|addr.?line|\baddress\b/i,
    negativePattern: /\bemail\b|\bweb\b|url|github|linkedin/i },
  { canonical: 'address_line2', confidence: 0.97, reason: 'pattern: address line 2',
    pattern: /address.?line.?2|apt|suite|unit\b|floor\b|building/i },
  { canonical: 'city', confidence: 0.95, reason: 'pattern: city',
    pattern: /\bcity\b|\btown\b|\blocality\b|\bmunicipality\b/i },
  { canonical: 'state', confidence: 0.94, reason: 'pattern: state/province',
    pattern: /\bstate\b|\bprovince\b|\bregion\b|\bprefecture\b/i,
    negativePattern: /status|statement|university|college/i },
  { canonical: 'zip_code', confidence: 0.97, reason: 'pattern: zip/postal code',
    pattern: /\bzip\b|postal.?code|post.?code|pincode|pin.?code/i },
  { canonical: 'country', confidence: 0.95, reason: 'pattern: country',
    pattern: /\bcountry\b|\bnation\b/i,
    negativePattern: /nationality|citizenship/i },

  // ── Identity ─────────────────────────────────────────────────────────────────
  { canonical: 'date_of_birth', confidence: 0.97, reason: 'pattern: date of birth',
    pattern: /date.?of.?birth|birth.?date|\bdob\b|\bbirthday\b|born.?on/i },
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
    if (rule.requiresTextarea && sig.inputType !== 'textarea') continue;

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
