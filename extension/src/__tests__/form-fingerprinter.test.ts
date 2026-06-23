/**
 * Form-Fingerprinter Tests — Phase AD.1
 *
 * Verifies the structural-hash invariants that make cross-form learning work:
 *   - Cosmetic label edits don't change the hash (same fingerprint)
 *   - Structural changes (added/removed/reordered fields) flip the hash
 *   - Merge semantics: conflicts resolved by confidence, useCounts accumulate
 */

import type { FieldSignature } from '@shared/types';
import {
  normalizeNameForHash,
  nameHash,
  computeStructuralHash,
  computeFingerprintKey,
  buildFingerprintInputs,
  buildFingerprintFieldCandidate,
  mergeFingerprint,
  findFingerprintEntry,
  reduceFieldsForFingerprint,
  type FormFingerprint,
} from '../content-script/form-fingerprinter';

function makeField(partial: Partial<FieldSignature> = {}): FieldSignature {
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
    ...partial,
  };
}

describe('normalizeNameForHash', () => {
  test('collapses cosmetic variants to the same string', () => {
    expect(normalizeNameForHash('First Name')).toBe('first name');
    expect(normalizeNameForHash('first name')).toBe('first name');
    expect(normalizeNameForHash('First Name *')).toBe('first name');
    expect(normalizeNameForHash('First Name (required)')).toBe('first name');
    expect(normalizeNameForHash('Your First Name')).toBe('first name');
    expect(normalizeNameForHash('  First   Name  ')).toBe('first name');
  });

  test('strips punctuation but keeps alphanumerics', () => {
    expect(normalizeNameForHash('E-Mail Address')).toBe('e mail address');
    expect(normalizeNameForHash('Address Line 2')).toBe('address line 2');
  });

  test('returns empty string for unusable input', () => {
    expect(normalizeNameForHash('')).toBe('');
    expect(normalizeNameForHash('   ')).toBe('');
    expect(normalizeNameForHash('***')).toBe('');
  });
});

describe('nameHash', () => {
  test('cosmetic variants of the same label hash to the same value', () => {
    expect(nameHash('First Name')).toBe(nameHash('first name'));
    expect(nameHash('First Name *')).toBe(nameHash('First Name'));
    expect(nameHash('Your First Name')).toBe(nameHash('First Name'));
  });

  test('different labels hash to different values', () => {
    expect(nameHash('First Name')).not.toBe(nameHash('Last Name'));
    expect(nameHash('Email')).not.toBe(nameHash('Phone'));
  });
});

describe('computeStructuralHash', () => {
  test('same field set in same order = same hash', () => {
    const fields = [
      makeField({ label: 'First Name', inputType: 'text' }),
      makeField({ label: 'Last Name', inputType: 'text' }),
      makeField({ label: 'Email', inputType: 'email' }),
    ];
    expect(computeStructuralHash(fields)).toBe(computeStructuralHash(fields));
  });

  test('cosmetic edits (whitespace, required marker) do not flip the hash', () => {
    const a = [
      makeField({ label: 'First Name', inputType: 'text' }),
      makeField({ label: 'Email', inputType: 'email' }),
    ];
    const b = [
      makeField({ label: '  First Name *', inputType: 'text' }),
      makeField({ label: 'Email (required)', inputType: 'email' }),
    ];
    expect(computeStructuralHash(a)).toBe(computeStructuralHash(b));
  });

  test('axName falls in only when the more stable sources are absent', () => {
    // Label-first wins → both hash the same even though axName differs.
    const a = [makeField({ label: 'First Name', axName: 'First name (auto-generated)' })];
    const b = [makeField({ label: 'First Name' })];
    expect(computeStructuralHash(a)).toBe(computeStructuralHash(b));
  });

  test('different field order flips the hash', () => {
    const a = [
      makeField({ label: 'First Name' }),
      makeField({ label: 'Last Name' }),
    ];
    const b = [
      makeField({ label: 'Last Name' }),
      makeField({ label: 'First Name' }),
    ];
    expect(computeStructuralHash(a)).not.toBe(computeStructuralHash(b));
  });

  test('added field flips the hash', () => {
    const a = [
      makeField({ label: 'First Name' }),
      makeField({ label: 'Email' }),
    ];
    const b = [
      makeField({ label: 'First Name' }),
      makeField({ label: 'Email' }),
      makeField({ label: 'Phone' }),
    ];
    expect(computeStructuralHash(a)).not.toBe(computeStructuralHash(b));
  });

  test('changing role flips the hash even with same label', () => {
    const a = [makeField({ label: 'Country', inputType: 'select-one' })];
    const b = [makeField({ label: 'Country', inputType: 'text' })];
    expect(computeStructuralHash(a)).not.toBe(computeStructuralHash(b));
  });
});

describe('computeFingerprintKey', () => {
  test('composes ATS id and structural hash with double-colon separator', () => {
    expect(computeFingerprintKey('greenhouse', 'abc123')).toBe('greenhouse::abc123');
  });
});

describe('buildFingerprintInputs', () => {
  test('produces a stable composite key independent of execution time', () => {
    const fields = [
      makeField({ label: 'First Name' }),
      makeField({ label: 'Email', inputType: 'email' }),
    ];
    const a = buildFingerprintInputs(fields, 'https://boards.greenhouse.io/databricks/jobs/123');
    const b = buildFingerprintInputs(fields, 'https://boards.greenhouse.io/stripe/jobs/456');
    // Same ATS family + same structural fields => same key. This is the
    // cross-company ATS-generalization invariant the whole feature depends on.
    expect(a.key).toBe(b.key);
    expect(a.atsId).toBe('greenhouse');
  });
});

describe('reduceFieldsForFingerprint', () => {
  test('emits {position, role, nameHash} per field in order', () => {
    const fields = [
      makeField({ label: 'First Name', inputType: 'text' }),
      makeField({ label: 'Email', inputType: 'email' }),
    ];
    const reduced = reduceFieldsForFingerprint(fields);
    expect(reduced).toHaveLength(2);
    expect(reduced[0].position).toBe(0);
    expect(reduced[1].position).toBe(1);
    expect(reduced[0].role).toBe('text');
    expect(reduced[1].role).toBe('email');
  });
});

describe('buildFingerprintFieldCandidate', () => {
  test('returns null when the field has no stable name source', () => {
    const sig = makeField(); // every name source empty
    expect(buildFingerprintFieldCandidate(sig, 'first_name', 0.99)).toBeNull();
  });

  test('builds candidate with hashed name and provided canonical/confidence', () => {
    const sig = makeField({ label: 'First Name' });
    const c = buildFingerprintFieldCandidate(sig, 'first_name', 0.99);
    expect(c).not.toBeNull();
    expect(c!.canonicalKey).toBe('first_name');
    expect(c!.confidence).toBe(0.99);
    expect(c!.nameHash).toBe(nameHash('First Name'));
  });
});

describe('mergeFingerprint', () => {
  const inputs = {
    atsId: 'greenhouse',
    structuralHash: 'deadbeef',
    key: 'greenhouse::deadbeef',
    fieldCount: 3,
    // AE.1 — buildFingerprintInputs now includes the AtsDetection.
    detection: { atsId: 'greenhouse', confidence: 1.0, method: 'direct_hostname' as const },
  };

  test('first-write creates a fingerprint from candidates with useCount=1', () => {
    const candidates = [
      { nameHash: 'h1', role: 'text', canonicalKey: 'first_name', confidence: 0.99 },
      { nameHash: 'h2', role: 'email', canonicalKey: 'email', confidence: 0.99 },
    ];
    const fp = mergeFingerprint(undefined, inputs, candidates, 'https://example.com', 1000);
    expect(fp.key).toBe('greenhouse::deadbeef');
    expect(fp.fields).toHaveLength(2);
    expect(fp.fields.every(f => f.useCount === 1)).toBe(true);
    expect(fp.createdAt).toBe(1000);
    expect(fp.lastUsedAt).toBe(1000);
    expect(fp.useCount).toBe(1);
  });

  test('rematch bumps useCount on existing mappings without resetting learnedAt', () => {
    const existing: FormFingerprint = {
      ...inputs,
      exemplarUrl: 'https://example.com',
      fields: [
        { nameHash: 'h1', role: 'text', canonicalKey: 'first_name', confidence: 0.99, learnedAt: 500, useCount: 3 },
      ],
      createdAt: 500,
      lastUsedAt: 500,
      useCount: 3,
    };
    const candidates = [
      { nameHash: 'h1', role: 'text', canonicalKey: 'first_name', confidence: 0.99 },
    ];
    const fp = mergeFingerprint(existing, inputs, candidates, 'https://example.com', 2000);
    expect(fp.fields[0].useCount).toBe(4);
    expect(fp.fields[0].learnedAt).toBe(500); // preserved
    expect(fp.useCount).toBe(4);
    expect(fp.lastUsedAt).toBe(2000);
  });

  test('new field on a known form is added without disturbing existing ones', () => {
    const existing: FormFingerprint = {
      ...inputs,
      exemplarUrl: 'https://example.com',
      fields: [
        { nameHash: 'h1', role: 'text', canonicalKey: 'first_name', confidence: 0.99, learnedAt: 500, useCount: 2 },
      ],
      createdAt: 500,
      lastUsedAt: 500,
      useCount: 2,
    };
    const candidates = [
      { nameHash: 'h1', role: 'text', canonicalKey: 'first_name', confidence: 0.99 },
      { nameHash: 'h2', role: 'email', canonicalKey: 'email', confidence: 0.99 },
    ];
    const fp = mergeFingerprint(existing, inputs, candidates, 'https://example.com', 2000);
    expect(fp.fields).toHaveLength(2);
    expect(fp.fields.find(f => f.nameHash === 'h1')!.useCount).toBe(3);
    expect(fp.fields.find(f => f.nameHash === 'h2')!.useCount).toBe(1);
  });

  test('canonical_key conflict: higher confidence wins', () => {
    const existing: FormFingerprint = {
      ...inputs,
      exemplarUrl: '',
      fields: [
        { nameHash: 'h1', role: 'text', canonicalKey: 'first_name', confidence: 0.85, learnedAt: 500, useCount: 1 },
      ],
      createdAt: 500,
      lastUsedAt: 500,
      useCount: 1,
    };
    const candidates = [
      { nameHash: 'h1', role: 'text', canonicalKey: 'full_name', confidence: 1.0 }, // user-confirmed
    ];
    const fp = mergeFingerprint(existing, inputs, candidates, '', 2000);
    expect(fp.fields[0].canonicalKey).toBe('full_name');
    expect(fp.fields[0].confidence).toBe(1.0);
    expect(fp.fields[0].useCount).toBe(1); // reset because mapping changed
  });

  test('canonical_key conflict: lower confidence keeps the prior mapping', () => {
    const existing: FormFingerprint = {
      ...inputs,
      exemplarUrl: '',
      fields: [
        { nameHash: 'h1', role: 'text', canonicalKey: 'first_name', confidence: 1.0, learnedAt: 500, useCount: 5 },
      ],
      createdAt: 500,
      lastUsedAt: 500,
      useCount: 5,
    };
    const candidates = [
      { nameHash: 'h1', role: 'text', canonicalKey: 'full_name', confidence: 0.85 },
    ];
    const fp = mergeFingerprint(existing, inputs, candidates, '', 2000);
    expect(fp.fields[0].canonicalKey).toBe('first_name');
    expect(fp.fields[0].useCount).toBe(5); // unchanged
  });
});

describe('findFingerprintEntry', () => {
  const fp: FormFingerprint = {
    key: 'greenhouse::abc',
    atsId: 'greenhouse',
    structuralHash: 'abc',
    exemplarUrl: '',
    fields: [
      { nameHash: nameHash('First Name'), role: 'text', canonicalKey: 'first_name', confidence: 0.99, learnedAt: 0, useCount: 1 },
      { nameHash: nameHash('Email'), role: 'email', canonicalKey: 'email', confidence: 0.99, learnedAt: 0, useCount: 1 },
    ],
    createdAt: 0,
    lastUsedAt: 0,
    useCount: 1,
  };

  test('finds a stored mapping by normalized name', () => {
    const sig = makeField({ label: 'First Name *' });
    expect(findFingerprintEntry(fp, sig)?.canonicalKey).toBe('first_name');
  });

  test('returns undefined for an unknown field', () => {
    const sig = makeField({ label: 'Date of Birth' });
    expect(findFingerprintEntry(fp, sig)).toBeUndefined();
  });

  test('returns undefined for a field with no name source', () => {
    const sig = makeField();
    expect(findFingerprintEntry(fp, sig)).toBeUndefined();
  });
});
