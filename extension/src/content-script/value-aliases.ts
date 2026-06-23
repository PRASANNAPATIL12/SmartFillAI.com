/**
 * Value alias tables — analog of country-aliases.ts for the other canonical
 * keys whose dropdown options vary wildly across job portals.
 *
 * Same problem statement: the user stores `"Bachelor's Degree"` in their
 * profile, but the dropdown option might be `"B.Tech"`, `"BE"`, `"BSc"`,
 * or `"Undergraduate"`. Without expansion, the option-text comparison in
 * fillSelect / fillCombobox / fillButtonDropdown never matches.
 *
 * Scope (Phase 1 — Standard 7 keys):
 *   gender, degree, work_authorization, employment_type,
 *   education_level, yes_no, years_of_experience.
 *
 * The shape mirrors country-aliases: a fixed table of `AliasGroup`s per key,
 * plus an `expandValueAliases(canonicalKey, value)` function that finds the
 * matching group and returns all of its aliases. If no group matches, the
 * caller falls back to `[value]` (existing behavior preserved).
 */

export interface AliasGroup {
  /** Canonical, user-friendly form (returned first in the expansion). */
  canonical: string;
  /** Every plausible string a dropdown might show for this concept. */
  aliases: string[];
}

const GENDER: AliasGroup[] = [
  {
    canonical: 'Male',
    aliases: ['Male', 'M', 'Masculine', 'Man'],
  },
  {
    canonical: 'Female',
    aliases: ['Female', 'F', 'Feminine', 'Woman'],
  },
  {
    canonical: 'Non-binary',
    aliases: ['Non-binary', 'Nonbinary', 'Non binary', 'NB', 'Genderqueer', 'Genderfluid', 'X', 'Other'],
  },
  {
    canonical: 'Prefer not to say',
    aliases: [
      'Prefer not to say',
      'Decline to state',
      'Decline to answer',
      'Decline to self-identify',
      'I do not wish to answer',
      'Not specified',
      'Undisclosed',
    ],
  },
];

const DEGREE: AliasGroup[] = [
  {
    canonical: "Bachelor's Degree",
    aliases: [
      "Bachelor's Degree",
      "Bachelor's",
      'Bachelor',
      'Bachelors',
      'BS', 'B.S.', 'B.S',
      'BA', 'B.A.', 'B.A',
      'BSc', 'B.Sc.', 'B.Sc',
      'BE',  'B.E.',  'B.E',
      'B.Tech', 'BTech', 'B Tech',
      'BBA', 'B.B.A.',
      'BCA', 'B.C.A.',
      'Bachelor of Science',
      'Bachelor of Arts',
      'Bachelor of Engineering',
      'Bachelor of Technology',
      'Bachelor of Commerce',
      'Bachelor of Business Administration',
      'Undergraduate',
      'Undergraduate Degree',
    ],
  },
  {
    canonical: "Master's Degree",
    aliases: [
      "Master's Degree",
      "Master's",
      'Master',
      'Masters',
      'MS', 'M.S.', 'M.S',
      'MA', 'M.A.', 'M.A',
      'MSc', 'M.Sc.', 'M.Sc',
      'ME', 'M.E.',
      'M.Tech', 'MTech', 'M Tech',
      'MBA', 'M.B.A.',
      'MCA', 'M.C.A.',
      'Master of Science',
      'Master of Arts',
      'Master of Engineering',
      'Master of Technology',
      'Master of Business Administration',
      'Graduate',
      'Graduate Degree',
      'Postgraduate',
      'Postgraduate Degree',
    ],
  },
  {
    canonical: 'Doctorate',
    aliases: [
      'Doctorate',
      'Doctoral',
      'Doctoral Degree',
      'PhD', 'Ph.D.', 'Ph.D', 'PhD.',
      'Doctor',
      'Doctor of Philosophy',
      'D.Phil.', 'DPhil',
    ],
  },
  {
    canonical: "Associate's Degree",
    aliases: [
      "Associate's Degree",
      "Associate's",
      'Associate',
      'Associates',
      'AA', 'A.A.',
      'AS', 'A.S.',
      'AAS', 'A.A.S.',
      'Associate of Arts',
      'Associate of Science',
      '2-year Degree',
    ],
  },
  {
    canonical: 'High School',
    aliases: [
      'High School',
      'High School Diploma',
      'HS',
      'High-School',
      'Highschool',
      'Diploma',
      'Secondary',
      'Secondary School',
      'Secondary Education',
      'GED',
      '12th', '12th Grade', '12th Pass',
      'Higher Secondary',
      'Higher Secondary School',
      'HSC',
      'A-Levels',
    ],
  },
];

// education_level overlaps strongly with degree — same answer set, just framed
// as "what level have you reached" rather than "what credential do you hold".
// Reusing the table avoids drift between the two.
const EDUCATION_LEVEL: AliasGroup[] = DEGREE;

const WORK_AUTHORIZATION: AliasGroup[] = [
  {
    canonical: 'US Citizen',
    aliases: [
      'US Citizen',
      'U.S. Citizen',
      'USC',
      'United States Citizen',
      'American Citizen',
      'Citizen',
      'Yes - US Citizen',
      'Yes, US Citizen',
      'I am a US Citizen',
    ],
  },
  {
    canonical: 'Green Card',
    aliases: [
      'Green Card',
      'Green Card Holder',
      'Permanent Resident',
      'US Permanent Resident',
      'Lawful Permanent Resident',
      'PR',
      'LPR',
      'GC',
    ],
  },
  {
    canonical: 'H1B Visa',
    aliases: [
      'H1B', 'H-1B', 'H1-B',
      'H1B Visa',
      'H-1B Visa',
      'Visa Holder',
      'On Visa',
      'Visa sponsorship required',
      'Need sponsorship',
      'Require sponsorship',
      'Will require sponsorship',
      'Yes - I need sponsorship',
    ],
  },
  {
    canonical: 'OPT/EAD',
    aliases: [
      'OPT', 'EAD',
      'F-1', 'F1',
      'F-1 OPT',
      'F1 OPT',
      'Optional Practical Training',
      'Employment Authorization Document',
      'STEM OPT',
    ],
  },
  {
    canonical: 'Authorized without sponsorship',
    aliases: [
      'Authorized without sponsorship',
      'No sponsorship needed',
      'Do not require sponsorship',
      'I do not require sponsorship',
      'No - I do not need sponsorship',
      'Authorized to work',
      'Eligible to work',
      'Work permit',
    ],
  },
];

const EMPLOYMENT_TYPE: AliasGroup[] = [
  {
    canonical: 'Full-time',
    aliases: ['Full-time', 'Full time', 'FT', 'Fulltime', 'Permanent', 'Regular', 'Full'],
  },
  {
    canonical: 'Part-time',
    aliases: ['Part-time', 'Part time', 'PT', 'Parttime', 'Part'],
  },
  {
    canonical: 'Contract',
    aliases: [
      'Contract',
      'Contractor',
      'Contracting',
      'C2C', 'Corp-to-Corp', 'Corp to Corp',
      'W2', 'W-2',
      '1099',
      'Freelance',
      'Freelancer',
      'Consultant',
      'Consulting',
    ],
  },
  {
    canonical: 'Internship',
    aliases: ['Internship', 'Intern', 'Co-op', 'Coop', 'Apprentice', 'Apprenticeship', 'Trainee'],
  },
  {
    canonical: 'Temporary',
    aliases: ['Temporary', 'Temp', 'Casual', 'Seasonal'],
  },
];

const YES_NO: AliasGroup[] = [
  {
    canonical: 'Yes',
    aliases: ['Yes', 'Y', 'True', '1', 'Affirmative', 'Agree', 'I agree'],
  },
  {
    canonical: 'No',
    aliases: ['No', 'N', 'False', '0', 'Negative', 'Disagree', 'I disagree'],
  },
];

/**
 * Years-of-experience is a number on our side but a range/bracket on the form.
 * We can't predict every site's bracket layout, but we CAN generate the most
 * common phrasings of a given integer and let `fillSelect`'s partial-
 * containment strategy (Step 3 inside fillSelect) catch ranges that contain
 * the number — e.g. profile "5" expands to "5+ years"; "5-7 years" then
 * matches by containment because "5-7 years".includes("5") is true.
 */
function yearsOfExperienceAliases(value: string): string[] {
  const trimmed = value.trim();
  const n = Number(trimmed.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return [trimmed];

  const intN = Math.floor(n);
  const variants = new Set<string>([
    trimmed,
    String(intN),
    `${intN}`,
    `${intN} year${intN === 1 ? '' : 's'}`,
    `${intN}+`,
    `${intN}+ years`,
    `${intN} or more`,
    `${intN} or more years`,
    `More than ${intN}`,
    `More than ${intN} years`,
    `${intN}-${intN + 2} years`,
    `${intN} to ${intN + 2} years`,
  ]);

  if (intN === 0) {
    variants.add('Less than 1 year');
    variants.add('0-1 years');
    variants.add('Entry level');
    variants.add('Entry-level');
    variants.add('Fresher');
    variants.add('No experience');
  }

  return Array.from(variants);
}

// City name aliases — covers renamed Indian cities (official vs common names)
// and a few international equivalents. Stored as AliasGroup[] so the same
// lookup path works: find the group whose aliases include the stored value,
// return all aliases so both spellings can match the dropdown option.
const CITY: AliasGroup[] = [
  { canonical: 'Bengaluru', aliases: ['Bengaluru', 'Bangalore', 'Bengalooru', 'Bangaluru'] },
  { canonical: 'Mumbai',    aliases: ['Mumbai', 'Bombay'] },
  { canonical: 'Chennai',   aliases: ['Chennai', 'Madras'] },
  { canonical: 'Kolkata',   aliases: ['Kolkata', 'Calcutta', 'Kolkatta'] },
  { canonical: 'Pune',      aliases: ['Pune', 'Poona', 'Puna'] },
  { canonical: 'New Delhi', aliases: ['New Delhi', 'Delhi', 'NCR', 'Delhi NCR'] },
  { canonical: 'Hyderabad', aliases: ['Hyderabad', 'Cyberabad', 'Hitec City'] },
  { canonical: 'Kochi',     aliases: ['Kochi', 'Cochin', 'Ernakulam'] },
  { canonical: 'Thiruvananthapuram', aliases: ['Thiruvananthapuram', 'Trivandrum'] },
  { canonical: 'Vadodara',  aliases: ['Vadodara', 'Baroda'] },
  { canonical: 'Mysuru',    aliases: ['Mysuru', 'Mysore'] },
  { canonical: 'Belagavi',  aliases: ['Belagavi', 'Belgaum'] },
  { canonical: 'Hubballi',  aliases: ['Hubballi', 'Hubli'] },
  // International
  { canonical: 'Beijing',   aliases: ['Beijing', 'Peking'] },
  { canonical: 'Ho Chi Minh City', aliases: ['Ho Chi Minh City', 'Saigon'] },
];

const TABLES: Record<string, AliasGroup[]> = {
  gender:             GENDER,
  degree:             DEGREE,
  education_level:    EDUCATION_LEVEL,
  work_authorization: WORK_AUTHORIZATION,
  employment_type:    EMPLOYMENT_TYPE,
  yes_no:             YES_NO,
  city:               CITY,
  current_location:   CITY,
  preferred_location: CITY,
};

/**
 * Given a profile value, return every plausible alias the dropdown might show
 * for the same concept. Returns `[value]` unchanged when the canonical key
 * has no alias table OR the value doesn't match any known group — preserving
 * existing fillSelect/fillCombobox behavior for unrecognized inputs.
 */
export function expandValueAliases(canonicalKey: string | undefined, value: string): string[] {
  if (!canonicalKey || !value) return [value];

  // Numeric range handling lives in its own branch — the rest are flat lookups.
  if (canonicalKey === 'years_of_experience') return yearsOfExperienceAliases(value);

  const table = TABLES[canonicalKey];
  if (!table) return [value];

  const valLower = value.trim().toLowerCase();
  if (!valLower) return [value];

  for (const group of table) {
    if (group.aliases.some(a => a.toLowerCase() === valLower)) {
      return group.aliases;
    }
  }

  return [value];
}

/**
 * Whether a given canonical_key has a value-alias table. Used by callers
 * that want to know whether expansion is meaningful before invoking it
 * (e.g. country handling, which lives in country-aliases.ts, is separate).
 */
export function hasValueAliases(canonicalKey: string | undefined): boolean {
  if (!canonicalKey) return false;
  if (canonicalKey === 'years_of_experience') return true;
  return canonicalKey in TABLES;
}
