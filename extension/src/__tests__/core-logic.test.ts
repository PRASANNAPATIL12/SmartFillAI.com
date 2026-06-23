/**
 * Core Logic Unit Tests
 *
 * Tests pure functions across the SmartFillAI codebase: matcher helpers,
 * field-learner, value-aliases, country-aliases, value-validation,
 * memory-asset classification, and embedder math.
 */

import { expandValueAliases, hasValueAliases } from '../content-script/value-aliases';
import {
  resolveCountry,
  expandCountryAliases,
  stripCountryCode,
  ensureCountryCode,
} from '../content-script/country-aliases';
import { validateLearnedValue } from '../content-script/value-validation';
import { computeFillAction, FILL_THRESHOLD, REVIEW_THRESHOLD } from '../matcher';
import { cosineSimilarity } from '../ml/embedder';
import {
  inferCanonicalKey,
  inferDisplayLabel,
  inferCategory,
  normalizeFieldValue,
  type SerializableFieldSig,
} from '../background/field-learner';
import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../background/settings-store';
import {
  getAllEntries,
  addEntry,
  getEntriesByKey,
  healProfile,
  hasDuplicateValue,
  getMaxAlternatives,
} from '../background/profile-store';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSig(overrides: Partial<SerializableFieldSig> = {}): SerializableFieldSig {
  return {
    label: '',
    placeholder: '',
    name: '',
    id: '',
    ariaLabel: '',
    autocomplete: '',
    inputType: 'text',
    maxLength: null,
    surroundingText: '',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALUE ALIASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Value Aliases', () => {
  it('expands gender aliases', () => {
    const aliases = expandValueAliases('gender', 'Male');
    expect(aliases).toContain('Male');
    expect(aliases).toContain('M');
    expect(aliases.length).toBeGreaterThan(1);
  });

  it('expands degree aliases', () => {
    const aliases = expandValueAliases('degree', "Bachelor's");
    expect(aliases.length).toBeGreaterThan(1);
    // Should contain common abbreviations
    const lower = aliases.map(a => a.toLowerCase());
    expect(lower.some(a => a.includes('bachelor'))).toBe(true);
  });

  it('expands yes/no aliases', () => {
    const aliases = expandValueAliases('yes_no', 'Yes');
    expect(aliases).toContain('Yes');
    expect(aliases).toContain('Y');
    expect(aliases.length).toBeGreaterThan(2);
  });

  it('expands years of experience', () => {
    const aliases = expandValueAliases('years_of_experience', '5');
    expect(aliases).toContain('5');
    expect(aliases.some(a => a.includes('year'))).toBe(true);
  });

  it('returns [value] for unknown key', () => {
    const aliases = expandValueAliases('random_key_xyz', 'hello');
    expect(aliases).toEqual(['hello']);
  });

  it('returns [value] for undefined key', () => {
    expect(expandValueAliases(undefined, 'test')).toEqual(['test']);
  });

  it('hasValueAliases returns true for known keys', () => {
    expect(hasValueAliases('gender')).toBe(true);
    expect(hasValueAliases('degree')).toBe(true);
    expect(hasValueAliases('yes_no')).toBe(true);
  });

  it('hasValueAliases returns false for unknown keys', () => {
    expect(hasValueAliases('email')).toBe(false);
    expect(hasValueAliases(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COUNTRY ALIASES
// ═══════════════════════════════════════════════════════════════════════════════

describe('Country Aliases', () => {
  describe('resolveCountry', () => {
    it('resolves by name', () => {
      const result = resolveCountry('United States');
      expect(result).not.toBeNull();
      expect(result!.iso2).toBe('US');
      expect(result!.callingCode).toBe('1');
    });

    it('resolves case-insensitively', () => {
      expect(resolveCountry('india')).not.toBeNull();
      expect(resolveCountry('INDIA')!.iso2).toBe('IN');
    });

    it('resolves by ISO2 code', () => {
      const result = resolveCountry('IN');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('India');
    });

    it('returns null for unknown country', () => {
      expect(resolveCountry('Atlantis')).toBeNull();
    });
  });

  describe('expandCountryAliases', () => {
    it('returns multiple alias forms', () => {
      const aliases = expandCountryAliases('India');
      expect(aliases).toContain('India');
      expect(aliases).toContain('IN');
      expect(aliases.some(a => a.includes('+91'))).toBe(true);
    });

    it('returns [value] for unrecognized country', () => {
      expect(expandCountryAliases('Narnia')).toEqual(['Narnia']);
    });
  });

  describe('stripCountryCode', () => {
    it('strips calling code from phone number', () => {
      const result = stripCountryCode('+919876543210', 'India');
      expect(result).toBe('9876543210');
    });

    it('returns original for unrecognized country', () => {
      expect(stripCountryCode('+999123', 'Atlantis')).toBe('+999123');
    });
  });

  describe('ensureCountryCode', () => {
    it('adds calling code if missing', () => {
      const result = ensureCountryCode('9876543210', 'India');
      expect(result).toBe('+919876543210');
    });

    it('does not double-add calling code', () => {
      const result = ensureCountryCode('+919876543210', 'India');
      expect(result).toBe('+919876543210');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VALUE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Value Validation', () => {
  it('accepts valid email', () => {
    expect(validateLearnedValue('email', 'user@example.com')).toBe(true);
  });

  it('accepts valid URL', () => {
    expect(validateLearnedValue('linkedin_url', 'https://linkedin.com/in/user')).toBe(true);
  });

  it('accepts valid phone number', () => {
    expect(validateLearnedValue('phone_number', '+1234567890')).toBe(true);
  });

  it('rejects empty value', () => {
    expect(validateLearnedValue('email', '')).toBe(false);
  });

  it('rejects value over 200 chars (essay safety cap)', () => {
    const longValue = 'a'.repeat(201);
    expect(validateLearnedValue('first_name', longValue)).toBe(false);
  });

  it('accepts normal text for generic keys', () => {
    expect(validateLearnedValue('first_name', 'John')).toBe(true);
    expect(validateLearnedValue('city', 'San Francisco')).toBe(true);
  });

  it('accepts ISO date for date_of_birth', () => {
    expect(validateLearnedValue('date_of_birth', '1990-06-15')).toBe(true);
  });

  it('rejects non-ISO format for date_of_birth (capture normalizes before save)', () => {
    expect(validateLearnedValue('date_of_birth', '15/06/1990')).toBe(false);
    expect(validateLearnedValue('date_of_birth', '15-Jun-1990')).toBe(false);
  });

  it('accepts ISO date for joining_date and graduation_date', () => {
    expect(validateLearnedValue('joining_date', '2025-03-01')).toBe(true);
    expect(validateLearnedValue('graduation_date', '2018-05')).toBe(true);
  });

  it('rejects nonsense for date keys', () => {
    expect(validateLearnedValue('joining_date', 'asap')).toBe(false);
    expect(validateLearnedValue('date_of_birth', 'soon')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COSINE SIMILARITY (embedder.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cosine Similarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns ~0 for orthogonal vectors', () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD LEARNER
// ═══════════════════════════════════════════════════════════════════════════════

describe('Field Learner', () => {
  describe('inferCanonicalKey', () => {
    it('recognizes email via autocomplete', () => {
      expect(inferCanonicalKey(makeSig({ autocomplete: 'email' }))).toBe('email');
    });

    it('rejects password (sensitive)', () => {
      expect(inferCanonicalKey(makeSig({ autocomplete: 'current-password' }))).toBe('');
    });

    it('recognizes LinkedIn from label', () => {
      const key = inferCanonicalKey(makeSig({ label: 'LinkedIn URL' }));
      expect(key).toBe('linkedin_url');
    });

    it('recognizes GitHub from label', () => {
      const key = inferCanonicalKey(makeSig({ label: 'GitHub Profile' }));
      expect(key).toBe('github_url');
    });

    it('returns null for question-like labels (Q&A, not profile)', () => {
      const key = inferCanonicalKey(makeSig({ label: 'What motivates you to apply?' }));
      expect(key).toBeNull();
    });

    it('rejects SSN (sensitive)', () => {
      const key = inferCanonicalKey(makeSig({ label: 'Social Security Number' }));
      expect(key).toBe('');
    });

    it('recognizes phone from autocomplete', () => {
      expect(inferCanonicalKey(makeSig({ autocomplete: 'tel' }))).toBe('phone_number');
    });

    it('recognizes first name from label', () => {
      const key = inferCanonicalKey(makeSig({ label: 'First Name' }));
      expect(key).toBe('first_name');
    });
  });

  describe('inferDisplayLabel', () => {
    it('prefers label over placeholder', () => {
      const label = inferDisplayLabel(makeSig({ label: 'Email Address', placeholder: 'enter email' }));
      expect(label).toBe('Email Address');
    });

    it('falls back to placeholder when label is empty', () => {
      const label = inferDisplayLabel(makeSig({ placeholder: 'Enter your name' }));
      expect(label).toBe('Enter your name');
    });

    it('falls back to name attribute', () => {
      const label = inferDisplayLabel(makeSig({ name: 'email_field' }));
      expect(label).toBe('Email_field');
    });

    it('returns "Learned Field" when nothing available', () => {
      expect(inferDisplayLabel(makeSig())).toBe('Learned Field');
    });
  });

  describe('inferCategory', () => {
    it('maps email to contact', () => {
      expect(inferCategory('email')).toBe('contact');
    });

    it('maps degree to education', () => {
      expect(inferCategory('degree')).toBe('education');
    });

    it('maps current_company to work', () => {
      expect(inferCategory('current_company')).toBe('work');
    });

    it('maps linkedin_url to social', () => {
      expect(inferCategory('linkedin_url')).toBe('social');
    });

    it('maps unknown key to other', () => {
      expect(inferCategory('random_xyz')).toBe('other');
    });
  });

  describe('normalizeFieldValue', () => {
    it('strips emoji flags from country values', () => {
      const result = normalizeFieldValue('country', '\u{1F1EE}\u{1F1F3} India');
      expect(result).not.toContain('\u{1F1EE}');
    });

    it('passes through non-country values unchanged', () => {
      expect(normalizeFieldValue('email', 'user@test.com')).toBe('user@test.com');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS STORE (requires chrome.storage.local mock from setup.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Settings Store', () => {
  it('returns defaults when nothing stored', async () => {
    const settings = await getSettings();
    expect(settings.autoSave).toBe(true);
    expect(settings.cloudSync).toBe(true);
    expect(settings.showGhostText).toBe(true);
    expect(settings.blockSensitiveDomains).toBe(true);
  });

  it('cloudSync defaults to true', async () => {
    expect(DEFAULT_SETTINGS.cloudSync).toBe(true);
  });

  it('deep merges partial updates', async () => {
    await updateSettings({ autoSave: false });
    const settings = await getSettings();
    expect(settings.autoSave).toBe(false);
    expect(settings.cloudSync).toBe(true); // unchanged
    expect(settings.showGhostText).toBe(true); // unchanged
  });

  it('handles nested aiProvider merge', async () => {
    await updateSettings({ aiProvider: { provider: 'gemini' } });
    const settings = await getSettings();
    expect(settings.aiProvider.provider).toBe('gemini');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE STORE (requires chrome.storage.local mock from setup.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Profile Store', () => {
  describe('CRUD basics', () => {
    it('adds and retrieves an entry', async () => {
      const entry = await addEntry({
        canonical_key: 'email',
        display_label: 'Email',
        aliases: [],
        value: 'user@test.com',
        category: 'contact',
        source: 'manual',
        sensitive: false,
      });
      expect(entry.id).toBeTruthy();
      expect(entry.canonical_key).toBe('email');

      const all = await getAllEntries();
      expect(all.length).toBe(1);
      expect(all[0].value).toBe('user@test.com');
    });
  });

  describe('Multi-value alternatives', () => {
    it('getMaxAlternatives returns 5', () => {
      expect(getMaxAlternatives()).toBe(5);
    });

    it('detects duplicate values case-insensitively', async () => {
      await addEntry({
        canonical_key: 'email',
        display_label: 'Email',
        aliases: [],
        value: 'User@Test.com',
        category: 'contact',
        source: 'manual',
        sensitive: false,
      });
      expect(await hasDuplicateValue('email', 'user@test.com')).toBe(true);
      expect(await hasDuplicateValue('email', 'other@test.com')).toBe(false);
    });

    it('getEntriesByKey returns sorted by priority', async () => {
      await addEntry({
        canonical_key: 'phone_number',
        display_label: 'Phone 1',
        aliases: [],
        value: '+1111111111',
        category: 'contact',
        source: 'manual',
        sensitive: false,
      });
      await addEntry({
        canonical_key: 'phone_number',
        display_label: 'Phone 2',
        aliases: [],
        value: '+2222222222',
        category: 'contact',
        source: 'manual',
        sensitive: false,
      });

      const entries = await getEntriesByKey('phone_number');
      expect(entries.length).toBe(2);
      expect(entries[0].priority).toBeLessThanOrEqual(entries[1].priority);
    });
  });

  describe('healProfile', () => {
    it('removes junk canonical keys', async () => {
      await addEntry({
        canonical_key: 'question_1',
        display_label: 'Test',
        aliases: [],
        value: 'answer',
        category: 'other',
        source: 'learned',
        sensitive: false,
      });
      const result = await healProfile();
      expect(result.removed).toBeGreaterThanOrEqual(1);
    });

    it('removes bracket-notation keys', async () => {
      await addEntry({
        canonical_key: 'field[0]',
        display_label: 'Test',
        aliases: [],
        value: 'answer',
        category: 'other',
        source: 'learned',
        sensitive: false,
      });
      const result = await healProfile();
      expect(result.removed).toBeGreaterThanOrEqual(1);
    });

    it('removes long digit values under non-numeric keys', async () => {
      await addEntry({
        canonical_key: 'email',
        display_label: 'Email',
        aliases: [],
        value: '1234567890123',
        category: 'contact',
        source: 'learned',
        sensitive: false,
      });
      const result = await healProfile();
      expect(result.removed).toBeGreaterThanOrEqual(1);
    });

    it('keeps phone numbers with digit values', async () => {
      await addEntry({
        canonical_key: 'phone_number',
        display_label: 'Phone',
        aliases: [],
        value: '+1234567890',
        category: 'contact',
        source: 'manual',
        sensitive: false,
      });
      await healProfile();
      const all = await getAllEntries();
      expect(all.some(e => e.canonical_key === 'phone_number')).toBe(true);
    });

    it('keeps valid entries intact', async () => {
      await addEntry({
        canonical_key: 'first_name',
        display_label: 'First Name',
        aliases: [],
        value: 'John',
        category: 'contact',
        source: 'manual',
        sensitive: false,
      });
      await healProfile();
      const all = await getAllEntries();
      expect(all.some(e => e.value === 'John')).toBe(true);
    });
  });
});

// ── computeFillAction (Phase AD.2 — confidence bands) ─────────────────────────

describe('computeFillAction', () => {
  test('MATCHED above FILL_THRESHOLD → fill', () => {
    expect(computeFillAction({ status: 'MATCHED', confidence: 0.99 })).toBe('fill');
    expect(computeFillAction({ status: 'MATCHED', confidence: FILL_THRESHOLD })).toBe('fill');
    expect(computeFillAction({ status: 'MATCHED', confidence: 0.95 })).toBe('fill');
  });

  test('MATCHED in [REVIEW, FILL) range → review', () => {
    expect(computeFillAction({ status: 'MATCHED', confidence: 0.89 })).toBe('review');
    expect(computeFillAction({ status: 'MATCHED', confidence: 0.80 })).toBe('review');
    expect(computeFillAction({ status: 'MATCHED', confidence: REVIEW_THRESHOLD })).toBe('review');
  });

  test('MATCHED below REVIEW_THRESHOLD → flag', () => {
    expect(computeFillAction({ status: 'MATCHED', confidence: 0.69 })).toBe('flag');
    expect(computeFillAction({ status: 'MATCHED', confidence: 0.50 })).toBe('flag');
    expect(computeFillAction({ status: 'MATCHED', confidence: 0 })).toBe('flag');
  });

  test('MATCHED with no confidence defaults to flag', () => {
    expect(computeFillAction({ status: 'MATCHED' })).toBe('flag');
  });

  test('UNKNOWN always flags regardless of confidence', () => {
    expect(computeFillAction({ status: 'UNKNOWN' })).toBe('flag');
    expect(computeFillAction({ status: 'UNKNOWN', confidence: 0.99 })).toBe('flag');
  });

  test('SKIP / ESSAY / FILE_UPLOAD bypass fillAction entirely', () => {
    expect(computeFillAction({ status: 'SKIP' })).toBeUndefined();
    expect(computeFillAction({ status: 'ESSAY' })).toBeUndefined();
    expect(computeFillAction({ status: 'FILE_UPLOAD', confidence: 0.95 })).toBeUndefined();
  });

  test('matchField stamps fillAction on the returned MatchResult', () => {
    // High-confidence rule match (autocomplete=email → 0.99) should land in fill band.
    // Lower-bound proof that the stamping wrapper actually fires.
    const { matchField } = require('../matcher');
    const result = matchField(
      {
        label: 'Email', placeholder: '', name: 'email', id: '',
        ariaLabel: '', autocomplete: 'email', inputType: 'text',
        maxLength: null, surroundingText: '',
      },
      [{ id: '1', userId: 'u', canonical_key: 'email', display_label: '',
         aliases: [], value: 'a@b.co', category: 'contact', source: 'manual',
         sensitive: false, created_at: 0, updated_at: 0, use_count: 0, priority: 0 }],
      new Map(),
      'example.com',
    );
    expect(result.status).toBe('MATCHED');
    expect(result.fillAction).toBe('fill');
  });
});
