import type { FieldSignature } from '@shared/types';

export type SerializableFieldSig = Omit<FieldSignature, 'element'>;

// HTML autocomplete token → canonical_key (empty string = sensitive, never learn)
const AUTOCOMPLETE_MAP: Record<string, string> = {
  'email':           'email',
  'given-name':      'first_name',
  'family-name':     'last_name',
  'name':            'full_name',
  'additional-name': 'middle_name',
  'honorific-prefix':'prefix',
  'honorific-suffix':'suffix',
  'tel':             'phone_number',
  'tel-national':    'phone_number',
  'tel-local':       'phone_number',
  'organization':    'company',
  'street-address':  'address_line1',
  'address-line1':   'address_line1',
  'address-line2':   'address_line2',
  'postal-code':     'zip_code',
  'address-level1':  'state',
  'address-level2':  'city',
  'country':             'country',
  'country-name':        'country',
  'tel-country-code':    'phone_country_code',
  'bday':            'date_of_birth',
  'url':             'website',
  'username':        'username',
  'nickname':        'username',
  'language':        'language',
  'sex':             'gender',
  // Sensitive — never learn
  'current-password':     '',
  'new-password':         '',
  'cc-number':            '',
  'cc-csc':               '',
};

// Text pattern → canonical_key (empty string = sensitive, never learn)
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // Sensitive first (must match before generic patterns)
  [/\bpassword\b|\bpasswd\b/i,                              ''],
  [/\bssn\b|\bsocial.?security\b/i,                        ''],
  [/\bcredit.?card\b|\bcard.?num/i,                        ''],
  [/\bcvv\b|\bcvc\b|\bcard.?security/i,                    ''],
  // Standard fields
  [/\bemail\b/i,                                            'email'],
  [/\bfirst.?name\b|\bgiven.?name\b/i,                     'first_name'],
  [/\blast.?name\b|\bfamily.?name\b|\bsurname\b/i,         'last_name'],
  [/\bfull.?name\b/i,                                       'full_name'],
  [/\bmiddle.?name\b/i,                                     'middle_name'],
  [/\bphone\b|\btelephone\b|\bmobile\b|\bcel[^l]/i,        'phone_number'],
  [/\bcompany\b|\borganiz\b|\bemployer\b/i,                'company'],
  [/\baddress.?(line.?)?2\b|\bapt\b|\bsuite\b|\bunit\b/i,  'address_line2'],
  [/\baddress\b|\bstreet\b/i,                               'address_line1'],
  [/\bzip\b|\bpostal\b/i,                                   'zip_code'],
  [/\bcity\b|\blocality\b/i,                                'city'],
  [/\bstate\b|\bprovince\b|\bregion\b/i,                   'state'],
  [/dial.?code|calling.?code|phone.?country/i,              'phone_country_code'],
  [/\bcountry\b/i,                                          'country'],
  [/\blinkedin\b/i,                                         'linkedin_url'],
  [/\bgithub\b/i,                                           'github_url'],
  [/\btwitter\b|\bx\.com\b/i,                              'twitter_handle'],
  [/\bwebsite\b|\bportfolio\b|\bhomepage\b/i,              'website'],
  [/\bdate.?of.?birth\b|\bbirth.?date\b|\bdob\b|\bbirthday\b/i, 'date_of_birth'],
  [/\bgpa\b/i,                                              'gpa'],
  [/\buniversity\b|\bcollege\b|\binstitution\b/i,           'university'],
  [/\bdegree\b|\bmajor\b|\bfield.?of.?study\b/i,           'degree'],
  [/\bjob.?title\b|\bposition\b|\brole\b/i,                'job_title'],
  [/\bskill\b/i,                                            'skills'],
  [/\bsummary\b|\bstatement\b|\bpersonal.?bio\b/i,         'personal_statement'],
  [/\bgender\b|\bsex\b/i,                                   'gender'],
  [/\blanguage\b/i,                                         'language'],
  [/\busername\b|\buser.?name\b|\bnickname\b/i,             'username'],
];

const CATEGORY_MAP: Record<string, string> = {
  email: 'contact', phone_number: 'contact', phone_country_code: 'contact',
  address_line1: 'contact', address_line2: 'contact',
  city: 'contact', state: 'contact', zip_code: 'contact', country: 'contact',
  first_name: 'identity', last_name: 'identity', full_name: 'identity',
  middle_name: 'identity', date_of_birth: 'identity', gender: 'identity',
  prefix: 'identity', suffix: 'identity',
  university: 'education', degree: 'education', gpa: 'education',
  company: 'work', job_title: 'work',
  linkedin_url: 'social', github_url: 'social',
  twitter_handle: 'social', website: 'social',
};

/**
 * Returns the inferred canonical_key, '' if the field is sensitive (skip),
 * or null if no standard key could be identified (use sanitized fallback).
 */
export function inferCanonicalKey(sig: SerializableFieldSig): string | null {
  // 1. Autocomplete attribute — most authoritative
  const ac = sig.autocomplete?.trim().toLowerCase();
  if (ac && ac !== 'on' && ac !== 'off') {
    // "section-billing email" → check each token right-to-left
    const tokens = ac.split(/\s+/).reverse();
    for (const token of tokens) {
      if (token in AUTOCOMPLETE_MAP) {
        return AUTOCOMPLETE_MAP[token]; // may be ''
      }
    }
  }

  // 2. Pattern-match across all label-like attributes
  const searchText = [sig.label, sig.ariaLabel, sig.placeholder, sig.name, sig.id]
    .filter(Boolean)
    .join(' ');

  for (const [pattern, key] of TEXT_PATTERNS) {
    if (pattern.test(searchText)) {
      return key; // may be ''
    }
  }

  return null; // no standard match
}

export function inferCategory(canonicalKey: string): string {
  return CATEGORY_MAP[canonicalKey] ?? 'other';
}

export function inferDisplayLabel(sig: SerializableFieldSig): string {
  const raw = sig.label || sig.ariaLabel || sig.placeholder || sig.name || sig.id || 'Learned Field';
  // Capitalize first letter, trim whitespace, cap at 60 chars
  const clean = raw.trim().replace(/^./, c => c.toUpperCase());
  return clean.slice(0, 60);
}

// Known country names lookup table (subset — covers top 60 by app volume).
// Used by normalizeFieldValue without DOM access so it can run in the background SW.
const COUNTRY_NAMES: string[] = [
  'India','United States','United Kingdom','Canada','Australia','Germany','France','Spain',
  'Italy','Netherlands','Ireland','Poland','Sweden','Norway','Denmark','Finland','Switzerland',
  'Austria','Belgium','Portugal','Czech Republic','Greece','Hungary','Romania','Ukraine',
  'Russia','Turkey','Israel','Saudi Arabia','United Arab Emirates','South Africa','Nigeria',
  'Kenya','Egypt','Morocco','Brazil','Mexico','Argentina','Chile','Colombia','Peru',
  'China','Japan','South Korea','Taiwan','Hong Kong','Singapore','Malaysia','Indonesia',
  'Thailand','Vietnam','Philippines','Pakistan','Bangladesh','Sri Lanka','Nepal','New Zealand',
];

/**
 * Normalize a learned value for country/phone_country_code fields.
 * Strips emoji flag prefixes and calling-code suffixes, then resolves
 * to the canonical English country name when possible.
 *
 * Examples:
 *   "🇮🇳 India +91" → "India"
 *   "India +91"    → "India"
 *   "🇮🇳 India"    → "India"
 *   "+91"          → "+91"  (raw calling codes kept as-is)
 *   "United States" → "United States"
 */
export function normalizeFieldValue(canonicalKey: string, value: string): string {
  if (canonicalKey !== 'country' && canonicalKey !== 'phone_country_code') return value;

  let v = value.trim();
  if (!v) return value;

  // Strip leading emoji flag (2 regional indicator codepoints, each U+1F1E0–U+1F1FF)
  v = v.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim();

  // Strip trailing calling-code suffix " +NNN"
  v = v.replace(/\s*\+\d{1,4}\s*$/, '').trim();

  if (!v) return value;

  // Resolve to canonical country name (case-insensitive)
  const lo = v.toLowerCase();
  const match = COUNTRY_NAMES.find(n => n.toLowerCase() === lo);
  return match ?? v;
}
