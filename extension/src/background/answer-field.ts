/**
 * Final waterfall tier — answer a form QUESTION using the LLM.
 *
 * Reached only after exact-profile / Q→A-cache / embedding all miss. Handles
 * questions whose answer isn't a stored attribute and the user hasn't answered
 * before: "Do you need sponsorship?", "Have you worked here before?", "5+ years
 * ML experience?", "How did you hear about us?".
 *
 * Context = the candidate's profile + the WHOLE parsed resume (extractedText).
 * A resume is small (~1-2k tokens) so we pass it directly — no chunk/embed/
 * retrieve vector store needed.
 *
 * Mirrors llm-classifier.ts: AIProviderFactory.getProvider().chat({...,
 * responseFormat:'json_object'}) → fence-strip → JSON.parse. Cost is logged so
 * the popup meter stays accurate.
 *
 * Anti-hallucination: when OPTIONS are supplied, the returned answer MUST be one
 * of them (verified here); otherwise we return null → caller marks FILL_FAILED
 * rather than typing a guess.
 */

import { AIProviderFactory, getProviderConfig } from '@/ai-providers';
import { logCost } from '@/ai-providers/cost-tracker';
import type { ProfileEntry } from '@shared/types';
import { getAllEntries } from './profile-store';
import { getDefaultDocument } from '@/storage/idb';

export interface AnswerResult {
  answer: string | null;   // null = no confident answer (caller skips / FILL_FAILED)
  confidence: number;
}

const ANSWER_SYSTEM =
  `You fill job-application fields for a candidate using ONLY the provided ` +
  `profile and resume. If OPTIONS are given, return EXACTLY one of them, ` +
  `copied verbatim. If the answer is not supported by the context, return ` +
  `"DEFAULT". Output ONLY valid JSON, no markdown, no explanation: ` +
  `{"answer":"<text | option | DEFAULT>","confidence":<0.0-1.0>}.`;

const MIN_CONFIDENCE = 0.6;

function profileSnippet(entries: ProfileEntry[]): string {
  return entries
    .filter(e => !e.sensitive && e.value)
    .map(e => `${e.canonical_key}: ${e.value}`)
    .join('\n')
    .slice(0, 2000);
}

export async function answerField(
  question: string,
  options: string[] = []
): Promise<AnswerResult> {
  const q = (question || '').trim();
  if (!q) return { answer: null, confidence: 0 };

  const [provider, entries, cfg] = await Promise.all([
    AIProviderFactory.getProvider(),
    getAllEntries(),
    getProviderConfig(),
  ]);

  let resumeText = '';
  try {
    const doc = await getDefaultDocument('resume');
    resumeText = (doc?.extractedText ?? '').slice(0, 6000);
  } catch { /* no resume — proceed with profile only */ }

  const optionsBlock = options.length
    ? `Options (choose exactly one, verbatim):\n${options.map(o => `- ${o}`).join('\n')}\n\n`
    : '';

  const prompt =
    `Question: ${q}\n\n` +
    optionsBlock +
    `Candidate profile:\n${profileSnippet(entries) || '(none)'}\n\n` +
    (resumeText ? `Resume:\n${resumeText}\n` : `Resume: (none provided)\n`);

  let response;
  try {
    response = await provider.chat({
      messages:       [{ role: 'user', content: prompt }],
      system:         ANSWER_SYSTEM,
      responseFormat: 'json_object',
      temperature:    0.1,
      maxTokens:      256,
    });
  } catch (err) {
    console.warn('[SmartFillAI] answerField: provider error', err);
    return { answer: null, confidence: 0 };
  }

  // Cost logging (best-effort) so the popup cost meter reflects these calls.
  try {
    await logCost({
      provider:         cfg.provider,
      operation:        'answer_field',
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

  let parsed: { answer?: unknown; confidence?: unknown };
  try {
    parsed = JSON.parse(raw) as { answer?: unknown; confidence?: unknown };
  } catch {
    return { answer: null, confidence: 0 };
  }

  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  const confidence = typeof parsed.confidence === 'number'
    ? Math.min(1, Math.max(0, parsed.confidence))
    : 0;

  if (!answer || answer.toUpperCase() === 'DEFAULT' || confidence < MIN_CONFIDENCE) {
    return { answer: null, confidence };
  }

  // Anti-hallucination: with options, the answer MUST map to one of them.
  if (options.length) {
    const lc = answer.toLowerCase();
    const exact = options.find(o => o.trim().toLowerCase() === lc);
    const fuzzy = options.find(o => {
      const ol = o.trim().toLowerCase();
      return ol.includes(lc) || lc.includes(ol);
    });
    const matched = exact ?? fuzzy ?? null;
    return { answer: matched, confidence: matched ? confidence : 0 };
  }

  return { answer, confidence };
}
