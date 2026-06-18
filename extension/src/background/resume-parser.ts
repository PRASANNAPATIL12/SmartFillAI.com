import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProviderFactory, getProviderConfig } from '@/ai-providers';
import { ENV_GEMINI_API_KEY } from '@/ai-providers/env';
import type { ResumeParseResult, ProfileEntry } from '@shared/types';
import { addEntry, type NewEntryData } from './profile-store';
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
    "email": string | null,
    "phone": string | null,
    "linkedin": string | null,
    "github": string | null,
    "portfolio": string | null,
    "location": string | null
  },
  "education": [{ "institution": string, "degree": string, "year": string, "gpa": string | null }],
  "work_experience": [{ "company": string, "role": string, "duration": string, "highlights": string[] }],
  "skills": string[],
  "certifications": string[],
  "full_text": string
}

"full_text" must contain the COMPLETE resume content as natural-language text, preserving all sections, bullet points, dates, and details exactly as written. This is used as context for answering job-application questions, so omit nothing.

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

export async function createEntriesFromResume(
  parsed: ResumeParseResult,
  userId: string
): Promise<ProfileEntry[]> {
  const specs: EntrySpec[] = [];
  const p = parsed.personal;

  if (p.name)      specs.push({ key: 'full_name',    label: 'Full Name',    value: p.name,      category: 'identity' });
  if (p.email)     specs.push({ key: 'email',         label: 'Email',        value: p.email,     category: 'contact'  });
  if (p.phone)     specs.push({ key: 'phone_number',  label: 'Phone',        value: p.phone,     category: 'contact'  });
  if (p.linkedin)  specs.push({ key: 'linkedin_url',  label: 'LinkedIn',     value: p.linkedin,  category: 'social'   });
  if (p.github)    specs.push({ key: 'github_url',    label: 'GitHub',       value: p.github,    category: 'social'   });
  if (p.portfolio) specs.push({ key: 'website',       label: 'Portfolio',    value: p.portfolio, category: 'social'   });
  if (p.location)  specs.push({ key: 'address_line1', label: 'Location',     value: p.location,  category: 'contact'  });

  // Most recent education
  if (parsed.education.length > 0) {
    const edu = parsed.education[0];
    if (edu.institution) specs.push({ key: 'university', label: 'University', value: edu.institution, category: 'education' });
    if (edu.degree)      specs.push({ key: 'degree',     label: 'Degree',     value: edu.degree,      category: 'education' });
    if (edu.gpa)         specs.push({ key: 'gpa',        label: 'GPA',        value: edu.gpa,         category: 'education' });
  }

  // Most recent job
  if (parsed.work_experience.length > 0) {
    const job = parsed.work_experience[0];
    if (job.company) specs.push({ key: 'company',   label: 'Current Company', value: job.company, category: 'work' });
    if (job.role)    specs.push({ key: 'job_title', label: 'Job Title',        value: job.role,    category: 'work' });
  }

  // Skills as a single concatenated entry
  if (parsed.skills.length > 0) {
    specs.push({ key: 'skills', label: 'Skills', value: parsed.skills.join(', '), category: 'work' });
  }

  const created: ProfileEntry[] = [];
  for (const spec of specs) {
    if (!spec.value.trim()) continue;
    const data: NewEntryData = {
      canonical_key: spec.key,
      display_label: spec.label,
      aliases:       [],
      value:         spec.value.trim(),
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
