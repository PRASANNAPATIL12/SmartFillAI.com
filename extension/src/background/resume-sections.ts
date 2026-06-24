/**
 * Resume RAG — Section extraction and keyword-based retrieval (Phase AH).
 *
 * Instead of dumping 6000 chars of dense resume text into every LLM prompt,
 * we:
 *   1. At upload time: split the parsed resume into named semantic sections
 *      (summary, experience, education, skills, certifications, misc).
 *   2. At answer time: route each question to the 1-2 most relevant sections
 *      via keyword matching — fast, deterministic, no extra embedding calls.
 *
 * Backwards compatible: documents uploaded before Phase AH have no
 * `resumeSections` field and fall back to the full `extractedText` slice in
 * `answer-field.ts`.
 *
 * Section content cap: each section is kept to ~800 chars so the combined
 * relevant context fits comfortably in the LLM's 2000-token budget for
 * context, leaving room for the profile snippet and the question itself.
 */

import type { ResumeParseResult } from '@shared/types';
import type { ResumeSection } from '@shared/types';

export type { ResumeSection };

const SECTION_CONTENT_CAP = 800;
const RETRIEVAL_TOTAL_CAP = 3000;

// ── Extraction ─────────────────────────────────────────────────────────────────

function formatPersonal(p: ResumeParseResult['personal'], visaStatus?: string): string {
  const parts: string[] = [];
  if (p.name)        parts.push(`Name: ${p.name}`);
  if (p.location)    parts.push(`Location: ${p.location}`);
  if (p.nationality) parts.push(`Nationality: ${p.nationality}`);
  if (visaStatus)    parts.push(`Visa: ${visaStatus}`);
  return parts.join('\n');
}

function formatExperience(exp: ResumeParseResult['work_experience']): string {
  return exp
    .slice(0, 4)
    .map(e => {
      const lines = [`${e.role} at ${e.company} (${e.duration})`];
      if (e.highlights?.length) {
        lines.push(...e.highlights.slice(0, 3).map(h => `- ${h}`));
      }
      return lines.join('\n');
    })
    .join('\n\n')
    .slice(0, SECTION_CONTENT_CAP);
}

function formatEducation(edu: ResumeParseResult['education']): string {
  return edu
    .map(e => {
      const parts = [`${e.degree} — ${e.institution} (${e.year})`];
      if (e.gpa) parts.push(`GPA: ${e.gpa}`);
      return parts.join(', ');
    })
    .join('\n')
    .slice(0, SECTION_CONTENT_CAP);
}

/**
 * Derive a concise full_text-derived summary block (first 300 chars of the
 * resume — usually the candidate's professional summary paragraph).
 */
function extractSummaryFromFullText(fullText: string): string {
  const lines = fullText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 30);
  // Skip header lines (contact info, name) by looking for first multi-word sentence
  const summaryLine = lines.find(l => l.split(' ').length > 8 && !/^\+?[\d\s().+-]+$/.test(l));
  return (summaryLine ?? lines[0] ?? '').slice(0, SECTION_CONTENT_CAP);
}

/**
 * Extract structured resume sections from a parsed resume. Sections are used
 * for targeted context retrieval in the LLM answer tier.
 *
 * Returns an empty array when the parsed resume has no usable content (e.g.
 * parse failed or the resume is too short). Callers must handle this gracefully
 * by falling back to `extractedText`.
 */
export function extractSections(
  parsed: ResumeParseResult,
  fullText?: string
): ResumeSection[] {
  const sections: ResumeSection[] = [];

  // Summary — derived from free text if available
  const summaryText = fullText ? extractSummaryFromFullText(fullText) : '';
  if (summaryText) {
    sections.push({ name: 'summary', content: summaryText });
  }

  // Personal / identity fields (visa, location, nationality)
  const personalText = formatPersonal(parsed.personal ?? {}, parsed.visa_status);
  if (personalText) {
    sections.push({ name: 'personal', content: personalText });
  }

  // Work experience (most signal-rich for most questions)
  if (parsed.work_experience?.length) {
    sections.push({ name: 'experience', content: formatExperience(parsed.work_experience) });
  }

  // Education
  if (parsed.education?.length) {
    sections.push({ name: 'education', content: formatEducation(parsed.education) });
  }

  // Skills — raw list, compact
  if (parsed.skills?.length) {
    sections.push({
      name: 'skills',
      content: parsed.skills.join(', ').slice(0, SECTION_CONTENT_CAP),
    });
  }

  // Certifications
  if (parsed.certifications?.length) {
    sections.push({
      name: 'certifications',
      content: parsed.certifications.join(', ').slice(0, SECTION_CONTENT_CAP),
    });
  }

  // Misc numeric/HR fields (experience years, notice period, CTC)
  const miscParts: string[] = [];
  if (parsed.total_years_of_experience) miscParts.push(`Total experience: ${parsed.total_years_of_experience}`);
  if (parsed.notice_period)             miscParts.push(`Notice period: ${parsed.notice_period}`);
  if (parsed.visa_status)               miscParts.push(`Visa status: ${parsed.visa_status}`);
  if (miscParts.length) {
    sections.push({ name: 'misc', content: miscParts.join('\n') });
  }

  return sections;
}

// ── Retrieval ──────────────────────────────────────────────────────────────────

interface SectionRoute {
  pattern: RegExp;
  names: ResumeSection['name'][];
}

/**
 * Keyword → section-name routing table.
 * First matching route wins (order matters — more specific first).
 * Routes are intentionally overlapping: "experience with Python" matches both
 * the skills and the experience routes; the first match (skills) wins.
 */
const SECTION_ROUTES: SectionRoute[] = [
  // Skills & tech
  {
    pattern: /\b(skill|technolog|python|java|react|angular|vue|node|typescript|javascript|aws|gcp|azure|cloud|docker|kubernetes|ml|ai|data|sql|go|ruby|swift|kotlin|c\+\+|framework|library|tool)\b/i,
    names: ['skills', 'experience'],
  },
  // Education
  {
    pattern: /\b(educat|degree|university|college|school|gpa|major|minor|bachelor|master|phd|mba|study|studied|graduat)\b/i,
    names: ['education', 'certifications'],
  },
  // Certifications & awards
  {
    pattern: /\b(certif|award|honor|distinction|licensed|accredit)\b/i,
    names: ['certifications', 'education'],
  },
  // Visa / work authorization
  {
    pattern: /\b(visa|sponsor|authoriz|work\s*permit|citizen|immigrat|h1b|opt|cpt|green\s*card|status)\b/i,
    names: ['personal', 'misc'],
  },
  // Compensation / notice / availability
  {
    pattern: /\b(salary|ctc|compensat|pay|notice|availab|start\s*date|join|reloc)\b/i,
    names: ['misc', 'experience'],
  },
  // Narrative / motivational
  {
    pattern: /\b(why|motivat|passion|interest|yourself|summary|strength|weakness|career|goal|aspir|cover|letter|about|tell|describe|explain)\b/i,
    names: ['summary', 'experience'],
  },
  // Projects
  {
    pattern: /\b(project|portfolio|built|created|developed|launched|shipped)\b/i,
    names: ['experience', 'skills'],
  },
  // General work experience (years, roles, companies)
  {
    pattern: /\b(experience|work|job|company|employ|role|position|year|month|senior|junior|lead|manag)\b/i,
    names: ['experience', 'skills'],
  },
];

/**
 * Given a question and the candidate's resume sections, return the most
 * relevant combined context string (capped at RETRIEVAL_TOTAL_CAP chars).
 *
 * Falls back to all sections when no specific route matches — still better
 * than raw full-text since sections are already compacted and formatted.
 */
export function selectRelevantSections(
  question: string,
  sections: ResumeSection[]
): string {
  if (!sections.length) return '';

  const byName = new Map<ResumeSection['name'], string>(
    sections.map(s => [s.name, s.content])
  );

  let targetNames: ResumeSection['name'][] | null = null;
  for (const route of SECTION_ROUTES) {
    if (route.pattern.test(question)) {
      targetNames = route.names;
      break;
    }
  }

  const orderedNames: ResumeSection['name'][] = targetNames
    // If a routed section doesn't exist in this resume, skip gracefully
    ? targetNames.filter(n => byName.has(n))
    : sections.map(s => s.name);

  // Deduplicate (a section can appear in multiple routes)
  const seen = new Set<ResumeSection['name']>();
  const picked: string[] = [];
  for (const name of orderedNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const content = byName.get(name);
    if (content) picked.push(content);
  }

  // If routing produced nothing (e.g. resume has no experience section), fall back to all
  if (picked.length === 0) {
    return sections.map(s => s.content).join('\n\n').slice(0, RETRIEVAL_TOTAL_CAP);
  }

  return picked.join('\n\n').slice(0, RETRIEVAL_TOTAL_CAP);
}
