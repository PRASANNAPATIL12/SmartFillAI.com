import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProviderFactory, getProviderConfig } from '@/ai-providers';
import { ENV_GEMINI_API_KEY } from '@/ai-providers/env';
import type { ResumeParseResult, ProfileEntry } from '@shared/types';
import { addEntry, getEntriesByKey, updateEntry, type NewEntryData } from './profile-store';
import { computeEmbedding } from '@/ml/embedder';
import { entryEmbedText } from '@/ml/step5';
import { setEmbedding } from '@/storage/idb';

async function scheduleEmbed(entry: ProfileEntry): Promise<void> {
  const text   = entryEmbedText(entry);
  const vector = await computeEmbedding(text);
  await setEmbedding(entry.id, vector);
}

const PARSE_SYSTEM = `You are a professional resume parser. Extract structured data from the resume text and return ONLY valid JSON matching this exact schema. Do not include any explanation or markdown fences.`;

const PARSE_PROMPT = `Parse the resume and return JSON matching this exact structure:
{
  "personal": {
    "name": string | null,
    "first_name": string | null,
    "last_name": string | null,
    "email": string | null,
    "phone": string | null,
    "linkedin": string | null,
    "github": string | null,
    "portfolio": string | null,
    "location": string | null,
    "city": string | null,
    "state": string | null,
    "country": string | null,
    "nationality": string | null,
    "date_of_birth": string | null
  },
  "education": [{ "institution": string, "degree": string, "year": string, "gpa": string | null }],
  "work_experience": [{ "company": string, "role": string, "duration": string, "highlights": string[] }],
  "skills": string[],
  "certifications": string[],
  "total_years_of_experience": string | null,
  "notice_period": string | null,
  "visa_status": string | null,
  "full_text": string
}

Rules:
- Split "name" into "first_name" and "last_name". Keep "name" as the full name.
- Split "location" into "city", "state", "country" when possible. Keep "location" as the raw string.
- "total_years_of_experience": calculate from work history durations (e.g. "8 years"). Set null if not derivable.
- "notice_period": extract if explicitly mentioned (e.g. "30 days", "2 months"). Set null if not stated.
- "visa_status": extract if mentioned (e.g. "H1B", "US Citizen", "Green Card"). Set null if not stated.
- Include ALL education entries and ALL work experience entries, ordered most recent first.
- "full_text" must contain the COMPLETE resume content as natural-language text, preserving all sections, bullet points, dates, and details exactly as written. This is used as context for answering job-application questions, so omit nothing.

Return ONLY valid JSON. No explanations, no markdown.

Resume:
`;

// ── Text-based parsing (GROQ or Gemini) ───────────────────────────────────────

export async function parseResumeText(text: string): Promise<ResumeParseResult> {
  const provider = await AIProviderFactory.getProvider();
  const response = await provider.chat({
    messages: [{ role: 'user', content: PARSE_PROMPT + text }],
    system: PARSE_SYSTEM,
    responseFormat: 'json_object',
    maxTokens: 8192,
    temperature: 0.1,
  });

  try {
    return JSON.parse(response.content) as ResumeParseResult;
  } catch {
    // Some models wrap JSON in markdown — strip code fences
    const clean = response.content.replace(/```(?:json)?\n?/g, '').trim();
    return JSON.parse(clean) as ResumeParseResult;
  }
}

// ── PDF-based parsing (Gemini only — supports inline document data) ───────────

export async function parseResumePdf(pdfBase64: string): Promise<ResumeParseResult> {
  const cfg = await getProviderConfig();
  if (cfg.provider !== 'gemini') {
    throw new Error(
      'PDF upload requires the Gemini AI provider. Switch to Gemini in Settings → AI Provider.'
    );
  }

  if (!ENV_GEMINI_API_KEY) throw new Error('Gemini API key not configured.');

  const genAI = new GoogleGenerativeAI(ENV_GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  });

  const result = await model.generateContent([
    { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    PARSE_PROMPT,
  ]);

  try {
    return JSON.parse(result.response.text()) as ResumeParseResult;
  } catch {
    const clean = result.response.text().replace(/```(?:json)?\n?/g, '').trim();
    return JSON.parse(clean) as ResumeParseResult;
  }
}

// ── Entry creation from parsed result ────────────────────────────────────────

type EntrySpec = { key: string; label: string; value: string; category: string };

function push(specs: EntrySpec[], key: string, label: string, value: string | undefined | null, category: string): void {
  if (value && value.trim()) specs.push({ key, label, value: value.trim(), category });
}

export async function createEntriesFromResume(
  parsed: ResumeParseResult,
  userId: string
): Promise<ProfileEntry[]> {
  const specs: EntrySpec[] = [];
  const p = parsed.personal;

  // ── Personal / identity ──
  push(specs, 'full_name',    'Full Name',    p.name,          'identity');
  push(specs, 'first_name',   'First Name',   p.first_name,    'identity');
  push(specs, 'last_name',    'Last Name',    p.last_name,     'identity');
  push(specs, 'date_of_birth','Date of Birth',p.date_of_birth, 'identity');
  push(specs, 'nationality',  'Nationality',  p.nationality,   'identity');

  // ── Contact ──
  push(specs, 'email',         'Email',    p.email,    'contact');
  push(specs, 'phone_number',  'Phone',    p.phone,    'contact');
  push(specs, 'address_line1', 'Location', p.location, 'contact');
  push(specs, 'city',          'City',     p.city,     'contact');
  push(specs, 'state',         'State',    p.state,    'contact');
  push(specs, 'country',       'Country',  p.country,  'contact');

  // ── Social ──
  push(specs, 'linkedin_url', 'LinkedIn',  p.linkedin,  'social');
  push(specs, 'github_url',   'GitHub',    p.github,    'social');
  push(specs, 'website',      'Portfolio', p.portfolio, 'social');

  // ── Education (all entries, not just first) ──
  for (let i = 0; i < parsed.education.length; i++) {
    const edu = parsed.education[i];
    const suffix = i === 0 ? '' : `_${i + 1}`;
    push(specs, `university${suffix}`, i === 0 ? 'University' : `University ${i + 1}`, edu.institution, 'education');
    push(specs, `degree${suffix}`,     i === 0 ? 'Degree' : `Degree ${i + 1}`,         edu.degree,      'education');
    push(specs, `gpa${suffix}`,        i === 0 ? 'GPA' : `GPA ${i + 1}`,               edu.gpa,         'education');
    push(specs, `graduation_year${suffix}`, i === 0 ? 'Graduation Year' : `Graduation Year ${i + 1}`, edu.year, 'education');
  }

  // ── Work experience (current + previous) ──
  if (parsed.work_experience.length > 0) {
    const current = parsed.work_experience[0];
    push(specs, 'current_company', 'Current Company', current.company, 'work');
    push(specs, 'job_title',       'Job Title',       current.role,    'work');
  }
  if (parsed.work_experience.length > 1) {
    const prev = parsed.work_experience[1];
    push(specs, 'previous_company',   'Previous Company',   prev.company, 'work');
    push(specs, 'previous_job_title', 'Previous Job Title', prev.role,    'work');
  }

  // ── Derived work fields ──
  push(specs, 'years_of_experience', 'Years of Experience', parsed.total_years_of_experience, 'work');
  push(specs, 'notice_period',       'Notice Period',       parsed.notice_period,              'work');
  push(specs, 'visa_status',         'Visa Status',         parsed.visa_status,                'work');

  // ── Skills + certifications ──
  if (parsed.skills.length > 0) {
    specs.push({ key: 'skills', label: 'Skills', value: parsed.skills.join(', '), category: 'work' });
  }
  if (parsed.certifications.length > 0) {
    specs.push({ key: 'certifications', label: 'Certifications', value: parsed.certifications.join(', '), category: 'education' });
  }

  // ── Upsert: update existing resume-sourced entries instead of duplicating ──
  const created: ProfileEntry[] = [];
  for (const spec of specs) {
    const existing = await getEntriesByKey(spec.key);
    const resumeEntry = existing.find(e => e.source === 'resume');

    if (resumeEntry) {
      if (resumeEntry.value !== spec.value) {
        const updated = await updateEntry(resumeEntry.id, { value: spec.value });
        if (updated) {
          scheduleEmbed(updated).catch(() => {});
          created.push(updated);
        }
      } else {
        created.push(resumeEntry);
      }
      continue;
    }

    const data: NewEntryData = {
      canonical_key: spec.key,
      display_label: spec.label,
      aliases:       [],
      value:         spec.value,
      category:      spec.category,
      source:        'resume',
      sensitive:     false,
    };
    const entry = await addEntry(data, userId);
    scheduleEmbed(entry).catch(() => {});
    created.push(entry);
  }

  return created;
}
