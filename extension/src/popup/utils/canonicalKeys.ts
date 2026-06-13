export type EntryCategory = 'contact' | 'identity' | 'education' | 'work' | 'social' | 'other';

export interface CanonicalKeyOption {
  key: string;
  label: string;
  category: EntryCategory;
}

export const CANONICAL_KEY_OPTIONS: CanonicalKeyOption[] = [
  // Contact
  { key: 'email',           label: 'Email Address',      category: 'contact' },
  { key: 'phone_number',    label: 'Phone Number',       category: 'contact' },
  { key: 'street_address',  label: 'Street Address',     category: 'contact' },
  { key: 'address_line2',   label: 'Address Line 2',     category: 'contact' },
  { key: 'city',            label: 'City',               category: 'contact' },
  { key: 'state',           label: 'State / Province',   category: 'contact' },
  { key: 'zip_code',        label: 'Zip / Postal Code',  category: 'contact' },
  { key: 'country',         label: 'Country',            category: 'contact' },
  // Identity
  { key: 'full_name',       label: 'Full Name',          category: 'identity' },
  { key: 'first_name',      label: 'First Name',         category: 'identity' },
  { key: 'last_name',       label: 'Last Name',          category: 'identity' },
  { key: 'middle_name',     label: 'Middle Name',        category: 'identity' },
  { key: 'date_of_birth',   label: 'Date of Birth',      category: 'identity' },
  { key: 'gender',          label: 'Gender',             category: 'identity' },
  { key: 'pronouns',        label: 'Pronouns',           category: 'identity' },
  { key: 'nationality',     label: 'Nationality',        category: 'identity' },
  // Education
  { key: 'university',        label: 'University',          category: 'education' },
  { key: 'degree',            label: 'Degree / Major',      category: 'education' },
  { key: 'gpa',               label: 'GPA',                 category: 'education' },
  { key: 'graduation_year',   label: 'Graduation Year',     category: 'education' },
  { key: 'graduation_month',  label: 'Graduation Month',    category: 'education' },
  // Work
  { key: 'current_company',     label: 'Current Company',      category: 'work' },
  { key: 'job_title',           label: 'Job Title',            category: 'work' },
  { key: 'years_of_experience', label: 'Years of Experience',  category: 'work' },
  { key: 'work_authorization',  label: 'Work Authorization',   category: 'work' },
  { key: 'salary_expectation',  label: 'Salary Expectation',   category: 'work' },
  { key: 'notice_period',       label: 'Notice Period',        category: 'work' },
  { key: 'start_date',          label: 'Start Date',           category: 'work' },
  // Social
  { key: 'linkedin_url',      label: 'LinkedIn URL',      category: 'social' },
  { key: 'github_url',        label: 'GitHub URL',        category: 'social' },
  { key: 'portfolio_url',     label: 'Portfolio URL',     category: 'social' },
  { key: 'website_url',       label: 'Personal Website',  category: 'social' },
  { key: 'twitter_handle',    label: 'Twitter / X',       category: 'social' },
  { key: 'instagram_url',     label: 'Instagram',         category: 'social' },
  { key: 'stackoverflow_url', label: 'Stack Overflow',    category: 'social' },
  { key: 'behance_url',       label: 'Behance',           category: 'social' },
  { key: 'dribbble_url',      label: 'Dribbble',          category: 'social' },
  // Other
  { key: 'skills_summary',   label: 'Skills Summary',    category: 'other' },
  { key: 'timezone',         label: 'Timezone',          category: 'other' },
  { key: 'tshirt_size',      label: 'T-Shirt Size',      category: 'other' },
  { key: 'disability_status',label: 'Disability Status', category: 'other' },
  { key: 'veteran_status',   label: 'Veteran Status',    category: 'other' },
  { key: 'race_ethnicity',   label: 'Race / Ethnicity',  category: 'other' },
];

export const CATEGORY_LABELS: Record<EntryCategory, string> = {
  contact:   'Contact',
  identity:  'Identity',
  education: 'Education',
  work:      'Work',
  social:    'Social',
  other:     'Other',
};

/** Friendly label for a canonical key, falls back to the key itself. */
export function getKeyLabel(key: string): string {
  return CANONICAL_KEY_OPTIONS.find(o => o.key === key)?.label ?? key;
}
