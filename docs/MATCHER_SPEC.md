# Field Matcher Specification (Task 1.3)

## Overview
The matcher is the **core intelligence** of Ditto. It takes a form field signature and determines:
1. Should we skip this field? (password, captcha, etc.)
2. Do we have a profile entry that matches it?
3. Is this an essay question requiring AI generation?

**Performance target:** <100ms per page (all fields combined)

---

## Input: FieldSignature

```typescript
type FieldSignature = {
  /** Text of associated <label> element */
  label: string;
  
  /** Placeholder attribute */
  placeholder: string;
  
  /** Name attribute */
  name: string;
  
  /** ID attribute */
  id: string;
  
  /** aria-label attribute */
  ariaLabel: string;
  
  /** Input type (text, email, tel, textarea, etc.) */
  inputType: string;
  
  /** maxLength attribute (null if not set) */
  maxLength: number | null;
  
  /** Text content of surrounding elements (prev/next siblings, parent) */
  surroundingText: string;
  
  /** Element reference (for filling later) */
  element: HTMLElement;
};
```

**How to extract:**
```typescript
function extractFieldSignature(input: HTMLInputElement | HTMLTextAreaElement): FieldSignature {
  // Find associated label
  const labelText = (
    input.labels?.[0]?.textContent ||
    document.querySelector(`label[for="${input.id}"]`)?.textContent ||
    ''
  ).trim();

  // Get surrounding text (for context)
  const prevText = input.previousElementSibling?.textContent?.trim() || '';
  const nextText = input.nextElementSibling?.textContent?.trim() || '';
  const parentText = input.parentElement?.textContent?.trim() || '';
  const surroundingText = `${prevText} ${nextText} ${parentText}`.trim();

  return {
    label: labelText,
    placeholder: input.getAttribute('placeholder') || '',
    name: input.getAttribute('name') || '',
    id: input.getAttribute('id') || '',
    ariaLabel: input.getAttribute('aria-label') || '',
    inputType: input.tagName === 'TEXTAREA' ? 'textarea' : input.type,
    maxLength: input.maxLength > 0 ? input.maxLength : null,
    surroundingText,
    element: input,
  };
}
```

---

## Output: MatchResult

```typescript
type MatchResult = {
  /** Match status */
  status: 'MATCHED' | 'ESSAY' | 'UNKNOWN' | 'SKIP';
  
  /** If MATCHED: which profile entry to use */
  profileEntryId?: string;
  
  /** Confidence score (0-1) */
  confidence?: number;
  
  /** Why this decision was made (for debugging/learning) */
  reason?: string;
  
  /** Which step in waterfall matched (1-6, or null if SKIP) */
  matchStep?: number;
};
```

---

## The Waterfall

### Step 1: SKIP Check (Latency: <1ms)

**Purpose:** Immediately exclude fields we should never fill.

```typescript
function shouldSkip(signature: FieldSignature): boolean {
  const combined = [
    signature.label,
    signature.placeholder,
    signature.name,
    signature.id,
    signature.ariaLabel,
  ].join(' ').toLowerCase();

  // 1. Password fields
  if (signature.inputType === 'password') return true;

  // 2. Captcha
  if (/captcha|recaptcha|g-recaptcha|hcaptcha/i.test(combined)) return true;

  // 3. Hidden fields
  if (signature.inputType === 'hidden') return true;
  if (signature.element.offsetParent === null) return true; // visually hidden

  // 4. File inputs
  if (signature.inputType === 'file') return true;

  // 5. Search boxes (high false-positive risk)
  if (/search|query|q\b/i.test(combined)) return true;

  // 6. Credit card (explicitly out of scope)
  if (/card.?number|cvv|cvc|expir/i.test(combined)) return true;

  // 7. OTP/Verification codes
  if (/otp|verification.?code|2fa|mfa/i.test(combined)) return true;

  return false;
}
```

**If true:** Return `{ status: 'SKIP', reason: 'password field' }`

---

### Step 2: Cache Lookup (Latency: ~1ms)

**Purpose:** Fast path for fields we've seen before on this domain.

```typescript
type FieldCacheEntry = {
  /** Hash of domain + field signature */
  fingerprint: string;
  
  /** Which profile entry matched */
  profileEntryId: string;
  
  /** Confidence from original match */
  confidence: number;
  
  /** How many times we've used this cache entry successfully */
  useCount: number;
  
  /** Last used timestamp */
  lastUsed: number;
};

function generateFingerprint(domain: string, signature: FieldSignature): string {
  const key = `${domain}:${signature.name}:${signature.id}:${signature.label}`;
  return hashString(key); // Simple hash function
}

function lookupCache(signature: FieldSignature): MatchResult | null {
  const domain = window.location.hostname;
  const fingerprint = generateFingerprint(domain, signature);
  
  const cached = fieldCache.get(fingerprint);
  
  if (cached && cached.confidence > 0.9) {
    return {
      status: 'MATCHED',
      profileEntryId: cached.profileEntryId,
      confidence: cached.confidence,
      reason: `cache hit (used ${cached.useCount} times)`,
      matchStep: 2,
    };
  }
  
  return null;
}
```

**Cache hit rate target:** 70% after 1 week of use on familiar sites.

---

### Step 3: Essay Detection (Latency: ~1ms)

**Purpose:** Identify long-form text fields that need AI generation.

```typescript
function isEssayField(signature: FieldSignature): boolean {
  // Must be a textarea
  if (signature.inputType !== 'textarea') return false;

  // Large or unbounded max length
  if (signature.maxLength === null || signature.maxLength >= 300) {
    const combined = [
      signature.label,
      signature.placeholder,
      signature.name,
      signature.id,
    ].join(' ').toLowerCase();

    // Essay patterns
    const essayPatterns = [
      /why.*(interested|apply|want|fit|join)/i,
      /tell.*(us|me|about|yourself|experience)/i,
      /describe.*(your|experience|background|role)/i,
      /what.*(motivates|excites|brings|drew)/i,
      /cover.?letter/i,
      /additional.*(information|comments|details)/i,
      /personal.?statement/i,
      /essay/i,
      /write.*about/i,
    ];

    if (essayPatterns.some(pattern => pattern.test(combined))) {
      return true;
    }
  }

  return false;
}
```

**If true:** Return `{ status: 'ESSAY', reason: 'long-form essay question detected' }`

---

### Step 4: Deterministic Match (Latency: ~5ms)

**Purpose:** Match using regex/keyword rules organized by category.

#### Category: Contact

```typescript
const CONTACT_RULES = [
  // Email
  {
    pattern: /e.?mail|email.?address/i,
    canonical: 'email',
    confidence: 0.95,
  },
  {
    pattern: /\bemail\b/i,
    canonical: 'email',
    confidence: 0.90,
  },

  // Phone
  {
    pattern: /phone|mobile|cell|telephone/i,
    canonical: 'phone_number',
    confidence: 0.95,
  },
  {
    inputType: 'tel',
    canonical: 'phone_number',
    confidence: 0.98,
  },

  // Name
  {
    pattern: /full.?name|your.?name/i,
    canonical: 'full_name',
    confidence: 0.95,
  },
  {
    pattern: /first.?name|given.?name/i,
    canonical: 'first_name',
    confidence: 0.98,
  },
  {
    pattern: /last.?name|sur.?name|family.?name/i,
    canonical: 'last_name',
    confidence: 0.98,
  },

  // Address
  {
    pattern: /street|address.?line/i,
    canonical: 'street_address',
    confidence: 0.95,
  },
  {
    pattern: /\bcity\b/i,
    canonical: 'city',
    confidence: 0.92,
  },
  {
    pattern: /\bstate\b|province/i,
    canonical: 'state',
    confidence: 0.92,
  },
  {
    pattern: /zip|postal.?code/i,
    canonical: 'zip_code',
    confidence: 0.95,
  },
  {
    pattern: /\bcountry\b/i,
    canonical: 'country',
    confidence: 0.92,
  },
];
```

#### Category: Identity

```typescript
const IDENTITY_RULES = [
  {
    pattern: /date.?of.?birth|birth.?date|dob\b/i,
    canonical: 'date_of_birth',
    confidence: 0.95,
  },
  {
    pattern: /\bgender\b|sex\b/i,
    canonical: 'gender',
    confidence: 0.90,
  },
  {
    pattern: /pronouns/i,
    canonical: 'pronouns',
    confidence: 0.95,
  },
  {
    pattern: /nationality|citizenship/i,
    canonical: 'nationality',
    confidence: 0.92,
  },
];
```

#### Category: Education

```typescript
const EDUCATION_RULES = [
  {
    pattern: /university|college|school.?name/i,
    canonical: 'university',
    confidence: 0.90,
  },
  {
    pattern: /degree|major|field.?of.?study/i,
    canonical: 'degree',
    confidence: 0.88,
  },
  {
    pattern: /\bgpa\b|grade.?point/i,
    canonical: 'gpa',
    confidence: 0.95,
  },
  {
    pattern: /graduation.?(year|date)/i,
    canonical: 'graduation_year',
    confidence: 0.92,
  },
];
```

#### Category: Work

```typescript
const WORK_RULES = [
  {
    pattern: /current.?company|employer/i,
    canonical: 'current_company',
    confidence: 0.92,
  },
  {
    pattern: /job.?title|position|role/i,
    canonical: 'job_title',
    confidence: 0.88,
  },
  {
    pattern: /years.?of.?experience/i,
    canonical: 'years_of_experience',
    confidence: 0.95,
  },
];
```

#### Category: Social

```typescript
const SOCIAL_RULES = [
  {
    pattern: /linkedin|linkedin.?url/i,
    canonical: 'linkedin_url',
    confidence: 0.98,
  },
  {
    pattern: /github|github.?username/i,
    canonical: 'github_url',
    confidence: 0.98,
  },
  {
    pattern: /portfolio|personal.?website/i,
    canonical: 'portfolio_url',
    confidence: 0.92,
  },
  {
    pattern: /twitter|x.?handle/i,
    canonical: 'twitter_handle',
    confidence: 0.95,
  },
];
```

#### Category: Preferences

```typescript
const PREFERENCE_RULES = [
  {
    pattern: /t.?shirt.?size|shirt.?size/i,
    canonical: 'tshirt_size',
    confidence: 0.95,
  },
  {
    pattern: /dietary|food.?restrictions/i,
    canonical: 'dietary_restrictions',
    confidence: 0.92,
  },
  {
    pattern: /time.?zone/i,
    canonical: 'timezone',
    confidence: 0.92,
  },
];
```

**Matching logic:**
```typescript
function deterministicMatch(signature: FieldSignature, profile: ProfileEntry[]): MatchResult | null {
  const combined = [
    signature.label,
    signature.placeholder,
    signature.name,
    signature.id,
    signature.ariaLabel,
  ].join(' ');

  const allRules = [
    ...CONTACT_RULES,
    ...IDENTITY_RULES,
    ...EDUCATION_RULES,
    ...WORK_RULES,
    ...SOCIAL_RULES,
    ...PREFERENCE_RULES,
  ];

  for (const rule of allRules) {
    let matches = false;

    if (rule.pattern) {
      matches = rule.pattern.test(combined);
    } else if (rule.inputType) {
      matches = signature.inputType === rule.inputType;
    }

    if (matches) {
      // Find matching profile entry
      const entry = profile.find(p => p.canonical_key === rule.canonical);
      
      if (entry) {
        return {
          status: 'MATCHED',
          profileEntryId: entry.id,
          confidence: rule.confidence,
          reason: `deterministic match: ${rule.canonical}`,
          matchStep: 4,
        };
      }
    }
  }

  return null;
}
```

**Target:** 80% of common fields matched at this step.

---

### Step 5: Embedding Similarity (Latency: ~30ms)

**Purpose:** Catch synonyms and unusual phrasings using semantic similarity.

```typescript
async function embeddingMatch(signature: FieldSignature, profile: ProfileEntry[]): Promise<MatchResult | null> {
  // Lazy-load MiniLM model (only on first call)
  const embedder = await getEmbedder();

  // Compute embedding for field signature
  const query = `${signature.label} ${signature.placeholder} ${signature.ariaLabel}`.trim();
  const queryEmbedding = await embedder.embed(query);

  // Compare against all profile entry embeddings
  let bestMatch: { entry: ProfileEntry; score: number } | null = null;

  for (const entry of profile) {
    if (!entry.embedding) continue;

    const score = cosineSimilarity(queryEmbedding, entry.embedding);

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { entry, score };
    }
  }

  // Threshold: 0.85 (high confidence)
  if (bestMatch && bestMatch.score >= 0.85) {
    return {
      status: 'MATCHED',
      profileEntryId: bestMatch.entry.id,
      confidence: bestMatch.score,
      reason: `embedding match (similarity: ${bestMatch.score.toFixed(2)})`,
      matchStep: 5,
    };
  }

  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Coverage:** Another ~12% of fields (handles "Mobile Number" → phone_number, "University Name" → university, etc.)

---

### Step 6: LLM Classifier (Latency: ~500ms, Cost: ~$0.0001)

**Purpose:** Last resort for truly ambiguous fields. **Uses AI Provider abstraction.**

```typescript
import { AIProviderFactory } from '../ai-providers/factory';

async function llmClassify(unknownFields: FieldSignature[], profile: ProfileEntry[]): Promise<Map<string, MatchResult>> {
  if (unknownFields.length === 0) return new Map();

  // Batch all unknown fields into one API call
  const provider = await AIProviderFactory.getProvider();

  const profileKeys = profile.map(p => p.canonical_key);

  const prompt = `
Given these form fields and available profile entries, which profile entry matches each field?

Form fields:
${unknownFields.map((f, i) => `${i}. Label: "${f.label}", Placeholder: "${f.placeholder}", Name: "${f.name}"`).join('\n')}

Available profile entries:
${profileKeys.join(', ')}

Return JSON: { "0": "canonical_key_or_null", "1": "...", ... }
Only match if confident. Return null if no good match.
  `.trim();

  const response = await provider.chat({
    messages: [{ role: 'user', content: prompt }],
    responseFormat: 'json_object',
    temperature: 0.3,
    maxTokens: 500,
  });

  const result = JSON.parse(response.content);
  const matches = new Map<string, MatchResult>();

  unknownFields.forEach((field, i) => {
    const canonical = result[i.toString()];
    
    if (canonical && canonical !== 'null') {
      const entry = profile.find(p => p.canonical_key === canonical);
      
      if (entry) {
        matches.set(field.name || field.id, {
          status: 'MATCHED',
          profileEntryId: entry.id,
          confidence: 0.75, // LLM matches are less certain
          reason: `LLM classified as ${canonical}`,
          matchStep: 6,
        });
      }
    }
  });

  return matches;
}
```

**Coverage:** Another ~5% of fields.

**Cost:** $0.0001 per page (batched, only for 2+ ambiguous fields).

---

### Step 7: Tag as UNKNOWN

If all steps fail, return:
```typescript
{
  status: 'UNKNOWN',
  reason: 'no match found in waterfall',
}
```

These fields become candidates for the **learning loop** (user fills manually → we prompt "Save this?").

---

## Complete Matcher Implementation

Location: `extension/src/matcher.ts`

```typescript
import { FieldSignature, MatchResult, ProfileEntry } from './types';
import { lookupCache, saveToCache } from './storage/field-cache';
import { getProfile } from './storage/profile-store';
import { getEmbedder } from './embeddings';
import { AIProviderFactory } from './ai-providers/factory';

export async function matchFields(fields: FieldSignature[]): Promise<Map<string, MatchResult>> {
  const results = new Map<string, MatchResult>();
  const profile = await getProfile();
  const unknownFields: FieldSignature[] = [];

  for (const field of fields) {
    // Step 1: SKIP check
    if (shouldSkip(field)) {
      results.set(getFieldKey(field), { status: 'SKIP', reason: 'excluded field type' });
      continue;
    }

    // Step 2: Cache lookup
    const cached = lookupCache(field);
    if (cached) {
      results.set(getFieldKey(field), cached);
      continue;
    }

    // Step 3: Essay detection
    if (isEssayField(field)) {
      results.set(getFieldKey(field), { status: 'ESSAY', reason: 'essay question detected' });
      continue;
    }

    // Step 4: Deterministic match
    const deterministic = deterministicMatch(field, profile);
    if (deterministic) {
      results.set(getFieldKey(field), deterministic);
      saveToCache(field, deterministic); // Cache for next time
      continue;
    }

    // Step 5: Embedding match
    const embedding = await embeddingMatch(field, profile);
    if (embedding) {
      results.set(getFieldKey(field), embedding);
      saveToCache(field, embedding);
      continue;
    }

    // Collect for Step 6 (batched LLM classification)
    unknownFields.push(field);
  }

  // Step 6: LLM classification (batched)
  if (unknownFields.length >= 2) {
    const llmMatches = await llmClassify(unknownFields, profile);
    
    llmMatches.forEach((match, key) => {
      results.set(key, match);
    });
  }

  // Step 7: Remaining unknowns
  unknownFields.forEach(field => {
    const key = getFieldKey(field);
    if (!results.has(key)) {
      results.set(key, { status: 'UNKNOWN', reason: 'no match in waterfall' });
    }
  });

  return results;
}

function getFieldKey(field: FieldSignature): string {
  return field.name || field.id || field.label;
}
```

---

## Performance Targets

| Step | Latency | Success Rate | Notes |
|---|---|---|---|
| Step 1: SKIP | <1ms | 10-15% | Immediate exclusion |
| Step 2: Cache | ~1ms | 70% (after 1 week) | Fast path for repeat visits |
| Step 3: Essay | ~1ms | 5% | Rare but important |
| Step 4: Deterministic | ~5ms | 80% (on first visit) | Core matching logic |
| Step 5: Embedding | ~30ms | +12% | Handles synonyms |
| Step 6: LLM | ~500ms | +5% | Last resort, batched |
| **Total** | **<100ms** | **92-97%** | Per full page |

---

## Testing

### Unit Tests

Create fixtures: `extension/src/__tests__/fixtures/`

**test_email_field.html:**
```html
<input type="email" name="email" placeholder="Enter your email" />
```

**test_greenhouse_form.html:**
```html
<form>
  <input name="first_name" placeholder="First Name" />
  <input name="last_name" placeholder="Last Name" />
  <input type="email" name="email" />
  <input type="tel" name="phone" />
  <textarea name="cover_letter" placeholder="Why are you interested?" maxlength="2000"></textarea>
  <!-- ... 9 more fields -->
</form>
```

**matcher.test.ts:**
```typescript
import { describe, it, expect } from '@jest/globals';
import { matchFields, extractFieldSignature } from '../matcher';

describe('Matcher', () => {
  it('should match email field', async () => {
    const input = document.querySelector('input[type="email"]') as HTMLInputElement;
    const signature = extractFieldSignature(input);
    
    const results = await matchFields([signature]);
    const match = results.get('email');
    
    expect(match?.status).toBe('MATCHED');
    expect(match?.confidence).toBeGreaterThan(0.9);
  });

  it('should detect essay fields', async () => {
    const textarea = document.querySelector('textarea[name="cover_letter"]') as HTMLTextAreaElement;
    const signature = extractFieldSignature(textarea);
    
    const results = await matchFields([signature]);
    const match = results.get('cover_letter');
    
    expect(match?.status).toBe('ESSAY');
  });

  it('should match 12/14 fields on Greenhouse form', async () => {
    // Load fixture
    const form = loadFixture('test_greenhouse_form.html');
    const fields = Array.from(form.querySelectorAll('input, textarea')).map(extractFieldSignature);
    
    const results = await matchFields(fields);
    const matched = Array.from(results.values()).filter(r => r.status === 'MATCHED');
    
    expect(matched.length).toBeGreaterThanOrEqual(12);
  });
});
```

---

## Success Criteria

✅ **Accuracy:** >90% of fields correctly matched on real job application forms  
✅ **Speed:** <100ms per page (10-20 fields)  
✅ **Cache hit rate:** 70%+ after 1 week on familiar sites  
✅ **Essay detection:** >95% precision (no false positives on short textareas)  
✅ **Tests pass:** All 10 HTML fixtures match expected counts  

---

## Next Steps After Task 1.3

- **Task 2.2:** Integrate matcher with content script (form detection)
- **Task 3.3:** Add Step 5 (local embeddings with MiniLM)
- **Task 4.1:** Complete waterfall with cache and LLM classifier
- **Task 5.3:** Use AI provider for key suggestions in learning loop

---

## Notes

- Steps 1-5 run locally (no network calls)
- Step 6 uses AI provider abstraction (can swap GROQ/OpenAI/etc.)
- Cache is domain-specific (greenhouse.io vs lever.co have separate entries)
- All matching logic is stateless (pure functions, easily testable)
