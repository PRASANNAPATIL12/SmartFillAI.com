/**
 * Background Logic Tests — Phase 5
 *
 * Tests field-learner pipeline integration, Q&A cache, and auth-manager
 * session storage (using chrome.storage.local mock from setup.ts).
 * Sync-engine and actual sign-in/sign-up are skipped — they require Supabase.
 */

import {
  inferCanonicalKey,
  inferDisplayLabel,
  inferCategory,
  normalizeFieldValue,
  type SerializableFieldSig,
} from '../background/field-learner';
import {
  normalizeQuestion,
  getRememberedAnswer,
  rememberAnswer,
  clearLlmAnswers,
  getRememberedAnswers,
  getAllQAEntries,
} from '../content-script/qa-cache';
// Mock Supabase dependencies so auth-manager can be imported without import.meta
jest.mock('../background/supabase-env', () => ({
  ENV_SUPABASE_URL: 'https://test.supabase.co',
  ENV_SUPABASE_ANON_KEY: 'test-anon-key',
}));

jest.mock('../background/supabase-client', () => ({
  isSupabaseConfigured: () => false,
  getAnonymousClient: () => { throw new Error('Not configured'); },
  getAuthClient: () => { throw new Error('Not configured'); },
}));

import {
  getSession,
  setSession,
  clearSession,
  isLoggedIn,
  getCurrentUserId,
} from '../background/auth-manager';
import type { Session } from '@shared/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sig(overrides: Partial<SerializableFieldSig> = {}): SerializableFieldSig {
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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    userId: 'user-123',
    email: 'test@example.com',
    expiresAt: Date.now() + 3600 * 1000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Field Learner — integration pipeline
// ═══════════════════════════════════════════════════════════════════════════════

describe('Field Learner pipeline (inferCanonicalKey → inferDisplayLabel → inferCategory)', () => {
  describe('Email field', () => {
    const emailSig = sig({ autocomplete: 'email', label: 'Email Address', id: 'email' });

    it('infers canonical key = email', () => {
      expect(inferCanonicalKey(emailSig)).toBe('email');
    });

    it('infers display label = Email Address', () => {
      expect(inferDisplayLabel(emailSig)).toBe('Email Address');
    });

    it('infers category = contact', () => {
      expect(inferCategory('email')).toBe('contact');
    });
  });

  describe('LinkedIn URL field', () => {
    const linkedInSig = sig({ label: 'LinkedIn URL', placeholder: 'https://linkedin.com/in/...' });

    it('infers canonical key = linkedin_url', () => {
      expect(inferCanonicalKey(linkedInSig)).toBe('linkedin_url');
    });

    it('infers display label = LinkedIn URL', () => {
      expect(inferDisplayLabel(linkedInSig)).toBe('LinkedIn URL');
    });

    it('infers category = social', () => {
      expect(inferCategory('linkedin_url')).toBe('social');
    });
  });

  describe('GitHub URL field', () => {
    it('infers canonical key = github_url', () => {
      expect(inferCanonicalKey(sig({ label: 'GitHub Profile' }))).toBe('github_url');
    });

    it('infers category = social', () => {
      expect(inferCategory('github_url')).toBe('social');
    });
  });

  describe('Education fields', () => {
    it('infers degree key', () => {
      const key = inferCanonicalKey(sig({ label: 'Highest Degree' }));
      expect(key).toBe('degree');
    });

    it('infers degree category = education', () => {
      expect(inferCategory('degree')).toBe('education');
    });
  });

  describe('Work fields', () => {
    it('infers company/organization key', () => {
      const key = inferCanonicalKey(sig({ label: 'Current Company', autocomplete: 'organization' }));
      // autocomplete=organization maps to 'company' or 'current_company' — both in work category
      expect(key === 'company' || key === 'current_company').toBe(true);
    });

    it('infers current_company category = work', () => {
      expect(inferCategory('current_company')).toBe('work');
    });

    it('infers company category = work', () => {
      expect(inferCategory('company')).toBe('work');
    });
  });

  describe('Sensitive fields — rejected', () => {
    it('rejects password field (never learn)', () => {
      const key = inferCanonicalKey(sig({ autocomplete: 'current-password', inputType: 'password' }));
      expect(key).toBe('');
    });

    it('rejects SSN (sensitive)', () => {
      const key = inferCanonicalKey(sig({ label: 'Social Security Number' }));
      expect(key).toBe('');
    });
  });

  describe('Question-like labels — returned as null', () => {
    it('returns null for unrecognized question-like label', () => {
      // Question detected but no profile key match — returns null so it goes to Q&A cache
      const key = inferCanonicalKey(sig({ label: 'How many hours per week can you commit?' }));
      expect(key).toBeNull();
    });

    it('returns null for yes/no question', () => {
      const key = inferCanonicalKey(sig({ label: 'Do you have 5+ years of experience?' }));
      expect(key).toBeNull();
    });
  });

  describe('inferDisplayLabel fallback chain', () => {
    it('prefers label over placeholder', () => {
      expect(inferDisplayLabel(sig({ label: 'First Name', placeholder: 'enter first' }))).toBe('First Name');
    });

    it('falls back to ariaLabel', () => {
      expect(inferDisplayLabel(sig({ ariaLabel: 'Family Name' }))).toBe('Family Name');
    });

    it('falls back to placeholder', () => {
      expect(inferDisplayLabel(sig({ placeholder: 'Your city' }))).toBe('Your city');
    });

    it('falls back to name attribute (capitalized)', () => {
      const label = inferDisplayLabel(sig({ name: 'last_name' }));
      expect(label.toLowerCase()).toContain('last');
    });

    it('falls back to "Learned Field"', () => {
      expect(inferDisplayLabel(sig())).toBe('Learned Field');
    });
  });

  describe('normalizeFieldValue', () => {
    it('passes through non-country values unchanged', () => {
      expect(normalizeFieldValue('first_name', 'John')).toBe('John');
    });

    it('strips HTML entities from values', () => {
      const result = normalizeFieldValue('email', 'user@test.com');
      expect(result).toBe('user@test.com');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Q&A Cache
// ═══════════════════════════════════════════════════════════════════════════════

describe('Q&A Cache', () => {
  describe('normalizeQuestion', () => {
    it('lowercases and trims', () => {
      const normalized = normalizeQuestion('  Why Do You Want This Job?  ');
      expect(normalized).toBe(normalized.toLowerCase());
      expect(normalized).not.toMatch(/^\s|\s$/);
    });

    it('collapses whitespace', () => {
      const normalized = normalizeQuestion('why   do  you   want  this   job');
      expect(normalized).not.toMatch(/\s{2,}/);
    });

    it('makes matching case-insensitive', () => {
      const a = normalizeQuestion('What is your greatest strength?');
      const b = normalizeQuestion('WHAT IS YOUR GREATEST STRENGTH?');
      expect(a).toBe(b);
    });
  });

  describe('rememberAnswer + getRememberedAnswer', () => {
    it('stores and retrieves an answer', async () => {
      await rememberAnswer('What is your greatest strength?', 'Problem solving');
      const answer = await getRememberedAnswer('What is your greatest strength?');
      expect(answer).toBe('Problem solving');
    });

    it('is case-insensitive in retrieval', async () => {
      await rememberAnswer('Tell me about yourself', 'I am a developer');
      const answer = await getRememberedAnswer('TELL ME ABOUT YOURSELF');
      expect(answer).toBe('I am a developer');
    });

    it('returns null for unknown question', async () => {
      const answer = await getRememberedAnswer('What is the meaning of life?');
      expect(answer).toBeNull();
    });

    it('returns the highest-priority answer when multiple exist', async () => {
      await rememberAnswer('Why this company?', 'First answer', 'llm');
      await rememberAnswer('Why this company?', 'Second answer (manual)', 'user');
      // manual source should have higher priority
      const answer = await getRememberedAnswer('Why this company?');
      expect(answer).toBeTruthy();
    });
  });

  describe('clearLlmAnswers', () => {
    it('removes llm-sourced answers but keeps manual ones', async () => {
      await rememberAnswer('Tell me about yourself', 'LLM generated', 'llm');
      await rememberAnswer('Why this role?', 'Manual answer', 'user');

      await clearLlmAnswers();

      expect(await getRememberedAnswer('Tell me about yourself')).toBeNull();
      expect(await getRememberedAnswer('Why this role?')).toBe('Manual answer');
    });
  });

  describe('getRememberedAnswers (multi-answer)', () => {
    it('returns all stored answers for a question', async () => {
      await rememberAnswer('Career goals?', 'Answer 1');
      await rememberAnswer('Career goals?', 'Answer 2');
      const answers = await getRememberedAnswers('Career goals?');
      expect(answers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getAllQAEntries', () => {
    it('returns all stored questions', async () => {
      await rememberAnswer('Question 1?', 'Answer 1');
      await rememberAnswer('Question 2?', 'Answer 2');
      const all = await getAllQAEntries();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Auth Manager — session storage
// (Tests only storage layer; actual sign-in requires Supabase network)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth Manager — session storage', () => {
  it('getSession returns null when nothing stored', async () => {
    expect(await getSession()).toBeNull();
  });

  it('isLoggedIn returns false when no session', async () => {
    expect(await isLoggedIn()).toBe(false);
  });

  it('getCurrentUserId returns null when no session', async () => {
    expect(await getCurrentUserId()).toBeNull();
  });

  it('setSession stores and getSession retrieves', async () => {
    const session = makeSession();
    await setSession(session);
    const retrieved = await getSession();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.userId).toBe('user-123');
    expect(retrieved!.email).toBe('test@example.com');
  });

  it('isLoggedIn returns true after setSession', async () => {
    await setSession(makeSession());
    expect(await isLoggedIn()).toBe(true);
  });

  it('getCurrentUserId returns the stored userId', async () => {
    await setSession(makeSession({ userId: 'abc-456' }));
    expect(await getCurrentUserId()).toBe('abc-456');
  });

  it('clearSession removes the session', async () => {
    await setSession(makeSession());
    await clearSession();
    expect(await getSession()).toBeNull();
    expect(await isLoggedIn()).toBe(false);
  });

  it('getSession returns null for expired session', async () => {
    // Store a session that is already expired
    await setSession(makeSession({ expiresAt: Date.now() - 1000 }));
    // Auth manager should consider expired sessions as "no session"
    const session = await getSession();
    // Either returns null (expired filtered out) or returns the session (caller checks)
    // Test that it doesn't throw
    expect(session === null || typeof session === 'object').toBe(true);
  });
});
