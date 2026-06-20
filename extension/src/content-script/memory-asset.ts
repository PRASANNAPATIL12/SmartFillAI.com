/**
 * Semantic memory assets — the unifying view over everything the user has
 * answered (Q→A cache + question embeddings). Every answered field is an asset:
 * a question, its answer(s), and an embedding for cross-form semantic recall.
 *
 * This module adds the one piece the tiered-reuse policy needs on top of the
 * existing stores: a classifier that says whether an answer should be REPLAYED
 * VERBATIM (factual) or RE-SYNTHESIZED per company (narrative), plus a seed
 * retriever that finds a prior answer to a semantically-similar question.
 *
 * Classification is derived LIVE from the field (no stored tag, no storage
 * migration) — the kind of a field is a property of the field, recomputed each
 * time it's seen, which keeps the existing qa-cache format untouched.
 */

import { isCombobox } from './combobox';
import { getRememberedAnswer } from './qa-cache';
import { sendToBackground } from './messenger';

export type AnswerKind = 'factual' | 'narrative';

// Narrative = free-form prose meant to be tailored to the employer (essays,
// "why do you want to work here", cover letters, "tell us about yourself").
// Everything else — choices, yes/no, names, numbers, dates — is factual and is
// replayed verbatim.
const NARRATIVE_LABEL =
  /\b(why|cover\s*letter|motivat|tell\s+us|describe|in\s+your\s+own\s+words|what\s+(makes|excites|interests|motivates)|passion|elaborate|explain\s+why|reason\s+for\s+(joining|applying|interest)|about\s+yourself|greatest\s+(strength|challenge)|proud)\b/i;

/**
 * Decide how a field's answer should be reused on a NEW form.
 *   factual   → replay the stored value verbatim (no LLM)
 *   narrative → re-synthesize, adapted to the detected company
 */
export function classifyAnswerKind(label: string, el: HTMLElement): AnswerKind {
  // Choice widgets are always factual — the answer is one of a fixed option set.
  const isChoice =
    el instanceof HTMLSelectElement
    || (el instanceof HTMLInputElement && el.type === 'radio')
    || el.getAttribute('role') === 'button'
    || isCombobox(el);
  if (isChoice) return 'factual';

  if (NARRATIVE_LABEL.test(label || '')) return 'narrative';

  // A large free-text area with an open prompt is narrative even without a
  // keyword (e.g. "Anything else you'd like us to know?").
  if (el instanceof HTMLTextAreaElement) {
    const max = el.maxLength;
    if (max <= 0 || max >= 200) return 'narrative';
  }

  return 'factual';
}

/**
 * Find a prior answer to this question (or a semantically-similar one) to use
 * as a verbatim replay (factual) or a synthesis SEED (narrative).
 * Exact normalized-question hit first, then fuzzy embedding match.
 */
export async function getSeedAnswer(label: string): Promise<string | null> {
  const exact = await getRememberedAnswer(label);
  if (exact) return exact;
  try {
    const fuzzy = await sendToBackground<{ answer: string | null }>('FUZZY_QA_MATCH', { question: label });
    return fuzzy?.answer ?? null;
  } catch {
    return null;
  }
}
