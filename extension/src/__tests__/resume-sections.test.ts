/**
 * Tests for resume-sections.ts (Phase AH — Resume RAG).
 *
 * Tests cover:
 *   - extractSections: correct section names, content formatting, edge cases
 *   - selectRelevantSections: keyword routing, fallback, empty inputs, dedup
 */

import { extractSections, selectRelevantSections } from '../background/resume-sections';
import type { ResumeParseResult } from '@shared/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FULL_PARSED: ResumeParseResult = {
  personal: {
    name: 'Prasanna Patil',
    email: 'prasanna@example.com',
    location: 'Bangalore, India',
    nationality: 'Indian',
  },
  education: [
    { institution: 'IIT Bombay', degree: 'B.Tech Computer Science', year: '2018', gpa: '8.5' },
  ],
  work_experience: [
    {
      company: 'Stripe',
      role: 'Senior Software Engineer',
      duration: '2021–2024',
      highlights: ['Built payment APIs', 'Led 5-person team', 'Reduced latency 40%'],
    },
    {
      company: 'Flipkart',
      role: 'Software Engineer',
      duration: '2018–2021',
      highlights: ['Built recommendation engine', 'Python, Java, Kafka'],
    },
  ],
  skills: ['Python', 'Go', 'React', 'AWS', 'Kubernetes', 'PostgreSQL'],
  certifications: ['AWS Solutions Architect', 'Google Cloud Professional'],
  total_years_of_experience: '6 years',
  notice_period: '60 days',
  visa_status: 'H1B',
  full_text: 'Prasanna Patil is a senior software engineer with 6 years of experience building scalable systems at Stripe and Flipkart.',
};

const MINIMAL_PARSED: ResumeParseResult = {
  personal: {},
  education: [],
  work_experience: [],
  skills: [],
  certifications: [],
  full_text: undefined,
};

// ── extractSections ───────────────────────────────────────────────────────────

describe('extractSections', () => {
  it('returns all expected section names for a complete resume', () => {
    const sections = extractSections(FULL_PARSED, FULL_PARSED.full_text);
    const names = sections.map(s => s.name);
    expect(names).toContain('summary');
    expect(names).toContain('personal');
    expect(names).toContain('experience');
    expect(names).toContain('education');
    expect(names).toContain('skills');
    expect(names).toContain('certifications');
    expect(names).toContain('misc');
  });

  it('formats work experience with role, company, duration, and highlights', () => {
    const sections = extractSections(FULL_PARSED);
    const exp = sections.find(s => s.name === 'experience');
    expect(exp).toBeDefined();
    expect(exp!.content).toContain('Senior Software Engineer');
    expect(exp!.content).toContain('Stripe');
    expect(exp!.content).toContain('2021–2024');
    expect(exp!.content).toContain('Built payment APIs');
  });

  it('formats education with degree, institution, year, gpa', () => {
    const sections = extractSections(FULL_PARSED);
    const edu = sections.find(s => s.name === 'education');
    expect(edu).toBeDefined();
    expect(edu!.content).toContain('IIT Bombay');
    expect(edu!.content).toContain('B.Tech Computer Science');
    expect(edu!.content).toContain('8.5');
  });

  it('includes skills as comma-separated list', () => {
    const sections = extractSections(FULL_PARSED);
    const skills = sections.find(s => s.name === 'skills');
    expect(skills).toBeDefined();
    expect(skills!.content).toContain('Python');
    expect(skills!.content).toContain('Go');
    expect(skills!.content).toContain('Kubernetes');
  });

  it('packs misc section with experience years, notice period, visa status', () => {
    const sections = extractSections(FULL_PARSED);
    const misc = sections.find(s => s.name === 'misc');
    expect(misc).toBeDefined();
    expect(misc!.content).toContain('6 years');
    expect(misc!.content).toContain('60 days');
    expect(misc!.content).toContain('H1B');
  });

  it('returns empty array for empty parsed resume', () => {
    const sections = extractSections(MINIMAL_PARSED);
    expect(sections).toEqual([]);
  });

  it('handles missing optional fields gracefully', () => {
    const parsed: ResumeParseResult = {
      ...FULL_PARSED,
      certifications: [],
      total_years_of_experience: undefined,
      notice_period: undefined,
      visa_status: undefined,
    };
    const sections = extractSections(parsed);
    const names = sections.map(s => s.name);
    expect(names).not.toContain('certifications');
    expect(names).not.toContain('misc');
  });

  it('caps experience section content to avoid bloat', () => {
    const longHighlights = Array.from({ length: 20 }, (_, i) => `Highlight number ${i} with lots of text`);
    const parsed: ResumeParseResult = {
      ...FULL_PARSED,
      work_experience: [
        { company: 'BigCorp', role: 'Engineer', duration: '2020–2024', highlights: longHighlights },
      ],
    };
    const sections = extractSections(parsed);
    const exp = sections.find(s => s.name === 'experience');
    expect(exp!.content.length).toBeLessThanOrEqual(802); // SECTION_CONTENT_CAP + small buffer
  });

  it('limits work experience to at most 4 jobs to keep context tight', () => {
    const parsed: ResumeParseResult = {
      ...FULL_PARSED,
      work_experience: Array.from({ length: 10 }, (_, i) => ({
        company: `Company${i}`,
        role: 'Engineer',
        duration: '1 year',
        highlights: [`Did thing ${i}`],
      })),
    };
    const sections = extractSections(parsed);
    const exp = sections.find(s => s.name === 'experience');
    // Should not contain Company4+ (slice(0, 4))
    expect(exp!.content).not.toContain('Company4');
  });

  it('extracts summary from full_text', () => {
    const sections = extractSections(FULL_PARSED, FULL_PARSED.full_text);
    const summary = sections.find(s => s.name === 'summary');
    expect(summary).toBeDefined();
    expect(summary!.content.length).toBeGreaterThan(10);
  });
});

// ── selectRelevantSections ────────────────────────────────────────────────────

describe('selectRelevantSections', () => {
  const sections = extractSections(FULL_PARSED, FULL_PARSED.full_text);

  it('returns empty string for empty sections array', () => {
    expect(selectRelevantSections('Python experience?', [])).toBe('');
  });

  it('routes skill questions to skills + experience sections', () => {
    const result = selectRelevantSections('Do you have Python experience?', sections);
    expect(result).toContain('Python');
    expect(result.length).toBeGreaterThan(0);
  });

  it('routes education questions to education section', () => {
    const result = selectRelevantSections('What is your highest degree?', sections);
    expect(result).toContain('IIT Bombay');
    expect(result).toContain('B.Tech');
  });

  it('routes visa questions to personal + misc sections', () => {
    const result = selectRelevantSections('Do you need visa sponsorship?', sections);
    expect(result).toContain('H1B');
  });

  it('routes salary/notice questions to misc section', () => {
    const result = selectRelevantSections('What is your expected salary?', sections);
    expect(result).toContain('60 days');
  });

  it('routes work experience questions to experience section', () => {
    const result = selectRelevantSections('How many years of experience do you have?', sections);
    expect(result).toContain('Stripe');
  });

  it('routes motivation/narrative questions to summary + experience', () => {
    const result = selectRelevantSections('Why do you want to work here?', sections);
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to all sections when no route matches', () => {
    const result = selectRelevantSections('xyzzy random unknown topic', sections);
    // All sections combined — result should contain content from multiple sections
    expect(result).toContain('Python');
    expect(result.length).toBeGreaterThan(50);
  });

  it('caps total output at RETRIEVAL_TOTAL_CAP (3000 chars)', () => {
    const hugeSection = {
      name: 'experience' as const,
      content: 'x'.repeat(5000),
    };
    const bigSections = [hugeSection];
    const result = selectRelevantSections('work experience?', bigSections);
    expect(result.length).toBeLessThanOrEqual(3001);
  });

  it('deduplicates sections when multiple routes would include the same one', () => {
    const result = selectRelevantSections('React skills and experience', sections);
    // skills + experience — verify experience content isn't doubled
    const expCount = (result.match(/Stripe/g) || []).length;
    expect(expCount).toBe(1);
  });

  it('handles resume with only skills section', () => {
    const skillsOnly = [{ name: 'skills' as const, content: 'Python, Go, React' }];
    const result = selectRelevantSections('Python experience?', skillsOnly);
    expect(result).toContain('Python');
  });

  it('gracefully skips routed section names that do not exist in resume', () => {
    // Resume with no certifications — certif question should still return something
    const noCerts = sections.filter(s => s.name !== 'certifications');
    const result = selectRelevantSections('Any certifications?', noCerts);
    // Falls back to education (second in certif route)
    expect(result).toContain('IIT Bombay');
  });
});
