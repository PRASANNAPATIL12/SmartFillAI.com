# Implementation Sequence for Ditto

## Week 1: Foundation + AI Abstraction

### Task 1.1: Repo Bootstrap
- [ ] Create package.json with dependencies
- [ ] Setup TypeScript (tsconfig.json)
- [ ] Configure Vite for Manifest V3 (@crxjs/vite-plugin)
- [ ] Create manifest.json skeleton
- [ ] Setup Tailwind CSS
- [ ] Core type definitions (shared/types.ts)

### Task 1.2: AI Provider Abstraction Layer ⭐ NEW
- [ ] Create IAIProvider interface (extension/src/ai-providers/types.ts)
- [ ] Implement GroqProvider (extension/src/ai-providers/groq.ts)
- [ ] Implement OpenAIProvider (extension/src/ai-providers/openai.ts)
- [ ] Implement AnthropicProvider (extension/src/ai-providers/anthropic.ts)
- [ ] Create AIProviderFactory (extension/src/ai-providers/factory.ts)
- [ ] Add provider config management (extension/src/ai-providers/config.ts)
- [ ] Unit tests for each provider

**Dependencies:** Task 1.1  
**Why Now:** AI abstraction must exist BEFORE any AI-dependent features

### Task 1.3: Field Matcher (Deterministic Only)
- [ ] Implement Steps 1-4 of waterfall (extension/src/matcher.ts)
  - Step 1: SKIP check (passwords, captchas, hidden fields)
  - Step 2: Cache lookup (domain + fingerprint hash)
  - Step 3: Essay detection (textarea patterns)
  - Step 4: Deterministic match (200+ regex rules)
- [ ] NO AI calls yet (Step 6 comes later)
- [ ] Unit tests with 10 HTML fixtures
- [ ] Achieve >80% recall on test corpus

**Dependencies:** Task 1.1  
**Why Now:** Core matching logic, no dependencies, easily testable

---

## Week 2: Extension Shell

### Task 2.1: Service Worker (Background Script)
- [ ] Auth manager (token storage, refresh)
- [ ] Profile store (CRUD on chrome.storage.local)
- [ ] Message handler (popup ↔ content script ↔ background)
- [ ] Alarm scheduler (sync every 5 minutes)

**Dependencies:** Task 1.1

### Task 2.2: Content Script (Form Detection)
- [ ] DOM scanner for forms (detector.ts)
- [ ] FieldSignature extraction
- [ ] MutationObserver for SPAs
- [ ] Integrate matcher (from Task 1.3)
- [ ] Test on React/Vue/Svelte/vanilla sites

**Dependencies:** Task 1.3, Task 2.1

### Task 2.3: Popup UI (React)
- [ ] Auth screen (Google OAuth + email/password)
- [ ] Profile editor (list/add/edit/delete entries)
- [ ] Settings (toggles for sync, ghost text, etc.)
- [ ] Supabase client integration
- [ ] Tailwind styling

**Dependencies:** Task 2.1

---

## Week 3: Local Storage + Embeddings

### Task 3.1: chrome.storage.local Integration
- [ ] Profile entries CRUD
- [ ] Settings persistence
- [ ] Session token (encrypted)
- [ ] Sync queue (for offline changes)

**Dependencies:** Task 2.1

### Task 3.2: IndexedDB Integration
- [ ] Embeddings store (Float32Array)
- [ ] Field cache store (domain → match map)
- [ ] MiniLM model storage (22 MB, lazy-loaded)

**Dependencies:** Task 3.1

### Task 3.3: Local Embeddings (MiniLM)
- [ ] @xenova/transformers integration
- [ ] Lazy model loading (only when Step 5 needed)
- [ ] Embedding computation for profile entries
- [ ] Cosine similarity search
- [ ] Step 5: Embedding match in waterfall

**Dependencies:** Task 3.2, Task 1.3

---

## Week 4: Matcher Integration + Autofill

### Task 4.1: Complete Waterfall Integration
- [ ] Wire Steps 1-5 together
- [ ] Add field cache (Step 2) with IndexedDB
- [ ] Performance testing (<100ms target)

**Dependencies:** Task 3.3, Task 2.2

### Task 4.2: Floating Pill Overlay
- [ ] Inject pill UI (bottom-right of forms)
- [ ] "Fill N fields" button
- [ ] Dismiss/hide logic
- [ ] Per-domain remember dismissal

**Dependencies:** Task 4.1

### Task 4.3: Filler (Value Injection)
- [ ] Fill strategy for <input>, <textarea>, <select>
- [ ] React/Vue/Svelte compatibility (synthetic events)
- [ ] Radio buttons, checkboxes
- [ ] Visual feedback (green flash animation)
- [ ] Test on 10+ real sites

**Dependencies:** Task 4.2

---

## Week 5: Learning Loop

### Task 5.1: Detect Unknown Fields
- [ ] Watch for typing in UNKNOWN fields
- [ ] Debounce (2s after last keystroke)
- [ ] Dedup check (avoid duplicate prompts)

**Dependencies:** Task 4.3

### Task 5.2: Learn Prompt UI
- [ ] Toast overlay: "Save as X?"
- [ ] Category selector
- [ ] [Save] [Edit Name] [Skip] [Never Ask] buttons
- [ ] Per-domain ignore list

**Dependencies:** Task 5.1

### Task 5.3: AI Key Suggestion (Step 6) ⭐ USES AI PROVIDER
- [ ] Call AIProvider.chat() for field name suggestion
- [ ] Fallback to deterministic rules if offline
- [ ] Cache suggestions locally

**Dependencies:** Task 1.2 (AI abstraction), Task 5.2

---

## Week 6: Cloud Sync + Resume

### Task 6.1: Supabase Database Setup
- [ ] Create tables (profile_entries, resumes, activity_log, essay_history)
- [ ] Row-level security (RLS)
- [ ] Auth setup (Google OAuth + email/password)

**Dependencies:** None (can start anytime)

### Task 6.2: Delta Sync Engine
- [ ] Sync queue (local → cloud every 5 min)
- [ ] Conflict resolution (last-write-wins)
- [ ] Offline queue drain on reconnect

**Dependencies:** Task 6.1, Task 3.1

### Task 6.3: Resume Upload + Parsing ⭐ USES AI PROVIDER
- [ ] Upload to Supabase Storage
- [ ] Edge function: /parse-resume
- [ ] Call AIProvider.chat() to extract structured data
- [ ] User review/confirm extracted fields
- [ ] Add to profile + compute embeddings

**Dependencies:** Task 1.2 (AI abstraction), Task 6.1

---

## Week 7: Essay Generation

### Task 7.1: Essay Detection (Already Done)
- [x] Part of Task 1.3 (Step 3 in waterfall)

### Task 7.2: Essay Generation UI
- [ ] "Generate with AI" button in textarea corner
- [ ] Modal overlay with streaming response
- [ ] Edit before use, regenerate, copy buttons

**Dependencies:** Task 4.3

### Task 7.3: Essay Generation Backend ⭐ USES AI PROVIDER
- [ ] Edge function: /generate-essay
- [ ] Call AIProvider.chatStream() for streaming response
- [ ] Context: resume text + company hint from page
- [ ] Save to essay_history table

**Dependencies:** Task 1.2 (AI abstraction), Task 6.1, Task 6.3

---

## Week 8: AI Field Classification (Optional Step 6)

### Task 8.1: LLM Field Classifier ⭐ USES AI PROVIDER
- [ ] Collect remaining UNKNOWN fields on page
- [ ] Batch call to AIProvider.chat()
- [ ] Only if 2+ truly ambiguous fields
- [ ] Cache results in field_cache

**Dependencies:** Task 1.2 (AI abstraction), Task 4.1

---

## Week 9: Polish + Testing

### Task 9.1: Security Hardening
- [ ] Sensitive domain blocklist (banks, gov, healthcare)
- [ ] Sensitive entry encryption
- [ ] API key encryption in chrome.storage
- [ ] Audit log (local, exportable)

### Task 9.2: Performance Optimization
- [ ] Lazy MiniLM loading
- [ ] Profile in-memory cache
- [ ] Debounced MutationObserver
- [ ] No-reflow overlay positioning

### Task 9.3: Cross-Site Testing
- [ ] Test on 50+ real sites (Greenhouse, LinkedIn, etc.)
- [ ] React/Vue/Angular/Svelte compatibility
- [ ] Edge cases (iframes, shadow DOM, aggressive CSP)

---

## Week 10: Chrome Web Store Prep

### Task 10.1: Compliance
- [ ] Privacy policy page
- [ ] Permissions justification doc
- [ ] Screenshots (5+ for Web Store)
- [ ] Promo images (1400×560, 440×280)

### Task 10.2: Submission
- [ ] Upload to Chrome Web Store
- [ ] Wait for review (1-2 weeks)
- [ ] Address feedback

---

## Post-Launch (Ongoing)

- [ ] Edge/Brave port (same Manifest V3, trivial)
- [ ] Company research for essays (Pro feature)
- [ ] Essay history + reuse
- [ ] Dashboard (full web app)
- [ ] Firefox port (WebExtensions, ~30% delta)
- [ ] Multi-resume support (Pro feature)
- [ ] B2B tier (career centers, bootcamps)

---

## Critical Path (Cannot Parallelize)
```
Task 1.1 (Bootstrap)
    ↓
Task 1.2 (AI Abstraction) ← MUST come before any AI features
    ↓
Task 1.3 (Matcher - deterministic)
    ↓
Task 2.2 (Content Script - form detection)
    ↓
Task 3.3 (Local Embeddings)
    ↓
Task 4.1 (Complete Waterfall)
    ↓
Task 4.3 (Filler)
    ↓
Task 5.3 (AI Key Suggestion) ← First AI integration
    ↓
Task 6.3 (Resume Parsing) ← Second AI integration
    ↓
Task 7.3 (Essay Generation) ← Third AI integration
```

## Can Be Done in Parallel
- Task 2.1 (Service Worker) + Task 2.3 (Popup UI)
- Task 3.1 (chrome.storage) + Task 3.2 (IndexedDB)
- Task 6.1 (Supabase setup) can start anytime
- Task 9.1/9.2/9.3 (Polish) can overlap

---

## Testing Strategy
Each task must have:
- ✅ Unit tests (Jest)
- ✅ Manual verification (test in browser)
- ✅ Git commit after success

Before moving to next task:
```bash
npm run test          # Unit tests pass
npm run build        # Build succeeds
# Load unpacked extension in Chrome
# Test the new feature manually
git add .
git commit -m "Task X.Y: [description]"
```

---

## AI Provider Switching Example

To switch from GROQ to OpenAI:

**Before (with abstraction):**
```typescript
// config.ts
export const AI_CONFIG = {
  provider: 'groq',  // ← Change this line
  apiKey: getEncryptedKey('groq')
}
```

**After:**
```typescript
// config.ts
export const AI_CONFIG = {
  provider: 'openai',  // ← Changed
  apiKey: getEncryptedKey('openai')
}
```

**Zero business logic changes.** That's the power of abstraction.

---

## Estimated Timeline
- Solo developer: **10 weeks** (full-time)
- With help: **6-8 weeks**
- MVP (Tasks 1.1-4.3 only): **4 weeks**
