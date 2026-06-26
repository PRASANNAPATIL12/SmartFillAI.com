# SmartFillAI — Complete Product Documentation

> **Last Updated:** 2026-06-26 (Phase AI complete + E2E hardening)
> **Status:** Production-Ready — all commits pushed to origin/main
> **Repository:** PRASANNAPATIL12/SmartFillAI
> **Extension Type:** Manifest V3 (Chrome, Edge, Brave, Arc)
> **Version:** 1.4.0

---

## Executive Summary

**SmartFillAI** is a universal form autofill Chrome extension that fills any web form — especially job application portals — using a self-growing personal profile. It operates on a **local-first** architecture:

- 90%+ of fills happen entirely in-browser, AI is only used for ambiguous field classification and essay generation
- Form values **never leave the browser** in Steps 1–5 of the matching waterfall
- Learns from every new field the user fills, growing more accurate over time
- Cross-device sync via Supabase (profile entries + form fingerprints)

**One-line pitch:** *Your profile, on every form. Learns as you go. Thinks when it matters.*

---

## 1. Core Product Features

### 1.1 Universal Form Detection

Detects ALL standard and custom input types:

| Input Kind | Examples | Handler |
|---|---|---|
| Native text/email/tel/url | First Name, Email, Phone | `textHandler` |
| Native `<select>` | Country, State, Degree | `selectHandler` |
| Native `<input type="radio">` | Work auth, Gender | `radioGroupHandler` |
| Native `<input type="checkbox">` | Skills, preferences | `checkboxGroupHandler` |
| `<input type="date">` | Date of birth, Start date | `dateHandler` |
| ARIA combobox (React Select, Greenhouse) | Location, Country | `comboboxHandler`, `ariaComboboxHandler` |
| Button-triggered dropdowns | Phone country picker | `buttonDropdownHandler` |
| `[contenteditable]` / `role="textbox"` | Rich text fields | `contenteditableHandler` |
| ARIA radio/checkbox/switch | Custom choice widgets | `ariaChoiceHandler` |
| `<input type="file">` / dropzones | Resume upload | File handler in fill loop |

**Discovery approach:** MutationObserver watches DOM changes → `extractAllFields()` gathers both native elements and ARIA widgets → de-duplication prevents double-counting when native elements have ARIA roles.

### 1.2 The Matching Waterfall

Every detected field passes through this cascade. **Tiers are tried in order; first confident match wins.** Implementation lives in `extension/src/matcher.ts::matchFieldInternal()` for Tiers 1–4 plus the option-set/fingerprint short-circuits; Tiers 5–6 run async via background messages from `content-script/index.ts`.

| Tier | Name | Latency | Coverage | Method |
|------|------|---------|----------|--------|
| 1   | **SKIP**            | <1ms   | ~10% skipped              | Password/hidden/search/captcha/credit-card rules (`shouldSkip()`) |
| 1.5 | **OPTION-SET**      | <1ms   | ~5%                       | Gender/work-auth/yes-no detected by exact option set (`classifyByOptionSet()`) |
| 1.6 | **FINGERPRINT**     | ~1ms   | ~60% on returning forms   | IndexedDB form-fingerprint cache (`fingerprintMatch()` — Phase AD.1) |
| 2   | **PER-FIELD CACHE** | ~1ms   | ~30%                      | `cacheMatch()` for prior-page-visit field hashes |
| 3   | **ESSAY**           | <1ms   | ~5%                       | Large textarea + 13 question-label patterns (`isEssay()`) |
| 4   | **RULES**           | ~5ms   | ~80%                      | 200+ autocomplete/label/keyword patterns (`ruleMatch()`) |
| 5   | **EMBEDDINGS**      | ~30ms  | ~92%                      | MiniLM-L6-v2 cosine similarity (local, threshold **0.75**) |
| 6   | **LLM CLASSIFY**    | ~500ms | ~97%                      | Batched GROQ/Gemini prompt (threshold **0.70**) |

**Fill bands:** `FILL_THRESHOLD = 0.90` / `REVIEW_THRESHOLD = 0.70` (set in `matcher.ts`).

**Q&A replay note:** an earlier doc revision referred to a distinct Step 7 "Q&A Replay" tier. In the current code, Q&A replay is **not** a waterfall step — it's a fill-time helper handled inside the essay/LLM answer handler (`background/answer-field.ts`). When a field's status is `ESSAY` or `UNKNOWN` and the user has previously answered a similar question, the answer is replayed verbatim before any model call (zero API cost). See §1.7 for the three essay tiers.

**Cost:** Tiers 1–5 are entirely free (no API calls, no network). Tier 6 costs ~$0.0001/batch.

**Form data policy:** Absolutely no form values (names, emails, phone numbers) are ever sent outside the browser in Tiers 1–6. Tier 6 sends ONLY field labels (e.g. "First Name", "Work Authorization") with no user data values.

### 1.3 Fill Execution — 4-Level Retry Cascade

For each matched field, the extension tries to inject the value through increasingly aggressive methods:

```
Level 1: Native setter + React _valueTracker reset + input/change events
  ↓ (if value still wrong after dispatch)
Level 2: Char-by-char InputEvent simulation
  (keydown → InputEvent('insertText') → nativeSetter → keyup per character)
  (capped at 100 chars; handles React 18 controlled inputs that ignore native setter)
  ↓ (if still wrong)
Level 3: execCommand('insertText') fallback
  (handles some Shadow DOM hosts that ignore synthetic events)
  ↓ (if still wrong)
Mark FILL_FAILED + console.warn
```

**Dropdown-specific cascade:**

```
fillCombobox / fillSelect / fillButtonDropdown:
  1. Cache 3 hit: prior option-text resolution for this value+optionSet → direct pick
  2. Exact match: option value attribute === stored value
  3. Case-insensitive text match (strip emoji)
  4. First-component exact: "Bangalore (South), KA" first component = "bangalore"?
  5. Containment + word-boundary guard: "bangalore" in "bangalore (south), ..."
     (char after "bangalore" must NOT be a letter — prevents "bangalorean" false match)
  6. Embedding fallback: MiniLM cosine similarity on option texts
  7. FILL_FAILED
```

For ARIA comboboxes (react-select etc.), after typing to filter:
- Poll for options up to 800ms (220ms base + 4×150ms) — handles Google Places / Greenhouse async city search

### 1.4 Learning Loop

**Three learning paths:**

**Path 1 — Unknown field (UNKNOWN status):**
```
User types in any unrecognized field → blur/debounce 200ms
  → Extract value + field signature
  → Validate: no passwords, no garbage, no multi-paragraph blobs
  → autoSave=true: silently learn (show nothing)
  → autoSave=false: show green "Learn" pill
  → Infer canonical key (200+ rules → or null → Q&A cache)
  → Store as ProfileEntry + sync to cloud
```

**Path 2 — Matched field changes (MATCHED status):**
```
User changes a field that was already filled by extension → blur/sweep
  → Get display value via handler.capture(el)
  → New value ≠ stored value?
  → Check duplicates across alternatives
  → Count existing alternatives (cap = 5)
  → ALWAYS show Update-or-Add pill (8s sticky, cursor-move safe):
      [Update] → replace stored value (doUpdateEntry)
      [Add]    → add as alternative (ADD_ALTERNATIVE)
      [dismiss / timeout] → clear guard so user can re-prompt later
```

**Path 3 — Manual dropdown selection (handleListboxOptionMousedown):**
```
User manually clicks a listbox option (isTrusted=true only)
  → Capture exact option text before dropdown closes
  → Find owner field via activeElement → aria-controls/aria-owns → DOM search
  → learnDropdownSelection(owner, optionText)
  → UNKNOWN: same as Path 1 (Q&A cache + profile)
  → MATCHED: show Update-or-Add pill (same as Path 2)
    (NOT a silent update — user always sees the pill and can choose)
```

**Dedup guards:**
- `dittoLastLearnedValue` — prevents re-saving same value in one session
- `dittoUpdatePromptShown` — prevents re-showing pill for same value within one open
- `dittoPreFocusValue` — captures value at focus-time so unfocused fields don't re-trigger
- `onDismiss` callback clears `dittoUpdatePromptShown` when 8s pill times out (so user CAN see it again on next interaction)

### 1.5 Form Fingerprinting (ATS Memory)

Forms are identified by a structural fingerprint, not by domain. This lets the extension reuse learned field mappings across:
- Company-hosted Greenhouse forms (`databricks.com/...?gh_jid=...`)
- ATS template forms (`boards.greenhouse.io/greenhouse`)
- Repeated visits to the same form structure

**Fingerprint key:** `${atsId}::${structuralHash}`
- `atsId` = detected ATS (e.g. `greenhouse`, `workday`, `lever`) or `host:domain.com`
- `structuralHash` = hash of sorted (role, normalizedLabel, inputType) tuples

**Source types:**
- `source: 'template'` — built-in ATS templates seeded on install (5 ATSes, ~70 fields total)
- `source: 'learned'` — from real user fills; synced to Supabase

**Templates pre-seeded (day-one accuracy ~80%):**
- Greenhouse: 25 fields (first_name, last_name, email, phone, resume, linkedin_url, github_url, work_authorization, gender, disability_status, veteran_status, ...)
- Workday: 18 fields (address_line1, city, state, zip_code, notice_period, ...)
- Lever: 9 fields
- LinkedIn Easy Apply: 6 fields
- Naukri: 10 fields (current_ctc, notice_period, ...)

### 1.6 Embedded ATS Detection

Detects the REAL form platform even when a company hosts the form on their own domain.

**Detection layers (first confident match wins):**

| Layer | Signal | Confidence | Example |
|---|---|---|---|
| 1 | Direct hostname | 1.0 | `boards.greenhouse.io` |
| 2 | Query parameters | 0.95 | `?gh_jid=xxx` → Greenhouse |
| 3 | Iframe src | 0.95 | `<iframe src="lever.co/...">` |
| 4 | Form action URL | 0.90 | `action="workday.com/..."` |
| 5 | Script tag sources | 0.90 | `<script src="boards-api.greenhouse.io/...">` |
| 6 | DOM signatures | 0.85 | `#greenhouse_application`, `[data-automation-id]` |
| 7 | Hostname fallback | 0.30 | `host:databricks.com` |

**Re-detection:** MutationObserver re-runs detection when `script` or `iframe` tags are added late (Greenhouse boards.js loads async). On upgrade from layer-7 to higher-confidence layer, fingerprint cache is invalidated and re-keyed.

### 1.7 Essay Generation with Company Context

**Three tiers, picked automatically:**

```
Tier 1 — Factual question (label is short attribute-like):
  Exact → fuzzy match in Q&A cache → replay verbatim (0 API calls)

Tier 2 — Narrative + Company detected:
  Prior answer found → seed it + adapt to THIS company via Gemini
  ("You previously answered: ... Now adapt it for Stripe, emphasizing...")

Tier 3 — Narrative, no prior answer:
  Generate from scratch using resume text + company + question
```

**Company detection:** JSON-LD Organization → og:site_name → ATS URL keywords → `<title>` → hostname (cached per page load).

**Resume RAG (Phase AH — shipped):** When the user uploads a resume, the parser extracts structured `resumeSections[]` (summary, experience, education, skills, projects, certifications, visa/compensation/narrative). At answer time, `background/resume-sections.ts::selectRelevantSections()` matches the question's keywords against 8 `SectionRoute` patterns and returns only the 1–2 most relevant sections (~3000-character cap). This keeps the Gemini context window focused and the answers grounded — without sending the whole resume on every call. Retrieval method today is **keyword-based**; an embedding-based variant is on the future roadmap.

### 1.8 Resume Processing

| Format | Parser | Notes |
|--------|--------|-------|
| PDF | Gemini (inline PDF) | Full layout understanding |
| Text paste | GROQ (Llama-3.3-70B) | Fast, free |

**Post-parse:** Structured extraction → profile entries with embeddings. Resume Q&A pre-generated at upload time (so essay tier works immediately). Q&A cache invalidated on resume replacement.

### 1.9 Cloud Sync (Supabase)

**What syncs:** Profile entries + form fingerprints (learned only, not templates)
**What never syncs:** Embeddings (recomputed per-device), form values, Q&A answers

**Protocol:**
- 5-min chrome.alarms tick → push `sync_queue` (add/update/delete ops) → pull remote changes → merge (last-write-wins by `updated_at`)
- Sign-in triggers immediate pull → Sign-out triggers push first
- Offline: changes queue, drain on next wake
- Supabase client: Bearer token injected via `global.headers` at creation time (no `setSession()` → no flood of `Failed to fetch` on offline)

**Auth:** Email/password Supabase auth. Session stored in `chrome.storage.local`, token refreshed 60s before expiry.

### 1.10 Visual Feedback System

| Element | Description | Trigger |
|---------|-------------|---------|
| Fill pill | "⚡ Fill N fields" → click to autofill | Hover / focus on form |
| Ghost text | Grayed value preview inside field | Field matched, not yet filled |
| Field badge | Green/yellow/grey dot on field | Confidence band (fill/review/skip) |
| Learn pill | Green "Save ___?" prompt | New field detected (autoSave=off) |
| Update-or-Add pill | "Update 'Bangalore'→'Bangalore (South)...'?" | Matched field changed |
| Success banner | "Filled X / N fields" | After fill completes (fades 3s) |
| Status badge | `FILL_FAILED` marker | Dropdown fill failed (debug) |

**Pill safety:** `_stickyPillActive` flag prevents hover/focus from replacing an active Update-or-Add or Learn pill. Pill is sticky until dismissed by user action or 8s timeout.

### 1.11 Native ATS Parser Awareness (Phase AI)

Many ATSes (Greenhouse, Workday, Lever, Ashby) parse an uploaded resume server-side and auto-fill name/email/phone fields via their own React state. SmartFillAI used to overwrite those fields and race against the ATS parser. Phase AI makes the extension cooperative:

| Component | Location | Role |
|---|---|---|
| **Burst watcher** | `content-script/ats-parser-watcher.ts` | Capture-phase listener on `input`/`change` events. Threshold: ≥3 distinct fields within 5s → "ATS parser is running". Then waits 1.5s of silence (hard ceiling 8s) before signalling settle. |
| **`skipIfFilled` gate** | `filler.ts::fillElement()` | When `{ skipIfFilled: true }`, if the field has a non-empty value not set by SmartFillAI (`!el.dataset.dittoFilled`), tag `dataset.atsFilledNative='true'` and return `'ats_skipped'` — preserve ATS data, don't overwrite. |
| **`auditFills()`** | `index.ts` | After fill + 3.5s combobox settle, iterate `matchMap` and categorize each field as `ats / sfa_ok / sfa_failed / skipped / empty`. |
| **Audit banner** | `overlay-banner.ts::showAuditBanner()` | Replaces the simple success banner: `"✓ 8 by ATS · 7 by SmartFillAI · 5 empty"`. Auto-dismisses after 3s. |
| **Teal badge** | `overlay.ts` (`#06b6d4`, cyan-500) | New `.sfa-badge.ats` variant — distinct from green (filled), yellow (review), grey (empty). |

**Flow on Fill click:**

```
banner Fill click
  ↓
snapshot pre-existing values (atsPreFillValues map)
arm atsParserWatcher
  ↓ (next frame)
await atsParserWatcher.waitForSettle()   // resolves on:
                                          //  - 5s no burst (fast path), OR
                                          //  - 1.5s silence after burst, OR
                                          //  - 8s hard ceiling
  ↓
fillAll() with skipIfFilled:true on every fillElement() call
  ↓
+3500ms: auditFills() + showAuditBanner()
```

### 1.12 Recent Reliability Fixes (2026-06-26)

Four bugs caught and fixed by the new E2E harness:

1. **Gemini PDF parse could hang 45+ seconds** on rate-limit. `resume-parser.ts` now wraps `generateContent` in a 20s `Promise.race` timeout.
2. **Silent upload failure** — parse errors returned success metadata, leaving the UI on a spinner. `UPLOAD_DOCUMENT` now returns `{ parseError }`; `DocumentsScreen.tsx` shows a 6s red toast: *"AI quota exceeded — file saved, profile not extracted. Try again later or update API key."*
3. **Radio/checkbox falsely tagged as ATS-prefilled** — `readElementValue()` treated `<input type="radio" value="Yes">` as "already filled" whenever the `value` attribute existed (every well-formed radio). Now returns the value only when `el.checked === true`.
4. **Audit banner reported "0 by SmartFillAI"** despite filling 10+ fields — `applyHint()` unconditionally deleted `el.dataset.dittoFilled` during the 600ms post-fill re-scan. Now preserves the flag when the field still holds a non-empty value.

All 4 fixes verified end-to-end in headed Chromium against a 16-field Greenhouse-like fixture. 302/302 unit tests still pass.

---

## 2. Full Architecture Flow

### 2.1 On Page Load

```
MutationObserver fires (DOM settled, 300ms quiet / 2s max)
  ↓
detectAts(url, document)  ← 7-layer ATS detection, cached
  ↓
extractAllFields(document)
  ├─ Native: input/textarea/select (de-dup by ID/name)
  ├─ Radio groups: group by name attr → one FieldSignature per group
  ├─ Checkbox groups: group by name attr
  ├─ ARIA widgets: [role="combobox/radio/checkbox/switch/textbox/radiogroup"]
  └─ File inputs + dropzones
  ↓
For each field → matcher.ts waterfall (Steps 1–7)
  ↓
matchMap<HTMLElement, {sig, result, entry}> populated
  ↓
Inject overlay:
  ├─ paintFieldBadge(el) on each matched element
  ├─ showGhost(el, value) for MATCHED fields
  └─ Floating pill: "⚡ Fill N fields"
```

### 2.2 On Fill (User Clicks Pill)

```
fillAll(matchMap, profile, documentsMeta)
  ↓
Loop 1 — Profile fields (MATCHED):
  For each MATCHED field:
    resolveHandler(el).fill(el, value, ctx)
      → Level 1: nativeSetter + events
      → Level 2: char-by-char (if Level 1 fails)
      → Level 3: execCommand (if Level 2 fails)
    → For dropdowns: optionMatches cascade → embedding fallback
    → Mark filled, apply green flash
  ↓
Loop 2 — Q&A replay (UNKNOWN fields with remembered answers):
  getRememberedAnswer(fieldLabel) → fill if found
  ↓
Loop 3 — LLM answer tier (remaining UNKNOWN):
  ANSWER_FIELD message → Gemini (gemini-2.0-flash)
    → factual: verbatim replay (Q&A cache)
    → narrative + company: seed + adapt
    → narrative only: generate from scratch
  ↓
Loop 4 — File attach:
  documentsMeta → auto-attach resume/cover letter to <input type="file">
  ↓
Banner: "✓ Filled X / N fields" (fades 3s)
```

### 2.3 On User Interaction (Learning)

```
Any input blur / change / mousedown on listbox option
  ↓
tryLearnField(el) OR learnDropdownSelection(el, optionText)
  ↓
Status check:
  UNKNOWN → validate → infer canonical key → learn (show pill or silent)
  MATCHED → value changed? → Update-or-Add pill → user confirms
  SKIP    → ignore
  ↓
On confirm:
  LEARN_FIELD → background: create ProfileEntry + compute embedding
  UPDATE_ENTRY → background: update value + recompute embedding
  ADD_ALTERNATIVE → background: add as alternative entry
  ↓
sync_queue.push({op: 'add'|'update', ...})
  → 5-min alarm: push to Supabase
```

### 2.4 Handler Registry Dispatch

```typescript
HANDLERS (ordered by precedence):
  ariaComboboxHandler    // role="combobox" (div/button, NOT input)
  buttonDropdownHandler  // <button> / role="button" wrappers
  selectHandler          // <select>
  comboboxHandler        // <input aria-autocomplete|aria-controls|...>
  ariaChoiceHandler      // role="radio/checkbox/switch"
  radioGroupHandler      // <input type="radio"> representative
  checkboxGroupHandler   // <input type="checkbox"> representative
  dateHandler            // <input type="date|month|week">
  contenteditableHandler // contenteditable="true" / role="textbox"
  textHandler            // fallback (all other inputs + textareas)

resolveHandler(el):
  return HANDLERS.find(h => h.match(el)) ?? textHandler
```

---

## 3. Scenario Walkthroughs

### Scenario A: Greenhouse via company domain (Databricks)

**URL:** `https://jobs.databricks.com/careers/apply?gh_jid=7654321`

```
1. detectAts() — Layer 2 (query param): gh_jid= → atsId="greenhouse" (confidence=0.95)
2. fingerprintKey = "greenhouse::abcdef123"
3. ATS templates pre-seeded → 25 fields already mapped
4. extractAllFields() → 18 native inputs found
5. Matcher Step 2: fingerprint hit for 14 fields (template match)
   → Step 4 handles remaining 4 via rules
6. Location (City) field: stored value = "Bangalore"
   → dropdown type: ariaCombobox (react-select)
   → fillCombobox opens panel, scans initial options
   → "Bangalore" not in first 20 options (Google Places async)
   → writeValue("Bangalore") → polls 4×150ms for options
   → "Bangalore (South), Karnataka, India" appears → optionMatches passes
   → clickOption → committed → markFilled
   → tryLearnField sweep: display value ≠ stored value → Update-or-Add pill
   → User clicks "Add" → "Bangalore (South), Karnataka, India" stored as alternative
7. Resume file: Loop 4 attaches resume.pdf to file input
8. "✓ Filled 16 / 18 fields"
```

### Scenario B: User picks a different city manually

**Situation:** User manually selects "Hyderabad, Telangana, India" from city dropdown

```
1. handleListboxOptionMousedown fires (isTrusted=true)
2. optionEl.textContent = "Hyderabad, Telangana, India"
3. Find owner: activeAtMousedown → matchMap combobox element
4. learnDropdownSelection(owner, "Hyderabad, Telangana, India")
5. state.result.status = 'MATCHED', state.entry.value = "Bangalore"
6. normalized = "Hyderabad, Telangana, India" ≠ "Bangalore"
7. Check duplicate → not a dup
8. Count alternatives → 1 (< maxAlts 5)
9. showUpdateOrAddPill:
   → "current_location: Bangalore → Hyderabad, Telangana, India"
   → [Update] → replaces "Bangalore" in profile
   → [Add] → keeps "Bangalore", adds "Hyderabad..." as alternative
   → 8s sticky (cursor moves do NOT close it)
10. Next visit: profile has "Hyderabad..." → Option Resolution Cache maps
    value→option directly (instant, no optionMatches needed)
```

### Scenario C: Returning user, fully warmed cache

**URL:** Second visit to same Workday form

```
1. detectAts() → "workday" (direct hostname, confidence=1.0)
2. Fingerprint key = "workday::xyz789"
3. Step 2 cache hit: ALL 15 fields mapped instantly
4. Fill pill: "⚡ Fill 15 fields"
5. Fill: all Level 1 native setter (no retry needed for Workday)
6. Option Resolution Cache: country "India" → cached as "🇮🇳 India +91"
7. Total fill time: ~150ms (zero AI calls)
8. "✓ Filled 15 / 15 fields"
```

### Scenario D: Essay question on Stripe careers (Greenhouse)

**URL:** `https://stripe.com/jobs/listing/1234567`

```
1. detectAts() → "greenhouse" via DOM signature (#greenhouse_application)
2. Form scan finds: essay field "Why do you want to work at Stripe?"
3. Step 3: Essay detection → ESSAY status
4. Ghost text: grayed preview of prior essay answer (if any)
5. User clicks "Generate ✨" on essay pill
6. company = "Stripe" (detected via JSON-LD/og:site_name)
7. Prior answer for "Why do you want to work here?" found in Q&A cache → seedAnswer
8. Gemini call: adapt seedAnswer to Stripe context (Tier 2)
9. Streaming response → user sees text appear token by token
10. User edits → clicks "Use This" → essay fills into textarea
```

### Scenario E: Work authorization radio group (Workday)

**Form:** "Are you authorized to work in the US?" with options [Yes, No, Visa Sponsorship Required]

```
1. extractAllFields() → radioGroupHandler matches representative input
2. FieldSignature.options = ["Yes", "No", "Visa Sponsorship Required"]
3. Matcher Step 4: label matches work_authorization rule → MATCHED
4. profile.entry.value = "Yes, I am authorized to work"
5. expandValueAliases('work_authorization', "Yes, I am authorized to work")
   → aliases = ["Yes", "I am authorized", "Authorized to work", ...]
6. radioGroupHandler.fill() → iterates options:
   → "Yes" matches alias "Yes" → click that radio button
7. Learn sweep: value = "Yes" → matches normalized stored value → no pill
```

---

## 4. Technology Stack

| Component | Technology |
|-----------|------------|
| **UI** | React 18 + TypeScript + Tailwind CSS + Vite |
| **Extension** | Manifest V3 · Service Worker · Content Script · Shadow DOM |
| **Local Storage** | `chrome.storage.local` (10MB) + IndexedDB v5 (unlimited) |
| **Embeddings** | MiniLM-L6-v2 via @xenova/transformers (local only, lazy-loaded) |
| **AI Provider 1** | GROQ — Llama-3.3-70B (resume parse + LLM classify) |
| **AI Provider 2** | Gemini — gemini-2.0-flash (essay gen + PDF parse) |
| **Backend** | Supabase (Auth · Postgres · RLS · 5-min delta sync) |
| **Sync Protocol** | Delta queue · last-write-wins · offline-safe |

**Key build-time decisions:**
- API keys bundled at build via Vite `import.meta.env` static replacement — end users NEVER enter API keys
- Only GROQ and Gemini — no OpenAI, no Anthropic, no local models, no provider UI

---

## 5. Security & Privacy

### Hard Rules (non-negotiable)

1. **Form values never leave the browser** — Steps 1–5 are entirely local
2. **Embeddings never synced** — recomputed per-device from text
3. **No telemetry on form content** — usage metrics are local only (field counts, not values)
4. **Sensitive domain blocklist** — banks/health/gov blocked by default (user can override)
5. **Step 6 LLM sends only field labels** — never the user's actual values
6. **No credit card / SSN patterns** — regex blocklist on learn path
7. **Supabase RLS** — users can only read/write their own rows

### Supabase Auth Security (Phase AF fix)
Previously `client.auth.setSession()` was called on every sync operation, triggering a `_getUser` network validation round-trip. This caused a flood of `TypeError: Failed to fetch` errors on offline. **Fixed:** Bearer token is injected via `global.headers` at client creation time. No `setSession()` call = no validation round-trip = no flood.

---

## 6. File Structure

```
extension/src/
├── content-script/
│   ├── index.ts              ← Main waterfall, fill loops, learning, learning sweep
│   ├── detector.ts           ← Field discovery (native + ARIA + radio/checkbox groups)
│   ├── filler.ts             ← fillPlainInput (Level 1-3 cascade) + fillSelect + fillFileInput
│   ├── combobox.ts           ← fillCombobox + fillButtonDropdown + optionMatches + findListbox
│   ├── overlay.ts            ← Floating pill, field badges, ghost text, essay panel (Shadow DOM)
│   ├── overlay-banner.ts     ← "Ready / Filling / Filled X/N" banner
│   ├── ghost-text.ts         ← Per-field preview text overlay
│   ├── form-fingerprinter.ts ← buildFingerprintInputs + mergeFingerprint
│   ├── ats-templates.ts      ← Static ATS_TEMPLATES (5 ATSes, ~70 fields)
│   ├── company-detector.ts   ← detectAts() + detectCompany() (cached per page)
│   ├── memory-asset.ts       ← classifyAnswerKind() + getSeedAnswer()
│   ├── option-embedding.ts   ← selectOptionByEmbedding() (MiniLM on options)
│   ├── option-resolution-cache.ts ← Cache 3: option-text resolution
│   ├── country-aliases.ts    ← expandCountryAliases(), resolveCountry()
│   ├── value-aliases.ts      ← expandValueAliases() for gender/degree/work_auth/...
│   ├── value-validation.ts   ← validateLearnedValue() — blocks garbage values
│   ├── qa-cache.ts           ← rememberAnswer / getRememberedAnswer (localStorage)
│   ├── messenger.ts          ← sendToBackground() typed message helper
│   └── field-handlers/
│       ├── registry.ts            ← HANDLERS array + resolveHandler()
│       ├── types.ts               ← FieldHandler interface + FillContext
│       ├── text-handler.ts        ← fillPlainInput fallback
│       ├── select-handler.ts      ← fillSelect
│       ├── combobox-handler.ts    ← fillCombobox (input-based ARIA combobox)
│       ├── aria-combobox-handler.ts ← fillButtonDropdown (div/button combobox)
│       ├── button-dropdown-handler.ts ← phone country picker
│       ├── radio-group-handler.ts ← native radio groups
│       ├── checkbox-group-handler.ts ← native checkbox groups
│       ├── date-handler.ts        ← date/month/week inputs
│       ├── aria-choice-handler.ts ← role="radio/checkbox/switch"
│       └── contenteditable-handler.ts ← contenteditable + role="textbox"
│
├── background/
│   ├── index.ts              ← Message router (all handler registrations)
│   ├── auth-manager.ts       ← signIn/signOut/getSession/refreshSession
│   ├── supabase-client.ts    ← getAuthClient (Bearer header, cached by token)
│   ├── supabase-env.ts       ← ENV_SUPABASE_URL + ENV_SUPABASE_ANON_KEY
│   ├── sync-engine.ts        ← pushSyncQueue + pullFromCloud + fingerprint sync
│   ├── profile-store.ts      ← IndexedDB CRUD for profile_entries
│   ├── field-learner.ts      ← inferCanonicalKey / inferDisplayLabel / inferCategory
│   ├── llm-classifier.ts     ← Step 6 batch LLM prompt (GROQ/Gemini)
│   └── answer-field.ts       ← ANSWER_FIELD handler (Gemini essay answer)
│
├── popup/
│   ├── App.tsx               ← Router (Home/Profile/Resume/Settings/Answers/Login)
│   └── components/
│       ├── HomeScreen.tsx    ← Fill button + field count + fill ratio
│       ├── ProfileScreen.tsx ← CRUD: edit/delete/alternatives with 10s undo
│       ├── ResumeScreen.tsx  ← PDF upload + text paste + parsed preview
│       ├── SettingsScreen.tsx ← autoSave toggle + sensitivity + About
│       ├── AnswersScreen.tsx ← Q&A history viewer
│       └── LoginScreen.tsx   ← Sign in / Sign up / Local-only escape
│
├── ai-providers/
│   ├── groq.ts               ← GroqProvider (Llama-3.3-70B)
│   ├── gemini.ts             ← GeminiProvider (gemini-2.0-flash, streaming)
│   ├── factory.ts            ← AIProviderFactory singleton
│   ├── types.ts              ← IAIProvider interface
│   ├── config.ts             ← getProviderConfig / setAPIKey
│   └── cost-tracker.ts       ← logCost / getTotalCost / getMonthlyCost
│
├── ml/
│   ├── step5.ts              ← fieldEmbedText() + cosine similarity
│   └── embedder.ts           ← MiniLM-L6-v2 via @xenova/transformers (lazy)
│
└── storage/
    └── idb.ts                ← IndexedDB v5: field_cache, embeddings, documents,
                                 form_fingerprints stores

shared/
└── types.ts                  ← ProfileEntry, Session, FieldSignature, MatchResult,
                                 FormFingerprint, MessageType union, UserSettings
```

---

## 7. Performance

| Operation | Target | Notes |
|-----------|--------|-------|
| Form detection | <50ms | MutationObserver + 300ms quiet wait |
| Waterfall Steps 1–4 | <10ms | All synchronous rules |
| Step 5 (embedding) | ~30ms | Lazy-loaded, warm |
| Step 6 (LLM) | ~500ms | Batch; only if Steps 1–5 fail |
| Fill execution (50 fields) | <300ms | Level 1 native setter |
| Dropdown fill (async search) | ~1s | Polls up to 820ms for options |
| Essay generation (first token) | ~1.5s | Gemini streaming |
| MiniLM first load | ~2s | 22MB, lazy, cached after |
| Popup open | <150ms | React + glassmorphism UI |
| Cloud sync (push) | ~200ms/batch | Delta only |

**SPA handling:** `scheduleScan()` uses a 300ms quiet-period + 2s max ceiling so route changes in SPAs are handled without scanning on every DOM mutation.

---

## 8. Known Limitations

| Limitation | Reason | Workaround |
|------------|--------|-----------|
| Canvas-rendered inputs (PDFjs, some custom editors) | No DOM element | None — mark FILL_FAILED |
| Cross-origin iframes (same-origin only filled) | Browser security | Detect ATS via iframe `src` attribute (we can see that) |
| Captcha / OTP fields | Intentionally skipped | User fills manually |
| No auto-submit | Intentional — security boundary | User clicks submit |
| Google Places lag on city fields | Async API call | Polling loop up to 820ms |
| computedRole/computedName fallback | Chrome 105+ only | Graceful fallback to getAttribute + resolveLabel |
| GROQ + Gemini only | User policy | Provider interface is abstracted |

---

## 9. Remaining Work (Post Phase AI)

### Immediate
- [x] Push all commits to origin/main (done 2026-06-26)
- [ ] **Live smoke test on real Greenhouse/Workday application** when Gemini quota restores — current E2E suite uses a local fixture
- [ ] **Chrome Web Store prep (AB.5)** — Multi-browser smoke test: Brave + Edge
- [ ] **Chrome Web Store submission (AB.6)** — Upload extension + screenshots + listing copy

### Active roadmap (per `magical-brewing-zephyr.md` plan)

- [ ] **Phase AJ** — Doc & test hardening (this section), add E2E specs for date/iframe/multi-checkbox
- [ ] **Phase AK** — Sensitive-domain blocklist (banks/health/gov) with per-domain override
- [ ] **Phase AL** — Global fingerprint tier (read path) — Supabase migration + `global-fingerprint-client.ts` + new Step 1.7 in waterfall
- [ ] **Phase AM** — Global fingerprint tier (write path + consent) — `contribute_fingerprint` SECURITY DEFINER fn + first-run disclosure dialog. Default ON, opt-out via SettingsScreen
- [ ] **Phase AN** — MCP server foundation — separate `mcp-server/` Node service exposing `resolve_form_fields`, `get_company_ats_profile`, `contribute_field_mapping`

### Future feature backlog
- [ ] **A.11** — Reviewable Q&A cache in popup (AnswersScreen enhancements)
- [ ] **B.5** — Question embedding fuzzy match (replace pure-keyword Q&A lookup)
- [ ] Resume RAG via **embeddings** (keyword-only today, see §1.7)
- [ ] **Pro tier** ($9/month): multi-resume, unlimited essays, company research
- [ ] **Firefox port** (WebExtensions API)

---

## 10. Version History

| Version | Date | Phases | Key Changes |
|---------|------|--------|-------------|
| 1.4.1 | 2026-06-27 | AJ + AK | Doc reconciliation through Phase AI; extended E2E coverage (date/iframe/multi-checkbox); pattern-based sensitive-domain blocklist expanded (insurance, pension, medicare, .gov, courts, police) + per-domain overrides via `UserSettings.domainOverrides` |
| 1.4.0 | 2026-06-26 | AH, AI + E2E hardening | Resume RAG (keyword retrieval), native ATS parser awareness (burst watcher + audit banner + skipIfFilled + teal badge), Playwright E2E harness, 4 reliability fixes (Gemini timeout, parse-error UI, radio-checked guard, dittoFilled preservation) |
| 1.3.0 | 2026-06-25 | AF, AG | Pill-overwrite fix, dropdown learning always-prompt, async dropdown polling, Supabase auth flood fix |
| 1.2.0 | 2026-06-24 | AD, AE | Form fingerprinting, ATS template seeding, embedded ATS detection (Databricks fix), char-by-char retry |
| 1.1.0 | 2026-06-21 | W, X–Z, AA, AB | ARIA detection, glass UI, lazy MiniLM, SPA fix, Web Store prep |
| 1.0.0 | 2026-06-18 | G–U | Field-handler registry, radio/checkbox, company-aware essays, resume Q&A, date handler, profile completeness |
| 0.9.0 | 2026-06-10 | A–F | Option embedding, value aliases, country aliases, Q&A cache, LLM fill tier, backend-only AI keys |
| 0.8.0 | 2026-06-01 | initial | Core waterfall (Steps 1–6), autofill, learning, Supabase sync, resume parsing, essay generation |

---

## Appendix A: Environment Variables

```bash
# .env.local — never committed, bundled at build time
VITE_SUPABASE_URL=https://cfpitvfncswfacogdehl.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_GROQ_API_KEY=gsk_4Mqk...
VITE_GEMINI_API_KEY=AQ.Ab8RN6...
```

End users NEVER see or enter these keys. They are replaced by Vite's static define transform at build time (`import.meta.env.VITE_*`).

---

## Appendix B: Build & Test

```bash
cd extension
npm run build        # TypeScript check + Vite production build → dist/
npm run dev          # Dev with HMR (for popup development)
npm run type-check   # TypeScript only, no Vite
npm test             # Jest suite (field-learner, detector, auth, providers)
```

**Load unpacked:** Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `extension/dist/`

---

## Appendix C: Debug Mode

Set in the PAGE's DevTools console (not the popup or background SW):
```javascript
window.__SFA_DEBUG = true
```

**Available logs:**
```
[SmartFillAI] platform:detected ats=greenhouse via=query_param confidence=0.95
[SmartFillAI] fingerprint:hit ats=greenhouse fields=12/15 source=template
[SmartFillAI] fingerprint:promoted source=template→learned key=greenhouse::abc
[SmartFillAI] fill via char-by-char retry succeeded ("first_name")
[SmartFillAI] select fill via embedding { value, picked, similarity }
[SmartFillAI] dropdown fill failed { value, optionsSample, optionCount }
[SmartFillAI] learn: LinkedIn URL = linkedin.com/in/...
[SmartFillAI] update: current_location → Bangalore (South), Karnataka, India
```

---

**Maintained by:** SmartFillAI  
**Next review:** Post Chrome Web Store submission
