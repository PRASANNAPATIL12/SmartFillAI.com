/**
 * Pre-generates Q&A pairs from a candidate's resume at upload time.
 *
 * After resume upload, Gemini analyzes the full resume text and generates
 * 40-60 question-answer pairs covering every skill, technology, work-history
 * fact, and common form question derivable from the resume. These get stored
 * in the Q&A cache with embeddings so the Q&A replay tier fills them instantly
 * on subsequent forms — no per-field LLM call needed.
 */

import { AIProviderFactory, getProviderConfig } from '@/ai-providers';
import { logCost } from '@/ai-providers/cost-tracker';
import type { ProfileEntry } from '@shared/types';

const QA_SYSTEM =
  `You analyze a candidate's resume and profile to generate question-answer pairs ` +
  `that cover EVERY piece of information in the resume. Job application forms ask ` +
  `the same information in many different ways — generate multiple phrasings for ` +
  `important facts.\n\n` +
  `Rules:\n` +
  `- Base EVERY answer strictly on the resume and profile. Invent nothing.\n` +
  `- For Yes/No questions, reason from the data (e.g. 8 years experience → ` +
  `"Do you have 5+ years experience?" → "Yes").\n` +
  `- Generate pairs for EVERY skill, technology, framework, tool, and language ` +
  `mentioned in the resume.\n` +
  `- Generate pairs for work history facts: duration, role, company, ` +
  `responsibilities, achievements.\n` +
  `- Generate pairs for education, certifications, location, visa status, ` +
  `notice period, CTC, availability.\n` +
  `- Include numeric threshold questions for experience (3+, 5+, 8+, 10+ years).\n` +
  `- Vary question phrasing: "Do you have experience with X?", ` +
  `"Have you worked with X?", "X experience?", "Years of experience in X?"\n` +
  `- If the resume does not contain information for a question, skip it entirely.\n` +
  `- Output ONLY valid JSON, no markdown fences: ` +
  `{"pairs":[{"question":"...","answer":"..."},...]}\n` +
  `- Generate 40-60 pairs to cover the resume comprehensively.`;

function profileSnippet(entries: ProfileEntry[]): string {
  return entries
    .filter(e => !e.sensitive && e.value)
    .map(e => `${e.canonical_key}: ${e.value}`)
    .join('\n')
    .slice(0, 2000);
}

export interface QAPair {
  question: string;
  answer: string;
}

export async function generateResumeQA(
  resumeText: string,
  entries: ProfileEntry[]
): Promise<QAPair[]> {
  if (!resumeText || resumeText.trim().length < 50) return [];

  const [provider, cfg] = await Promise.all([
    AIProviderFactory.getProvider(),
    getProviderConfig(),
  ]);

  const prompt =
    `Candidate profile:\n${profileSnippet(entries) || '(none)'}\n\n` +
    `Resume:\n${resumeText.slice(0, 6000)}\n`;

  let response;
  try {
    response = await provider.chat({
      messages:       [{ role: 'user', content: prompt }],
      system:         QA_SYSTEM,
      responseFormat: 'json_object',
      temperature:    0.2,
      maxTokens:      4096,
    });
  } catch (err) {
    console.warn('[SmartFillAI] generateResumeQA: provider error', err);
    return [];
  }

  try {
    await logCost({
      provider:         cfg.provider,
      operation:        'resume_qa_gen',
      model:            response.model,
      promptTokens:     response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      cost:             response.cost ?? 0,
    });
  } catch { /* non-fatal */ }

  let raw = response.content.trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  let parsed: { pairs?: unknown };
  try {
    parsed = JSON.parse(raw) as { pairs?: unknown };
  } catch {
    console.warn('[SmartFillAI] generateResumeQA: JSON parse failed');
    return [];
  }

  if (!Array.isArray(parsed.pairs)) return [];

  return (parsed.pairs as Array<{ question?: unknown; answer?: unknown }>)
    .filter(p =>
      typeof p.question === 'string' && p.question.trim().length > 5 &&
      typeof p.answer === 'string' && p.answer.trim().length > 0
    )
    .map(p => ({
      question: (p.question as string).trim(),
      answer:   (p.answer as string).trim(),
    }));
}
