/**
 * Step 6 of the field-matching waterfall — LLM-based classification.
 *
 * Called for fields still UNKNOWN after Steps 1-5. Sends all remaining
 * unknown fields to the AI provider in a single batched call to minimise
 * API round-trips. The LLM matches each field against the stored profile.
 */

import { AIProviderFactory } from '@/ai-providers';
import type { ProfileEntry } from '@shared/types';
import { getAllEntries } from './profile-store';

export interface FieldClassifySpec {
  fieldIndex: number;
  fieldText:  string;
}

export interface ClassifyResult {
  fieldIndex:     number;
  profileEntryId: string | null;
  confidence:     number;
}

const CLASSIFY_SYSTEM = `You are a form-field matching engine. Match each provided form field description to the most appropriate profile entry. Return ONLY a valid JSON array — no explanation, no markdown.`;

function buildEntryList(entries: ProfileEntry[]): string {
  return entries
    .map((e, i) => `  ${i}: id="${e.id}" key="${e.canonical_key}" label="${e.display_label}"`)
    .join('\n');
}

function buildFieldList(fields: FieldClassifySpec[]): string {
  return fields
    .map(f => `  ${f.fieldIndex}: ${f.fieldText}`)
    .join('\n');
}

export async function classifyFields(fields: FieldClassifySpec[]): Promise<ClassifyResult[]> {
  if (fields.length === 0) return [];

  const [provider, entries] = await Promise.all([
    AIProviderFactory.getProvider(),
    getAllEntries(),
  ]);

  if (entries.length === 0) return fields.map(f => ({ fieldIndex: f.fieldIndex, profileEntryId: null, confidence: 0 }));

  const prompt =
    `Match each numbered form field to a profile entry.\n\n` +
    `Profile entries:\n${buildEntryList(entries)}\n\n` +
    `Form fields to classify:\n${buildFieldList(fields)}\n\n` +
    `Return a JSON array. For each field: {"fieldIndex":<n>,"profileEntryId":"<entry id or null>","confidence":<0.0-1.0>}.\n` +
    `Only return a match if confidence >= 0.70. Use null otherwise.`;

  const response = await provider.chat({
    messages:       [{ role: 'user', content: prompt }],
    system:         CLASSIFY_SYSTEM,
    responseFormat: 'json_object',
    temperature:    0.1,
    maxTokens:      512,
  });

  let raw: string = response.content.trim();
  // Strip markdown code fences if present
  raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  const parsed = JSON.parse(raw) as ClassifyResult[];

  // Validate entry IDs against actual profile — the LLM may hallucinate IDs
  const entryIds = new Set(entries.map(e => e.id));
  return parsed.map(r => ({
    fieldIndex:     r.fieldIndex,
    profileEntryId: r.profileEntryId && entryIds.has(r.profileEntryId) ? r.profileEntryId : null,
    confidence:     typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0,
  }));
}
