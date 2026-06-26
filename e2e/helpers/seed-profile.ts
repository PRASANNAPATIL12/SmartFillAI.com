/**
 * E2E helper: seed profile entries directly into the extension's IndexedDB
 * via the ADD_ENTRY background message. This simulates what
 * createEntriesFromResume() would do after a successful Gemini parse,
 * so test phases can proceed without depending on the Gemini quota.
 *
 * Data extracted manually from Prasanna_Patil_Resume.pdf (simulating what
 * Gemini's structured output would be).
 */

import type { Page } from '@playwright/test';

export interface SeedProfileEntry {
  key: string;
  label: string;
  value: string;
  category: string;
}

/** Real data extracted from Prasanna_Patil_Resume.pdf. */
export const PRASANNA_PROFILE: SeedProfileEntry[] = [
  // ── Identity ──
  { key: 'full_name',  label: 'Full Name',  value: 'Prasanna Patil', category: 'identity' },
  { key: 'first_name', label: 'First Name', value: 'Prasanna',       category: 'identity' },
  { key: 'last_name',  label: 'Last Name',  value: 'Patil',          category: 'identity' },

  // ── Contact ──
  { key: 'email',         label: 'Email',     value: 'pspatil77888@gmail.com', category: 'contact' },
  { key: 'phone_number',  label: 'Phone',     value: '+91 9999999999',         category: 'contact' },
  { key: 'address_line1', label: 'Location',  value: 'Bangalore, India',       category: 'contact' },
  { key: 'city',          label: 'City',      value: 'Bangalore',              category: 'contact' },
  { key: 'state',         label: 'State',     value: 'Karnataka',              category: 'contact' },
  { key: 'country',       label: 'Country',   value: 'India',                  category: 'contact' },

  // ── Social ──
  { key: 'linkedin_url', label: 'LinkedIn', value: 'https://linkedin.com/in/prasanna-patil', category: 'social' },
  { key: 'github_url',   label: 'GitHub',   value: 'https://github.com/prasannagp1',         category: 'social' },
  { key: 'website',      label: 'Portfolio', value: 'https://prasannapatil.dev',             category: 'social' },

  // ── Work (current — Verifone) ──
  { key: 'current_company', label: 'Current Company', value: 'Verifone',                category: 'work' },
  { key: 'current_title',   label: 'Current Title',   value: 'Software Engineer',       category: 'work' },
  { key: 'current_start_date', label: 'Current Start Date', value: 'July 2024',         category: 'work' },
  { key: 'total_years_of_experience', label: 'Years of Experience', value: '2 years', category: 'work' },

  // ── Work (previous — Mercuri) ──
  { key: 'company_2',     label: 'Previous Company',    value: 'Mercuri, Indranagar',     category: 'work' },
  { key: 'title_2',       label: 'Previous Title',      value: 'Software Engineer Intern', category: 'work' },
  { key: 'duration_2',    label: 'Previous Duration',   value: 'March 2024 - May 2024',   category: 'work' },

  // ── Work (previous — Kenai) ──
  { key: 'company_3',     label: 'Earlier Company',     value: 'Kenai Technologies',         category: 'work' },
  { key: 'title_3',       label: 'Earlier Title',       value: 'Full Stack Web Developer Intern', category: 'work' },
  { key: 'duration_3',    label: 'Earlier Duration',    value: 'November 2023 - January 2024', category: 'work' },

  // ── Education ──
  { key: 'university',      label: 'University',     value: 'Bangalore Institute of Technology', category: 'education' },
  { key: 'degree',          label: 'Degree',         value: 'B.E. Information Science and Engineering', category: 'education' },
  { key: 'graduation_year', label: 'Graduation Year', value: '2024', category: 'education' },
  { key: 'gpa',             label: 'GPA',             value: '8.5/10', category: 'education' },

  // ── Skills ──
  { key: 'skills', label: 'Skills', value: 'PowerShell, Java, JavaScript, TypeScript, React, Node.js, Express, Python, SQL, NoSQL, Next.js, REST APIs, GraphQL, HTML5, CSS3, TailwindCSS, Material-UI, MongoDB, MySQL, Git', category: 'skills' },

  // ── Work authorization (typical defaults) ──
  { key: 'work_auth_us', label: 'Work Auth (US)', value: 'No',  category: 'work_auth' },
  { key: 'sponsorship',  label: 'Sponsorship',    value: 'Yes', category: 'work_auth' },
];

/**
 * Seed profile entries into the extension's IDB by sending ADD_ENTRY messages.
 * Must be run with a popup page already past the login screen.
 */
export async function seedProfile(popupPage: Page, entries: SeedProfileEntry[] = PRASANNA_PROFILE): Promise<number> {
  const inserted = await popupPage.evaluate(async (entries) => {
    const sendToBackground = (type: string, payload?: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        // @ts-ignore — chrome global available in extension context
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          // @ts-ignore
          if (chrome.runtime.lastError) {
            // @ts-ignore
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response?.data);
        });
      });

    let count = 0;
    for (const e of entries) {
      try {
        await sendToBackground('ADD_ENTRY', {
          canonical_key: e.key,
          display_label: e.label,
          aliases:       [],
          value:         e.value,
          category:      e.category,
          source:        'manual',
          sensitive:     false,
        });
        count++;
      } catch (err) {
        console.warn(`Failed to seed ${e.key}:`, err);
      }
    }
    return count;
  }, entries);

  return inserted;
}

/**
 * Clear all profile entries before seeding (so re-runs are deterministic).
 */
export async function clearProfile(popupPage: Page): Promise<void> {
  await popupPage.evaluate(async () => {
    const sendToBackground = (type: string, payload?: unknown): Promise<any> =>
      new Promise((resolve) => {
        // @ts-ignore
        chrome.runtime.sendMessage({ type, payload }, (response) => resolve(response?.data));
      });

    const entries = await sendToBackground('GET_PROFILE') as Array<{ id: string }> | undefined;
    if (Array.isArray(entries)) {
      for (const e of entries) {
        await sendToBackground('DELETE_ENTRY', { id: e.id });
      }
    }
  });
}
