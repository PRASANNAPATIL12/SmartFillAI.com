/**
 * Pre-built ATS field templates — Phase AE.2.
 *
 * On first install (and on version bumps) these templates are seeded into the
 * form_fingerprints IDB store as synthetic FormFingerprint entries. Step 1.6
 * in the matcher then has cross-employer field mappings available from day
 * one, without the user having to fill a Greenhouse form first to bootstrap
 * the cache.
 *
 * Confidence: every template field is stamped at 0.95 — slightly below
 * user-confirmed (1.0) so the merge logic always prefers a real correction
 * over a templated guess.
 *
 * Privacy: templates are identical for all users, so the seeded fingerprints
 * are NEVER pushed to Supabase (gated by source === 'template' in
 * sync-engine.pushFormFingerprints). Only after a real fill promotes them
 * to source = 'learned' do they enter the per-user cloud-sync stream.
 *
 * Coverage philosophy: only include fields the ATS renders by default on
 * every job. Custom employer-added fields (Stripe's "Hometown", Anthropic's
 * "Why us") are out of scope — they fall through to existing tiers (rules,
 * learn-pill, LLM) on first encounter.
 */

import type { AtsDetection } from './company-detector';

/** Stable role tokens used in templates — kept consistent with fieldRole() output. */
export type AtsTemplateRole = 'textbox' | 'combobox' | 'checkbox' | 'radio' | 'file';

export interface AtsTemplateField {
  /** Canonical English label exactly as the ATS renders it on its default form. */
  label: string;
  /**
   * Plausible variants the same ATS uses across employers ("Resume / CV" vs
   * "Resume" vs "Upload Resume"). Each alias becomes its own nameHash entry
   * pointing at the same canonical_key.
   */
  aliases?: string[];
  /** Field role for diagnostic logging — informational, doesn't gate matching. */
  role: AtsTemplateRole;
  /** Canonical profile key the field maps to. Must exist in canonicalKeys.ts. */
  canonicalKey: string;
}

export interface AtsTemplate {
  /** ATS family token — must match what detectAts() returns. */
  atsId: AtsDetection['atsId'];
  /** Bump when the ATS visibly changes its default form layout. */
  version: number;
  fields: AtsTemplateField[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

const GREENHOUSE: AtsTemplate = {
  atsId: 'greenhouse',
  version: 1,
  fields: [
    // Identity
    { label: 'First Name',    aliases: ['Given Name'],          role: 'textbox',  canonicalKey: 'first_name' },
    { label: 'Last Name',     aliases: ['Family Name', 'Surname'], role: 'textbox', canonicalKey: 'last_name' },
    { label: 'Email',         aliases: ['Email Address'],       role: 'textbox',  canonicalKey: 'email' },
    { label: 'Phone',         aliases: ['Phone Number', 'Mobile Phone'], role: 'textbox', canonicalKey: 'phone_number' },
    // Documents
    { label: 'Resume/CV',     aliases: ['Resume', 'CV', 'Upload Resume'], role: 'file', canonicalKey: 'resume' },
    { label: 'Cover Letter',  aliases: ['Cover letter (optional)'], role: 'file', canonicalKey: 'cover_letter' },
    // Web presence
    { label: 'LinkedIn Profile', aliases: ['LinkedIn URL', 'LinkedIn'], role: 'textbox', canonicalKey: 'linkedin_url' },
    { label: 'Website',       aliases: ['Personal Website', 'Web Site'], role: 'textbox', canonicalKey: 'website_url' },
    { label: 'GitHub',        aliases: ['GitHub URL', 'GitHub Profile'], role: 'textbox', canonicalKey: 'github_url' },
    { label: 'Portfolio',     aliases: ['Portfolio URL'],       role: 'textbox',  canonicalKey: 'portfolio_url' },
    // Work
    { label: 'Current Company', aliases: ['Company', 'Employer'], role: 'textbox', canonicalKey: 'current_company' },
    { label: 'Current Title', aliases: ['Job Title', 'Current Position'], role: 'textbox', canonicalKey: 'job_title' },
    // Work authorization (Greenhouse renders these as combobox dropdowns)
    { label: 'Are you legally authorized to work in the United States?',
      aliases: ['Are you legally authorized to work in this country?',
                'Are you legally authorized to work?'],
      role: 'combobox', canonicalKey: 'work_authorization' },
    { label: 'Will you now or in the future require sponsorship for employment visa status?',
      aliases: ['Will you require sponsorship?', 'Visa Sponsorship'],
      role: 'combobox', canonicalKey: 'visa_type' },
    // Compensation & timing
    { label: 'Salary Expectation', aliases: ['Desired Salary', 'Expected Salary', 'Compensation Expectations'],
      role: 'textbox', canonicalKey: 'salary_expectation' },
    { label: 'Notice Period',      aliases: ['Earliest Start Date', 'Availability'],
      role: 'textbox', canonicalKey: 'notice_period' },
    // Source attribution
    { label: 'How did you hear about this job?',
      aliases: ['How did you hear about us?', 'Referral Source'],
      role: 'textbox', canonicalKey: 'referral_source' },
    // Identity & EEO (Greenhouse renders all as combobox)
    { label: 'Pronouns',        role: 'combobox', canonicalKey: 'pronouns' },
    { label: 'Date of Birth',   aliases: ['DOB', 'Birthdate'], role: 'textbox', canonicalKey: 'date_of_birth' },
    { label: 'Gender',          role: 'combobox', canonicalKey: 'gender' },
    { label: 'Race/Ethnicity',  aliases: ['Race', 'Ethnicity'], role: 'combobox', canonicalKey: 'race_ethnicity' },
    { label: 'Are you Hispanic/Latino?',
      aliases: ['Hispanic or Latino'], role: 'combobox', canonicalKey: 'hispanic_latino' },
    { label: 'Veteran Status',  aliases: ['Are you a veteran?'], role: 'combobox', canonicalKey: 'veteran_status' },
    { label: 'Disability Status', aliases: ['Do you have a disability?'], role: 'combobox', canonicalKey: 'disability_status' },
    // Location
    { label: 'Current Location', aliases: ['Where are you located?', 'Current City'], role: 'textbox', canonicalKey: 'current_location' },
    { label: 'Preferred Location', aliases: ['Preferred Work Location'], role: 'textbox', canonicalKey: 'preferred_location' },
  ],
};

const WORKDAY: AtsTemplate = {
  atsId: 'workday',
  version: 1,
  fields: [
    // Identity (Workday calls it "Legal Name")
    { label: 'First Name',     aliases: ['Legal Name First', 'Given Name'], role: 'textbox', canonicalKey: 'first_name' },
    { label: 'Last Name',      aliases: ['Legal Name Last', 'Family Name'], role: 'textbox', canonicalKey: 'last_name' },
    { label: 'Email Address',  aliases: ['Email'], role: 'textbox', canonicalKey: 'email' },
    // Phone (Workday splits country code into separate combobox)
    { label: 'Phone Number',   aliases: ['Mobile Phone Number'], role: 'textbox', canonicalKey: 'phone_number' },
    { label: 'Country Phone Code', aliases: ['Phone Country Code', 'Country Code'], role: 'combobox', canonicalKey: 'phone_country_code' },
    // Address
    { label: 'Address Line 1', aliases: ['Street Address'], role: 'textbox', canonicalKey: 'street_address' },
    { label: 'City',           role: 'textbox', canonicalKey: 'city' },
    { label: 'State',          aliases: ['Province', 'Region'], role: 'combobox', canonicalKey: 'state' },
    { label: 'Postal Code',    aliases: ['Zip Code', 'Zip'], role: 'textbox', canonicalKey: 'zip_code' },
    { label: 'Country',        role: 'combobox', canonicalKey: 'country' },
    // Work
    { label: 'Most Recent Company', aliases: ['Current Company', 'Employer'], role: 'textbox', canonicalKey: 'current_company' },
    { label: 'Most Recent Job Title', aliases: ['Current Title', 'Job Title'], role: 'textbox', canonicalKey: 'job_title' },
    // Education
    { label: 'University',     aliases: ['Institution', 'School'], role: 'textbox', canonicalKey: 'university' },
    { label: 'Degree',         aliases: ['Highest Degree'], role: 'combobox', canonicalKey: 'degree' },
    // Source attribution & misc
    { label: 'How Did You Hear About Us?', aliases: ['How Did You Hear About This Job?'], role: 'combobox', canonicalKey: 'referral_source' },
    { label: 'Are you authorized to work?', aliases: ['Work Authorization'], role: 'combobox', canonicalKey: 'work_authorization' },
    { label: 'Notice Period',  aliases: ['Availability Date'], role: 'textbox', canonicalKey: 'notice_period' },
    { label: 'Earliest Start Date', aliases: ['Start Date'], role: 'textbox', canonicalKey: 'start_date' },
  ],
};

const LEVER: AtsTemplate = {
  atsId: 'lever',
  version: 1,
  fields: [
    { label: 'Full Name',        aliases: ['Name'], role: 'textbox', canonicalKey: 'full_name' },
    { label: 'Email',            aliases: ['Email Address'], role: 'textbox', canonicalKey: 'email' },
    { label: 'Phone',            aliases: ['Phone Number'], role: 'textbox', canonicalKey: 'phone_number' },
    { label: 'Current Company',  aliases: ['Company'], role: 'textbox', canonicalKey: 'current_company' },
    { label: 'Current Location', aliases: ['Location'], role: 'textbox', canonicalKey: 'current_location' },
    { label: 'LinkedIn URL',     aliases: ['LinkedIn Profile'], role: 'textbox', canonicalKey: 'linkedin_url' },
    { label: 'GitHub URL',       aliases: ['GitHub Profile'], role: 'textbox', canonicalKey: 'github_url' },
    { label: 'Portfolio URL',    aliases: ['Portfolio'], role: 'textbox', canonicalKey: 'portfolio_url' },
    { label: 'Resume',           aliases: ['Resume/CV', 'CV'], role: 'file', canonicalKey: 'resume' },
  ],
};

// LinkedIn Easy Apply — a much smaller, normalized form
const LINKEDIN: AtsTemplate = {
  atsId: 'linkedin',
  version: 1,
  fields: [
    { label: 'First Name',         role: 'textbox', canonicalKey: 'first_name' },
    { label: 'Last Name',          role: 'textbox', canonicalKey: 'last_name' },
    // LinkedIn renders email as a combobox of the user's verified addresses
    { label: 'Email Address',      aliases: ['Email'], role: 'combobox', canonicalKey: 'email' },
    { label: 'Phone Country Code', aliases: ['Country Code'], role: 'combobox', canonicalKey: 'phone_country_code' },
    { label: 'Mobile Phone Number', aliases: ['Phone Number', 'Phone'], role: 'textbox', canonicalKey: 'phone_number' },
    { label: 'City',               role: 'textbox', canonicalKey: 'city' },
  ],
};

// Naukri (Indian job portal — common fields, English-only template)
const NAUKRI: AtsTemplate = {
  atsId: 'host:www.naukri.com',   // Naukri has no ATS-family identity; key on host directly
  version: 1,
  fields: [
    { label: 'Full Name',          aliases: ['Name'], role: 'textbox', canonicalKey: 'full_name' },
    { label: 'Email ID',           aliases: ['Email'], role: 'textbox', canonicalKey: 'email' },
    { label: 'Mobile Number',      aliases: ['Phone', 'Mobile'], role: 'textbox', canonicalKey: 'phone_number' },
    { label: 'Current Company',    role: 'textbox', canonicalKey: 'current_company' },
    { label: 'Current Designation', aliases: ['Current Job Title', 'Job Title'], role: 'textbox', canonicalKey: 'job_title' },
    { label: 'Notice Period',      role: 'combobox', canonicalKey: 'notice_period' },
    { label: 'Current Location',   aliases: ['Current City'], role: 'textbox', canonicalKey: 'current_location' },
    { label: 'Preferred Location', aliases: ['Preferred Cities'], role: 'textbox', canonicalKey: 'preferred_location' },
    { label: 'Total Experience',   aliases: ['Years of Experience'], role: 'textbox', canonicalKey: 'years_of_experience' },
    { label: 'Expected CTC',       aliases: ['Expected Salary'], role: 'textbox', canonicalKey: 'salary_expectation' },
  ],
};

export const ATS_TEMPLATES: ReadonlyArray<AtsTemplate> = [
  GREENHOUSE,
  WORKDAY,
  LEVER,
  LINKEDIN,
  NAUKRI,
];

/**
 * The current bundled template-set version. Bump this when ANY template adds
 * or removes a field — the seeder uses it as part of the chrome.storage flag
 * (`ats_templates_seeded_v{n}`) so an updated extension re-seeds on startup.
 *
 * Individual template `version` fields exist for future per-ATS migrations
 * but aren't checked separately yet; the bundle-level version is sufficient.
 */
export const ATS_TEMPLATES_BUNDLE_VERSION = 1;
