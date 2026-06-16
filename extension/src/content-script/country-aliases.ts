/**
 * Country lookup table — used by the combobox filler when the profile value
 * is a country.
 *
 * Modern form vendors (Greenhouse, Workday, Lever, Ashby) render country
 * pickers as custom comboboxes. The user may have stored "India" in their
 * profile, but the dropdown option might be "India +91", "🇮🇳 India", or
 * just "+91". We try every alias against the visible options.
 *
 * Coverage: top 60 countries by job-application volume. Easy to extend.
 */

export interface CountryAliases {
  /** Canonical English name */
  name: string;
  /** ISO 3166-1 alpha-2 (e.g. IN, US) */
  iso2: string;
  /** International dialling prefix without `+` (e.g. 91, 1, 44) */
  callingCode: string;
}

const COUNTRIES: CountryAliases[] = [
  { name: 'India',                iso2: 'IN', callingCode: '91'  },
  { name: 'United States',        iso2: 'US', callingCode: '1'   },
  { name: 'United Kingdom',       iso2: 'GB', callingCode: '44'  },
  { name: 'Canada',               iso2: 'CA', callingCode: '1'   },
  { name: 'Australia',            iso2: 'AU', callingCode: '61'  },
  { name: 'Germany',              iso2: 'DE', callingCode: '49'  },
  { name: 'France',               iso2: 'FR', callingCode: '33'  },
  { name: 'Spain',                iso2: 'ES', callingCode: '34'  },
  { name: 'Italy',                iso2: 'IT', callingCode: '39'  },
  { name: 'Netherlands',          iso2: 'NL', callingCode: '31'  },
  { name: 'Ireland',              iso2: 'IE', callingCode: '353' },
  { name: 'Poland',               iso2: 'PL', callingCode: '48'  },
  { name: 'Sweden',               iso2: 'SE', callingCode: '46'  },
  { name: 'Norway',               iso2: 'NO', callingCode: '47'  },
  { name: 'Denmark',              iso2: 'DK', callingCode: '45'  },
  { name: 'Finland',              iso2: 'FI', callingCode: '358' },
  { name: 'Switzerland',          iso2: 'CH', callingCode: '41'  },
  { name: 'Austria',              iso2: 'AT', callingCode: '43'  },
  { name: 'Belgium',              iso2: 'BE', callingCode: '32'  },
  { name: 'Portugal',             iso2: 'PT', callingCode: '351' },
  { name: 'Czech Republic',       iso2: 'CZ', callingCode: '420' },
  { name: 'Greece',               iso2: 'GR', callingCode: '30'  },
  { name: 'Hungary',              iso2: 'HU', callingCode: '36'  },
  { name: 'Romania',              iso2: 'RO', callingCode: '40'  },
  { name: 'Ukraine',              iso2: 'UA', callingCode: '380' },
  { name: 'Russia',               iso2: 'RU', callingCode: '7'   },
  { name: 'Turkey',               iso2: 'TR', callingCode: '90'  },
  { name: 'Israel',               iso2: 'IL', callingCode: '972' },
  { name: 'Saudi Arabia',         iso2: 'SA', callingCode: '966' },
  { name: 'United Arab Emirates', iso2: 'AE', callingCode: '971' },
  { name: 'South Africa',         iso2: 'ZA', callingCode: '27'  },
  { name: 'Nigeria',              iso2: 'NG', callingCode: '234' },
  { name: 'Kenya',                iso2: 'KE', callingCode: '254' },
  { name: 'Egypt',                iso2: 'EG', callingCode: '20'  },
  { name: 'Morocco',              iso2: 'MA', callingCode: '212' },
  { name: 'Brazil',               iso2: 'BR', callingCode: '55'  },
  { name: 'Mexico',               iso2: 'MX', callingCode: '52'  },
  { name: 'Argentina',            iso2: 'AR', callingCode: '54'  },
  { name: 'Chile',                iso2: 'CL', callingCode: '56'  },
  { name: 'Colombia',             iso2: 'CO', callingCode: '57'  },
  { name: 'Peru',                 iso2: 'PE', callingCode: '51'  },
  { name: 'China',                iso2: 'CN', callingCode: '86'  },
  { name: 'Japan',                iso2: 'JP', callingCode: '81'  },
  { name: 'South Korea',          iso2: 'KR', callingCode: '82'  },
  { name: 'Taiwan',               iso2: 'TW', callingCode: '886' },
  { name: 'Hong Kong',            iso2: 'HK', callingCode: '852' },
  { name: 'Singapore',            iso2: 'SG', callingCode: '65'  },
  { name: 'Malaysia',             iso2: 'MY', callingCode: '60'  },
  { name: 'Indonesia',            iso2: 'ID', callingCode: '62'  },
  { name: 'Thailand',             iso2: 'TH', callingCode: '66'  },
  { name: 'Vietnam',              iso2: 'VN', callingCode: '84'  },
  { name: 'Philippines',          iso2: 'PH', callingCode: '63'  },
  { name: 'Pakistan',             iso2: 'PK', callingCode: '92'  },
  { name: 'Bangladesh',           iso2: 'BD', callingCode: '880' },
  { name: 'Sri Lanka',            iso2: 'LK', callingCode: '94'  },
  { name: 'Nepal',                iso2: 'NP', callingCode: '977' },
  { name: 'New Zealand',          iso2: 'NZ', callingCode: '64'  },
];

/**
 * Resolve a user-supplied country string to its canonical record.
 * Accepts any of: name (case-insensitive), ISO2 ("IN"), calling code
 * with or without `+` ("+91", "91"), emoji-prefixed names ("🇮🇳 India"),
 * and name+code combos ("India +91", "🇮🇳 India +91").
 */
export function resolveCountry(input: string): CountryAliases | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // Fast path: direct lookups (name, ISO2, calling code)
  const lo = raw.toLowerCase();
  const noPlus = lo.replace(/^\+/, '');
  for (const c of COUNTRIES) {
    if (c.name.toLowerCase() === lo) return c;
    if (c.iso2.toLowerCase()  === lo) return c;
    if (c.callingCode         === noPlus) return c;
  }

  // Normalizing path: strip emoji flag prefix and/or trailing calling-code suffix.
  // Handles: "🇮🇳 India +91" → "India", "India +91" → "India", "🇮🇳 India" → "India"
  let stripped = raw;
  stripped = stripped.replace(/^[\u{1F1E0}-\u{1F1FF}]{2}\s*/u, '').trim();  // strip flag emoji
  stripped = stripped.replace(/\s*\+\d{1,4}\s*$/, '').trim();               // strip +NNN suffix
  if (stripped && stripped !== raw) {
    const strLo = stripped.toLowerCase();
    for (const c of COUNTRIES) {
      if (c.name.toLowerCase() === strLo) return c;
      if (c.iso2.toLowerCase()  === strLo) return c;
    }
  }

  return null;
}

/**
 * Given a profile value (e.g. "India") return every plausible string the
 * dropdown might show, so we can try matching each:
 *   ["India", "IN", "91", "+91", "🇮🇳 India", ...]
 */
export function expandCountryAliases(value: string): string[] {
  const c = resolveCountry(value);
  if (!c) return [value];

  return [
    c.name,
    c.iso2,
    c.callingCode,
    `+${c.callingCode}`,
    `${c.name} +${c.callingCode}`,
    `${c.name} (${c.iso2})`,
  ];
}
