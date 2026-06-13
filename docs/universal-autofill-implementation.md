# Universal Autofill — Complete Implementation Document

> Version 3.0 — Architecture Review & Updated Plan
> Last updated: June 2026

---

## 1. Executive Summary

We are building a browser extension that fills any form on any website using a self-growing personal profile. The product has three layers: deterministic autofill (free, instant, local), a learning loop that expands the profile over time, and AI-powered essay generation for long-form questions that require personalization.

The architecture is local-first. Profile data, embeddings, and field caches live in the browser. Cloud (Supabase) handles authentication, resume storage, cross-device sync, and backup. AI calls are reserved for two scenarios: ambiguous field classification (batched, cheap) and essay generation (on-demand, user-initiated).

The business model is freemium: free tier covers universal autofill + learning + 5 AI essays/month. Pro ($9/month) unlocks unlimited essays, multi-resume, company research, and priority support.

**Key architectural decisions:**
- Embeddings stored locally (Option D hybrid — see §11)
- Matching runs entirely in-browser (no form data leaves the device)
- Cloud sync is opt-in, batched, delta-only
- AI costs bounded to <$0.001 per page for classification, $0.05–$0.10 per essay

**Naming:** "Quill" is unavailable (quill.dev is active, quill.com is $17K). Recommended alternatives at the end of §20.

---

## 2. Product Vision

**One-line pitch:** Your profile, on every form. Learns as you go. Thinks when it matters.

**Three promises:**

1. **Instant** — Visit any page with a form, click one button, every field we recognize is filled. No API call. No delay.

2. **Learning** — When you fill a field we don't know, we ask once: "Remember this?" Your profile grows with every form you complete. After two weeks of normal use, we know almost everything about you.

3. **Thoughtful** — Long essay questions ("Why are you interested in this role?") get AI-generated drafts grounded in your resume + the company's context. You review, edit, submit. The AI writes what you'd write if you had unlimited time.

**What we are NOT:**
- Not an auto-apply bot (we fill, you submit)
- Not a password manager (we don't store credentials or credit cards)
- Not a job-application-only tool (we work on every website)
- Not a surveillance product (form data never leaves the browser unless you explicitly click "Generate")

**Positioning:** The category is "form intelligence." We sit between password managers (too rigid) and AI-powered job tools (too narrow). Our wedge is universal coverage + learning + AI for the genuinely hard fields.

---

## 3. User Journey

### 3.1 First-Time User (Day 1)

```
Install extension from Chrome Web Store
         │
         ▼
Click extension icon → Popup opens
         │
         ▼
Sign in (Google OAuth or Email/Password)
         │
         ▼
Onboarding screen:
  "Upload your resume to get started fast,
   or skip and we'll learn as you fill forms."
         │
         ├──── Upload resume ────────────────┐
         │                                    ▼
         │                          Parse resume (Claude API)
         │                          Extract: name, email, phone,
         │                          education, work history, skills
         │                          Pre-populate profile
         │                                    │
         ▼                                    ▼
Profile editor opens with extracted data
User reviews, corrects, adds missing fields
         │
         ▼
First form visit:
  Extension detects form fields on page
  Floating pill button appears: "Fill 14 fields"
  User clicks → fields fill instantly
         │
         ▼
2 fields weren't recognized → user fills manually
  Extension prompts: "Save 'Portfolio URL' for next time?"
  User clicks [Save] → profile grows
         │
         ▼
Essay question detected: "Why are you interested?"
  Extension shows: [Generate with AI] button
  User clicks → Claude drafts answer using resume context
  User edits → submits form
```

### 3.2 Returning User (Day 7+)

```
Open browser → navigate to any site with a form
         │
         ▼
Extension auto-detects form (no click needed)
Floating pill appears: "Fill 18 fields"
  (profile is richer now — more fields recognized)
         │
         ▼
User clicks → all known fields filled
  0–1 fields unknown (learning loop handled most)
         │
         ▼
If essay question exists:
  "Generate with AI" or pick from past answers
         │
         ▼
User submits. Done in ~30 seconds.
```

### 3.3 Power User (Day 30+)

```
Profile has 80+ entries across categories
Field cache covers 50+ domains
Essay history has 20+ saved answers
         │
         ▼
Most forms: 100% auto-fill, zero AI calls
Essay questions: "Similar to one you answered on March 12"
  → reuse or regenerate
         │
         ▼
Cross-device: logs into new laptop → profile syncs from cloud
  → instant productivity on new device
```

---

## 4. UX Architecture

### 4.1 Autofill Trigger — Recommendation: Hybrid (Option 4)

After analyzing all four options:

**Option 1 — Extension popup only:**
- Pros: Simple, low footprint, familiar pattern
- Cons: Requires 2 clicks (click icon → click "Fill"), bad discoverability on new sites
- Verdict: Too much friction for the core action

**Option 2 — Floating button near forms:**
- Pros: Contextual, discoverable, one-click action
- Cons: Can clash with site UI, annoying if always visible, some sites block injected elements
- Verdict: Best for the fill action, but needs to be subtle

**Option 3 — Contextual popup (appears on focus):**
- Pros: Zero-click discovery, feels native
- Cons: Can be confused with browser autofill, intrusive, performance cost of watching every focus event
- Verdict: Good for individual field suggestions, not for bulk fill

**Option 4 — Hybrid (RECOMMENDED):**

```
┌─────────────────────────────────────────────────────────────┐
│  PRIMARY: Floating pill button (Option 2)                    │
│  ─ Appears bottom-right of detected form area               │
│  ─ Shows: "Fill 14 fields" with a subtle count badge        │
│  ─ One click = fill all matched fields                      │
│  ─ Dismissible (X button, or drag to edge to hide)          │
│  ─ Remembers dismissal per-domain                           │
│                                                              │
│  SECONDARY: Per-field ghost text (Option 3, passive)         │
│  ─ When user focuses an empty field we recognize             │
│  ─ Show grayed placeholder: "Prasanna Patil"                │
│  ─ Press Tab or Enter to accept                             │
│  ─ No popup, no modal — just a visual hint                  │
│                                                              │
│  TERTIARY: Extension popup (Option 1, for management)        │
│  ─ Click icon → see profile, settings, sync status          │
│  ─ NOT the primary fill trigger                              │
│  ─ Has a "Fill this page" button as backup                  │
└─────────────────────────────────────────────────────────────┘
```

**Why this wins:**
- Floating pill handles the 80% case (bulk fill, one click)
- Ghost text handles the 15% case (individual field suggestions)
- Popup handles settings and edge cases (5%)
- Adoption rate is highest because the pill is always visible on form pages
- Accessibility: pill is keyboard-focusable, ghost text works with screen readers

### 4.2 Pre-Fill Visual Indicators

Before the user clicks "Fill":

```
┌─ Recognized field ──────────────────────────────────┐
│  Name: [  Prasanna Patil          ]  ← ghost text   │
│         (grayed out, 40% opacity)                    │
│         Disappears if user starts typing             │
│         Accepted with Tab/Enter                      │
├─ Unrecognized field ────────────────────────────────┤
│  T-Shirt Size: [                   ]  ← empty       │
│         No indicator (we don't know this)            │
├─ Essay field ───────────────────────────────────────┤
│  Why this role?                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │                              [Generate ✨]    │   │
│  │                                               │   │
│  └──────────────────────────────────────────────┘   │
│         Small button in corner of textarea           │
└─────────────────────────────────────────────────────┘
```

---

## 5. UI Wireframe Structure

### 5.1 Extension Popup Layout (360px × 500px max)

```
┌─────────────────────────────────────┐
│  HEADER                              │
│  ┌──────┐  Prasanna Patil           │
│  │ Avatar│  Pro Plan                 │
│  └──────┘  ● Synced 2 min ago       │
│                                      │
│  ─────────────────────────────────── │
│                                      │
│  QUICK ACTIONS                       │
│  ┌─────────────────────────────────┐ │
│  │  ⚡ Fill This Page (14 fields)  │ │
│  └─────────────────────────────────┘ │
│                                      │
│  TOGGLES                             │
│  Auto-Save          [████████░░] ON  │
│  Cloud Sync         [████████░░] ON  │
│  Show Ghost Text    [████████░░] ON  │
│                                      │
│  ─────────────────────────────────── │
│                                      │
│  PROFILE SUMMARY                     │
│  Contact     12 fields    [Edit →]   │
│  Education    6 fields    [Edit →]   │
│  Work         8 fields    [Edit →]   │
│  Custom      14 fields    [Edit →]   │
│                                      │
│  ─────────────────────────────────── │
│                                      │
│  RESUME                              │
│  resume_2026.pdf     [Replace]       │
│  Parsed: 42 fields extracted         │
│                                      │
│  ─────────────────────────────────── │
│                                      │
│  STORAGE                             │
│  Local: 2.1 MB / 10 MB              │
│  Cloud: 4.3 MB (synced)             │
│                                      │
│  ─────────────────────────────────── │
│                                      │
│  FOOTER                              │
│  [Dashboard]  [Settings]  [Logout]   │
│  v1.0.0                             │
└─────────────────────────────────────┘
```

### 5.2 In-Page Overlay (Floating Pill)

```
┌───────────────────────────────────┐
│  ✨ Fill 14 fields    [×]         │
└───────────────────────────────────┘
  ↑ Pill: 200px wide, 36px tall
  ↑ Position: bottom-right of form, 16px offset
  ↑ Background: frosted glass (backdrop-blur)
  ↑ Click → fills all matched fields with animation
  ↑ After fill: "✓ Filled 14 fields" → fades out in 3s
```

### 5.3 Learn Prompt (After User Types in Unknown Field)

```
┌───────────────────────────────────────────┐
│  Save "linkedin.com/in/pspatilx"          │
│  as LinkedIn URL?                         │
│                                           │
│  Category: [Social ▾]                     │
│                                           │
│  [Save]  [Edit Name]  [Skip]  [Never Ask]│
└───────────────────────────────────────────┘
  ↑ Appears as toast, bottom of viewport
  ↑ Non-blocking (form still usable)
  ↑ Auto-dismiss after 10s if no action
```

### 5.4 Essay Generation Overlay

```
┌───────────────────────────────────────────────┐
│  Generate Answer                    [×]        │
│                                                │
│  Question: "Why are you interested in          │
│  this role at Embassy Group?"                  │
│                                                │
│  ── Using ──                                   │
│  📄 resume_2026.pdf                            │
│  🏢 Embassy Group (auto-detected from page)    │
│                                                │
│  ┌─────────────────────────────────────────┐  │
│  │  I'm drawn to this role because of my   │  │
│  │  experience building enterprise         │  │
│  │  integrations at Verifone, where I...   │  │
│  │  ▌ (streaming)                          │  │
│  └─────────────────────────────────────────┘  │
│                                                │
│  [Use This]  [Regenerate]  [Edit Before Use]  │
└───────────────────────────────────────────────┘
```

---

## 6. Browser Extension Architecture

### 6.1 Component Map

```
┌─────────────────────────────────────────────────────────────┐
│  BROWSER EXTENSION (Manifest V3)                             │
│                                                              │
│  ┌─────────────────┐  ┌──────────────────────────────────┐  │
│  │  popup/          │  │  content-script/                  │  │
│  │  ─ popup.tsx     │  │  ─ detector.ts (form detection)   │  │
│  │  ─ auth.tsx      │  │  ─ filler.ts (value injection)    │  │
│  │  ─ profile.tsx   │  │  ─ learner.ts (learn-on-fill)     │  │
│  │  ─ settings.tsx  │  │  ─ overlay.ts (pill + ghost text) │  │
│  │                  │  │  ─ essay-ui.ts (generate overlay)  │  │
│  └────────┬─────────┘  └────────────┬───────────────────────┘  │
│           │                          │                        │
│           │    chrome.runtime.sendMessage()                   │
│           │                          │                        │
│  ┌────────▼──────────────────────────▼───────────────────┐   │
│  │  background/ (Service Worker)                          │   │
│  │  ─ auth-manager.ts    (token refresh, session)        │   │
│  │  ─ sync-engine.ts     (delta sync to Supabase)        │   │
│  │  ─ ai-client.ts       (Claude API calls)              │   │
│  │  ─ embedder.ts        (MiniLM via transformers.js)    │   │
│  │  ─ profile-store.ts   (CRUD on chrome.storage)        │   │
│  │  ─ field-cache.ts     (domain → field mapping cache)  │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  storage/ (chrome.storage.local + IndexedDB)          │   │
│  │  ─ profile_entries    (JSON, <1 MB typical)           │   │
│  │  ─ embeddings         (Float32Array, ~2 MB)           │   │
│  │  ─ field_cache        (Map, <500 KB)                  │   │
│  │  ─ essay_drafts       (recent 20, <200 KB)            │   │
│  │  ─ settings           (JSON, <1 KB)                   │   │
│  │  ─ sync_queue         (pending deltas, <100 KB)       │   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Content Script Lifecycle

```
Page load
    │
    ▼
content-script injected
    │
    ▼
detector.ts: scan DOM for <form>, <input>, <textarea>, <select>
    │
    ├── No forms found → sleep, attach MutationObserver
    │                      (re-scan on DOM changes for SPAs)
    │
    ├── Forms found → extract FieldSignature for each input
    │       │
    │       ▼
    │   matcher.ts: run waterfall (steps 1–4, all local)
    │       │
    │       ├── Step 1: cache lookup (domain + fingerprint)
    │       ├── Step 2: essay detection (textarea + patterns)
    │       ├── Step 3: deterministic match (regex/keyword)
    │       ├── Step 4: embedding similarity (MiniLM, local)
    │       │
    │       ▼
    │   Results: each field tagged as:
    │     MATCHED (profile_entry_id, confidence)
    │     ESSAY (generate-on-demand)
    │     UNKNOWN (no match)
    │     SKIP (password, captcha, hidden)
    │       │
    │       ▼
    │   overlay.ts: inject floating pill + ghost text
    │       │
    │       ▼
    │   User clicks "Fill" → filler.ts injects values
    │       │
    │       ▼
    │   learner.ts: watch for manual typing in UNKNOWN fields
    │       │
    │       ▼
    │   On blur/debounce: prompt "Save this?"
    │
    ▼
Page unload → cleanup injected UI
```

### 6.3 Key Technical Decisions

**Why Manifest V3 (not V2):**
- Chrome deprecated V2 in June 2024. V2 extensions can't publish.
- V3 service workers have a 5-minute idle timeout. We handle this by using chrome.alarms for periodic sync and waking the SW on content-script messages.

**Why MutationObserver (not polling):**
- SPAs like React/Next.js render forms dynamically after initial page load
- MutationObserver fires on DOM changes with zero CPU cost when idle
- We filter mutations to only process added `<input>`, `<textarea>`, `<select>` nodes

**Why chrome.storage.local + IndexedDB (not just one):**
- chrome.storage.local: JSON-friendly, auto-syncs with service worker, 10 MB quota
- IndexedDB: larger capacity (50–100 MB), better for binary data (embeddings as Float32Array)
- Split: profile entries + settings in chrome.storage.local, embeddings + field cache in IndexedDB

---

## 7. Backend Architecture

### 7.1 System Overview

```
┌──────────────────────────────────────────────────────────────┐
│  SUPABASE (Backend-as-a-Service)                              │
│                                                               │
│  ┌─────────────┐  ┌────────────┐  ┌────────────────────────┐│
│  │  Auth        │  │  Database   │  │  Storage               ││
│  │  ─ Google    │  │  ─ Postgres │  │  ─ Resume PDFs         ││
│  │    OAuth     │  │  ─ RLS      │  │  ─ Signed URLs         ││
│  │  ─ Email/    │  │  ─ pgvector │  │  ─ Per-user folders    ││
│  │    Password  │  │             │  │                        ││
│  └──────┬──────┘  └──────┬─────┘  └───────────┬────────────┘│
│         │                │                      │             │
│  ┌──────▼──────────────────▼──────────────────────▼──────────┐│
│  │  Edge Functions (Deno)                                     ││
│  │                                                            ││
│  │  /classify-fields   → Haiku batch classify (rare)         ││
│  │  /generate-essay    → Sonnet streaming + resume context   ││
│  │  /suggest-key       → Haiku, name a learned field         ││
│  │  /parse-resume      → Sonnet, extract structured data     ││
│  │  /research-company  → Haiku + web search (Pro only)       ││
│  │  /sync-profile      → receive delta, merge, return ACK    ││
│  └───────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Why Supabase (Not Self-Hosted)

| Requirement | Supabase | Self-hosted Postgres | Firebase |
|---|---|---|---|
| Auth (Google OAuth + Email) | Built-in, free tier | You build it | Built-in |
| Postgres with RLS | Native | Native but you manage | Firestore (NoSQL) |
| pgvector for embeddings | Supported | You install | Not available |
| File storage (resumes) | Built-in, signed URLs | You build (S3?) | Built-in |
| Edge functions | Deno-based, free tier | You deploy (Lambda?) | Cloud Functions |
| Cost at 1K users | ~$25/month (Pro plan) | ~$20/month (VPS) | ~$30/month |
| Maintenance | Zero | You manage backups, uptime | Low |
| Migration path | Standard Postgres | Already there | Vendor lock-in |

**Verdict:** Supabase gives us auth + Postgres + storage + edge functions + pgvector in one platform. At our scale (<10K users in year 1), it's cheaper and simpler than self-hosting. If we outgrow it, we can migrate to raw Postgres because Supabase IS Postgres.

### 7.3 What Supabase Handles (and ONLY What It Handles)

| Responsibility | Supabase? | Why |
|---|---|---|
| Authentication | ✅ Yes | Can't be done client-side securely |
| Resume PDF storage | ✅ Yes | Too large for browser storage (5–10 MB) |
| Profile backup + cross-device sync | ✅ Yes | Users expect account recovery |
| Essay generation (Claude API proxy) | ✅ Yes | API key can't live in extension code |
| Embedding storage | ❌ No (local primary) | See §11 for analysis |
| Field cache | ❌ No (local only) | Per-device, per-domain, no cloud value |
| Form data / page content | ❌ Never | Privacy red line |

---

## 8. Local Storage Architecture

### 8.1 Storage Map

```
┌───────────────────────────────────────────────────────────┐
│  chrome.storage.local (10 MB quota, JSON only)             │
│                                                            │
│  profile_v1          ~200 KB   Profile entries as JSON     │
│  settings_v1         ~1 KB     User preferences            │
│  session_v1          ~2 KB     Auth token (encrypted)      │
│  sync_meta_v1        ~1 KB     Last sync timestamp, delta  │
│  essay_drafts_v1     ~100 KB   Last 20 generated essays    │
│                                                            │
│  Subtotal: ~304 KB typical                                 │
└───────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│  IndexedDB (50–100 MB quota, binary-friendly)              │
│                                                            │
│  embeddings store    ~2 MB     Float32Array per entry      │
│  field_cache store   ~500 KB   domain+fingerprint → match  │
│  miniml_model        ~22 MB    Quantized MiniLM weights    │
│                                (loaded lazily on first     │
│                                 embedding match attempt)   │
│                                                            │
│  Subtotal: ~24.5 MB typical                                │
└───────────────────────────────────────────────────────────┘

Total local footprint: ~25 MB
```

### 8.2 Why Two Storage Backends

chrome.storage.local is convenient (sync with service worker, simple API) but JSON-only and limited to 10 MB. IndexedDB handles binary data (embeddings as typed arrays) and has a much larger quota. Splitting them plays to each one's strengths.

### 8.3 Encryption

- Auth token: encrypted with `crypto.subtle.encrypt()` using a device-derived key (from `chrome.runtime.id` + user passphrase)
- Sensitive profile entries (SSN, government IDs): flagged `sensitive: true`, encrypted at rest in both local and cloud storage
- Non-sensitive entries (name, email, phone): stored as plaintext locally for instant access

---

## 9. Cloud Synchronization Architecture

### 9.1 Sync Strategy — Recommendation: Batched Delta Sync

After analyzing all options:

| Strategy | Latency | Cost | Complexity | Data consistency |
|---|---|---|---|---|
| Real-time (every keystroke) | 0s | Very high | High (WebSocket) | Perfect |
| Every field change | ~100ms | High | Medium | Good |
| **Batched every 5 min** | **5 min** | **Low** | **Low** | **Good enough** |
| On browser close | Variable | Lowest | Low | Risky (crash = data loss) |
| Manual only | N/A | Zero | Lowest | User-dependent |

**Recommendation: Batched delta sync every 5 minutes, plus on explicit "Save" actions.**

### 9.2 Delta Sync Protocol

```
Extension maintains a local changelog:

sync_queue = [
  { op: "add", entry_id: "abc", data: {...}, timestamp: 1718... },
  { op: "update", entry_id: "def", field: "value", old: "...", new: "...", timestamp: ... },
  { op: "delete", entry_id: "ghi", timestamp: ... }
]

Every 5 minutes (or on user click "Sync Now"):
  1. Extension sends sync_queue to /sync-profile edge function
  2. Server applies changes using last-write-wins (timestamp-based)
  3. Server returns any changes from OTHER devices since last sync
  4. Extension merges incoming changes into local storage
  5. sync_queue is cleared
  6. sync_meta_v1.last_sync = now()
```

### 9.3 Conflict Resolution

**Strategy: Last-write-wins with conflict log**

```
Device A changes "phone" to "111" at T=10
Device B changes "phone" to "222" at T=12

Server receives both:
  → T=12 wins, "phone" = "222"
  → Conflict logged: { field: "phone", lost_value: "111", from: "Device A" }
  → User can review conflicts in dashboard (rare, but available)
```

For most users (single device), conflicts never happen. For multi-device users, LWW is good enough — they'll notice and correct.

### 9.4 Offline Mode

```
Internet unavailable:
  1. Extension works normally (all matching is local)
  2. Changes accumulate in sync_queue
  3. Essay generation fails with message: "Offline — essay generation requires internet"
  4. When internet returns:
     - Background SW detects connectivity (navigator.onLine + periodic ping)
     - sync_queue drains automatically
     - No user action needed
```

### 9.5 User Control Model

| Setting | Default | Options |
|---|---|---|
| Auto-Save (learn new fields) | ON | ON / OFF |
| Cloud Sync | ON | ON / OFF |
| Sync Frequency | Every 5 min | Real-time / 5 min / 30 min / Manual |
| Ghost Text (pre-fill hints) | ON | ON / OFF |
| Sensitive Domain Blocking | ON | ON / OFF (per-domain override) |

---

## 10. Resume Processing Architecture

### 10.1 Upload Flow

```
User clicks "Upload Resume" in popup or dashboard
         │
         ▼
File picker opens → user selects PDF (max 10 MB)
         │
         ▼
PDF uploaded to Supabase Storage
  → stored in /resumes/{user_id}/{filename}
  → signed URL generated (expires in 1 hour)
         │
         ▼
Edge function /parse-resume triggered:
  1. Download PDF from Storage
  2. Extract text (pdf-parse library)
  3. Send text to Claude Sonnet:
     System: "Extract structured profile data from this resume."
     Output: JSON with name, email, phone, education[], 
             work_experience[], skills[], certifications[]
  4. Return structured JSON to extension
         │
         ▼
Extension receives parsed data:
  1. Display to user for review: "We found these 42 fields"
  2. User checks/unchecks fields to import
  3. Confirmed fields → added to profile_entries
  4. Each entry gets a local embedding (MiniLM)
  5. Profile syncs to cloud on next batch
         │
         ▼
Resume text cached locally (for essay generation context)
  → stored in chrome.storage.local as resume_text_v1
  → ~50–100 KB typical
  → refreshed when user uploads a new resume
```

### 10.2 Why Cloud for Resume Storage

| Approach | Resume size | Browser limit | Verdict |
|---|---|---|---|
| chrome.storage.local | 5–10 MB | 10 MB total | ❌ Eats entire quota |
| IndexedDB | 5–10 MB | 50–100 MB | ⚠️ Possible but fragile |
| Supabase Storage | 5–10 MB | Unlimited | ✅ Correct place |

**The parsed text** (~50–100 KB) lives locally. The **original PDF** lives in Supabase. This gives us:
- Fast local access to resume content (for essay generation)
- Cloud backup of the original file (for re-parsing, re-downloading)
- No local storage pressure from large PDFs

### 10.3 Resume Intelligence — What Gets Extracted

```json
{
  "personal": {
    "name": "Prasanna Patil",
    "email": "psp@example.com",
    "phone": "+91 9876543210",
    "linkedin": "linkedin.com/in/pspatilx",
    "github": "github.com/pspatilx",
    "location": "Bangalore, India"
  },
  "education": [
    {
      "institution": "Bangalore Institute of Technology",
      "degree": "B.Tech Computer Science",
      "year": "2024",
      "gpa": "8.5/10"
    }
  ],
  "work_experience": [
    {
      "company": "Verifone",
      "role": "Software Engineer",
      "duration": "2024–Present",
      "highlights": [
        "Built MCP server connecting Claude to SQL Server",
        "Delivered compliance system under regulatory deadline",
        "PowerShell automation reducing multi-person process to one day"
      ]
    }
  ],
  "skills": ["React", "TypeScript", "Node.js", "Supabase", "Claude API", "FastAPI"],
  "certifications": []
}
```

Each field becomes a `profile_entry` with a canonical key, category, and embedding.

---

## 11. Embedding Strategy Recommendation

This is the critical architecture decision. Four options analyzed:

### Option A: Cloud Only (Supabase pgvector)

```
Extension → API call → Supabase pgvector → similarity search → return matches
```

| Metric | Score | Notes |
|---|---|---|
| Performance | ❌ Poor | 200–500ms round-trip per page load |
| Privacy | ❌ Poor | Form field labels sent to server |
| Cost | ⚠️ Medium | pgvector queries cost CPU |
| Offline | ❌ None | No matching when offline |
| Search speed | ⚠️ Medium | Network-bound |
| Scalability | ✅ Good | Postgres scales well |
| Cross-device | ✅ Perfect | One source of truth |
| Complexity | ✅ Low | One storage location |

**Verdict: Rejected.** Sending form labels to the server on every page load violates the privacy promise.

### Option B: Both Local + Cloud

```
Extension → local MiniLM → match
Cloud → pgvector backup → used for cross-device restore
```

| Metric | Score | Notes |
|---|---|---|
| Performance | ✅ Great | Local match in ~30ms |
| Privacy | ✅ Great | Form data stays local |
| Cost | ⚠️ Medium | Dual storage maintenance |
| Offline | ✅ Full | Local embeddings available |
| Search speed | ✅ Fast | In-memory cosine similarity |
| Scalability | ✅ Good | Local scales with profile size |
| Cross-device | ✅ Good | Cloud backup for restore |
| Complexity | ⚠️ Medium | Two embedding stores to sync |

**Verdict: Close, but overkill.** Storing embeddings in cloud doubles storage work for a feature (cloud-side similarity search) we don't actually need.

### Option C: Structured Profile Local, Embeddings Cloud Only

```
Profile (key-value) → local
Embeddings → cloud only, fetched on demand
```

| Metric | Score | Notes |
|---|---|---|
| Performance | ❌ Poor | Can't do similarity match without network |
| Privacy | ⚠️ Medium | Embeddings in cloud (not raw data, but still) |
| Cost | ⚠️ Medium | pgvector storage |
| Offline | ❌ Partial | Deterministic match works, embedding match doesn't |
| Complexity | ⚠️ Medium | Split architecture |

**Verdict: Rejected.** Breaks offline matching, the whole point of local-first.

### Option D: Hybrid — Local Primary, Cloud Backup of Profile (NOT Embeddings) ✅ RECOMMENDED

```
Profile entries (with embeddings) → LOCAL (chrome.storage + IndexedDB)
Profile entries (WITHOUT embeddings) → CLOUD (Supabase Postgres, for backup/sync)
Embeddings → RECOMPUTED on each device from profile text using local MiniLM

Cloud stores: canonical_key, display_label, aliases, value, category, sensitive flag
Cloud does NOT store: embeddings, field_cache, essay_drafts

When user logs in on new device:
  1. Pull profile entries from Supabase
  2. Run MiniLM locally to recompute all embeddings (~5 seconds for 100 entries)
  3. Store in local IndexedDB
  4. Ready to match
```

| Metric | Score | Notes |
|---|---|---|
| Performance | ✅ Great | All matching is local, ~30ms |
| Privacy | ✅ Best | Embeddings never leave device; cloud has only structured text |
| Cost | ✅ Lowest | No pgvector needed in cloud; plain Postgres |
| Offline | ✅ Full | Everything needed for matching is local |
| Search speed | ✅ Fast | In-memory cosine similarity |
| Scalability | ✅ Good | Local scales to 500+ entries easily |
| Cross-device | ✅ Good | Profile syncs, embeddings recomputed (~5s one-time) |
| Complexity | ✅ Low | Cloud is just a JSON backup; no vector DB needed |

**Why this wins:**
1. **No pgvector in production.** Drops a whole technology from the backend. Supabase free tier doesn't even need the pgvector extension enabled.
2. **Embeddings are deterministic.** Same text → same embedding. No need to sync them; just recompute.
3. **Privacy maximized.** Cloud stores "phone_number: +91 9876543210" — not a 384-dimensional vector that could be reverse-engineered.
4. **Cross-device works.** 5 seconds of recomputation on login is invisible to the user.
5. **Simplest architecture.** One source of truth (local), one backup (cloud text), one computation (local MiniLM).

---

## 12. Learning & Memory System

### 12.1 What Triggers Learning

| Event | Action | Confirmation needed? |
|---|---|---|
| User types in UNKNOWN field | Prompt: "Save as ___?" | ✅ Yes, always |
| User corrects a MATCHED field | Prompt: "Update ___ to new value?" | ✅ Yes |
| User fills same UNKNOWN field on 3+ sites | Auto-suggest: "You've entered this 3 times — save it?" | ✅ Yes |
| Resume parsed | Show all extracted fields for review | ✅ Yes (bulk confirm) |
| User deletes a field in profile editor | Removed immediately | ❌ No confirmation (undo available for 10s) |

### 12.2 Learning Pipeline

```
User types into empty field
         │
         ▼
Debounce 2 seconds after last keystroke
         │
         ▼
Extract: { value, field_signature }
         │
         ▼
Dedup check: does a profile entry with similar value already exist?
  ├── Yes → suppress prompt (don't ask "Save 9876543210 as Phone?" 
  │         if we already have it as "Mobile Number")
  │
  ├── No → generate suggested canonical key:
  │         1. Try deterministic rules first (label contains "phone" → "phone_number")
  │         2. If ambiguous → Haiku call: "What is this field?" → "portfolio_url"
  │
  ▼
Show learning prompt:
  "Save 'linkedin.com/in/pspatilx' as LinkedIn URL?"
  [Save]  [Edit Name]  [Skip]  [Never Ask on this site]
         │
         ├── Save → create profile_entry, compute embedding, sync to cloud
         ├── Edit Name → user renames, then save
         ├── Skip → do nothing, may ask again on another site
         └── Never Ask → add to site-level ignore list
```

### 12.3 What Should Be Automatic vs Manual

| Action | Automatic | Manual | Why |
|---|---|---|---|
| Detecting a new field | ✅ | | Always scan |
| Suggesting a name for the field | ✅ | | AI or deterministic |
| Saving to profile | | ✅ | User must confirm |
| Updating an existing value | | ✅ | Could be a one-time override |
| Deleting a profile entry | | ✅ | Destructive action |
| Syncing to cloud | ✅ | | Background, based on toggle |
| Recomputing embeddings | ✅ | | Transparent to user |

---

## 13. Autofill Workflow

### 13.1 Field Detection Waterfall (Updated)

```
For each visible <input>, <textarea>, <select> on the page:

Step 1: SKIP CHECK                           cost: 0    latency: <1ms
  → Is this a password field? Captcha? Hidden? File input?
  → If yes → tag as SKIP, move to next field

Step 2: CACHE LOOKUP                         cost: 0    latency: ~1ms
  → Hash(domain + field_signature) → check field_cache
  → If hit with confidence > 0.9 → MATCHED
  → Cache hit rate after 1 week: ~70% of all fields

Step 3: ESSAY DETECTION                      cost: 0    latency: ~1ms
  → Is this a <textarea> with max_length >= 300 or no max_length?
  → Does the label match essay patterns?
  → If yes → tag as ESSAY, show "Generate" button

Step 4: DETERMINISTIC MATCH                  cost: 0    latency: ~5ms
  → Run regex/keyword rules against:
    label_text, placeholder, name_attr, id_attr, aria_label,
    surrounding_text, input_type
  → 200+ rules organized by category:
    Contact: email, phone, name (first, last, full), address
    Identity: DOB, gender, pronouns, nationality
    Education: university, degree, GPA, graduation year
    Work: company, role, years of experience
    Social: LinkedIn, GitHub, portfolio, Twitter/X
    Preferences: t-shirt size, dietary, timezone
  → If match with confidence > 0.8 → MATCHED
  → Coverage: ~80% of common fields

Step 5: EMBEDDING SIMILARITY                 cost: 0    latency: ~30ms
  → Compute embedding of field_signature using local MiniLM
  → Cosine similarity against all profile entry embeddings
  → If best match > 0.85 threshold → MATCHED
  → Coverage: another ~12% (synonyms, unusual phrasings)

Step 6: LLM CLASSIFIER (BATCHED)             cost: ~$0.0001  latency: ~500ms
  → Collect all remaining UNKNOWN fields on the page
  → Single Haiku call: "Given these field signatures, which profile
    entries do they map to? Return JSON."
  → Coverage: another ~5%
  → Only fires if there are 2+ truly ambiguous fields

Step 7: TAG REMAINING AS UNKNOWN             cost: 0    latency: 0
  → These are fields we genuinely don't have data for
  → No action taken
  → If user fills them → learning loop activates
```

### 13.2 Fill Execution

```
User clicks "Fill 14 fields"
         │
         ▼
For each MATCHED field:
  1. Check if field is in a sensitive domain AND entry is sensitive
     → If yes → skip (require per-field confirmation)
  2. Set field value using:
     → input.value = profile_value
     → Dispatch 'input', 'change', 'blur' events (React compatibility)
     → For <select>: find matching option, set selectedIndex
     → For radio buttons: click the matching option
     → For checkboxes: check if value matches (e.g., "Yes" → check)
  3. Add subtle green flash animation to filled field (200ms)

After all fields filled:
  → Pill updates: "✓ Filled 14 fields"
  → Unfilled fields highlighted with dotted border (optional, toggle-able)
  → Pill fades out after 3 seconds
```

### 13.3 React/SPA Compatibility

React and other SPA frameworks don't respond to `input.value = x`. They use synthetic events. The filler must:

```javascript
// Set the value using the native setter (bypasses React's controlled component)
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype, 'value'
).set;
nativeInputValueSetter.call(inputElement, newValue);

// Dispatch events that React listens for
inputElement.dispatchEvent(new Event('input', { bubbles: true }));
inputElement.dispatchEvent(new Event('change', { bubbles: true }));
```

This is the most common source of "autofill doesn't work" bugs. Test on React, Vue, Angular, Svelte, and vanilla HTML.

---

## 14. Security & Privacy Architecture

### 14.1 Threat Model

| Threat | Risk | Mitigation |
|---|---|---|
| Extension compromise (malicious update) | High | Code review before publish, CSP headers, no remote code |
| Supabase breach | Medium | RLS (users can only access own rows), encrypted sensitive fields |
| Man-in-the-middle | Low | HTTPS everywhere, certificate pinning on API calls |
| User's computer compromised | Out of scope | We can't protect against a rooted machine |
| Cross-site data leakage | Medium | Content script runs in isolated world, no DOM pollution |
| Malicious website reading filled values | Low | Values injected into the site's DOM — the site CAN read them (this is by design; we're filling their form). We don't fill on suspicious/blocklisted domains. |

### 14.2 Hard Rules

1. **No form-content telemetry.** We never log what fields exist on a page, what values were filled, or what the page URL was — unless the user explicitly clicks "Generate" (which sends the essay question to Claude).

2. **Local-first matching.** Steps 1–5 of the waterfall happen in-browser. The server never sees the page form unless the user initiates an AI action.

3. **Sensitive-domain blocklist.** Default-disabled on:
   - Banking: *.bank, known bank domains
   - Government: *.gov, *.gov.in, *.irs.gov
   - Healthcare: known hospital/insurance portals
   - Payment: checkout pages (detected by form field patterns)
   - User can override per-domain with explicit consent

4. **Sensitive entry protection.** Entries flagged `sensitive: true`:
   - Encrypted at rest (local + cloud)
   - Require extra click to fill (not included in bulk "Fill all")
   - Never shown in ghost text
   - Visually marked in profile editor

5. **No credit card storage.** Explicit blocklist for card number patterns. "Use a password manager for that."

6. **No training on user data.** Anthropic API default = no training. We state this in the privacy policy.

7. **Audit log.** Every autofill event logged locally:
   ```
   { timestamp, domain, fields_filled: 14, ai_used: false }
   ```
   Viewable in dashboard. Exportable as CSV. No PII in the log (field names only, not values).

8. **One-click wipe.** Dashboard button: "Delete all my data" → wipes local + cloud + resumes. Irreversible with 5-second confirmation.

### 14.3 Chrome Web Store Compliance

| Requirement | How we comply |
|---|---|
| Justify `<all_urls>` | "Universal form autofill requires access to detect forms on any website" |
| No remote code execution | MiniLM bundled with extension, not fetched at runtime |
| Privacy policy | Published on website + in popup + in dashboard |
| Single focused purpose | "Automatically fill forms using your personal profile" |
| Data use disclosure | "We collect: profile data you provide. We do not collect: browsing history, form contents, page URLs." |
| Minimal permissions | `activeTab`, `storage`, `identity` (for OAuth). No `tabs`, no `history`. |

---

## 15. Performance Optimization Strategy

### 15.1 Targets

| Operation | Target | Actual (estimated) |
|---|---|---|
| Form detection | <50ms | ~30ms (DOM scan + signature extraction) |
| Waterfall steps 1–4 | <100ms | ~40ms (cache + regex + embedding) |
| Fill execution | <200ms | ~150ms (value injection + event dispatch) |
| Essay generation | <3s first token | ~1.5s (Sonnet streaming) |
| Extension popup open | <200ms | ~100ms (cached profile render) |
| MiniLM model load | <3s (first time) | ~2s (from IndexedDB cache) |
| Cross-device profile restore | <10s | ~5s (download + recompute embeddings) |

### 15.2 Optimization Techniques

**Lazy model loading:** MiniLM (22 MB) loads only when Step 5 (embedding match) is first needed. For many pages, Steps 1–4 handle everything, and the model is never loaded.

**Profile in-memory cache:** On service worker wake, profile entries loaded into a Map for O(1) lookup by canonical_key. Embeddings loaded into a Float32Array for fast cosine similarity.

**Field cache is the fast path:** After visiting a site once, the cache handles most fields on subsequent visits (Step 2, <1ms). The cache persists in IndexedDB across browser restarts.

**Debounced detection:** MutationObserver fires on every DOM change. We debounce re-scans by 300ms to avoid thrashing on SPAs that render incrementally.

**No unnecessary reflows:** Overlay UI uses `position: fixed` + `pointer-events: none` on the container, with `pointer-events: auto` only on interactive elements. No layout shifts.

---

## 16. Offline Support Strategy

### 16.1 What Works Offline

| Feature | Offline? | Why |
|---|---|---|
| Form detection | ✅ Yes | Pure DOM scanning |
| Deterministic matching (Steps 1–4) | ✅ Yes | Local profile + cache + embeddings |
| Autofill execution | ✅ Yes | Local data injection |
| Learning (save new fields) | ✅ Yes | Saved locally, synced later |
| Essay generation | ❌ No | Requires Claude API |
| LLM field classification (Step 6) | ❌ No | Requires Haiku API |
| Profile sync | ❌ No | Requires internet |
| Resume upload | ❌ No | Requires Supabase Storage |

### 16.2 Offline Queue

```
Changes made while offline:
  → Accumulated in sync_queue (chrome.storage.local)
  → On reconnect: background SW drains queue automatically
  → No user action needed
  → If queue exceeds 1 MB: warn user, suggest manual sync
```

### 16.3 Graceful Degradation

When essay generation fails offline:
```
"You're offline. Essay generation requires internet.
 Would you like to use a past answer instead?"
 
 [Browse Past Answers]  [Skip for Now]
```

---

## 17. Multi-Browser Support Strategy

### 17.1 Priority Order

| Browser | Priority | Market share | Extension API | Effort |
|---|---|---|---|---|
| Chrome | P0 (MVP) | 65% | Manifest V3 | Baseline |
| Edge | P1 (Phase 2) | 12% | Same as Chrome (Chromium) | ~5% delta |
| Brave | P1 (Phase 2) | 2% | Same as Chrome (Chromium) | ~2% delta |
| Firefox | P2 (Phase 3) | 6% | WebExtensions (different) | ~30% delta |
| Safari | P3 (Phase 3+) | 18% | Safari Web Extensions | ~50% delta |
| Arc | P1 (Phase 2) | <1% | Chrome extensions work | 0% delta |

### 17.2 Architecture for Portability

```
shared/                    ← Platform-agnostic code
  matcher.ts               ← Waterfall logic, regex rules
  types.ts                 ← ProfileEntry, FieldSignature, etc.
  embedder.ts              ← MiniLM wrapper

platform/
  chromium/                ← Chrome, Edge, Brave, Arc
    manifest.json          ← Manifest V3
    background.ts          ← chrome.* APIs
    storage.ts             ← chrome.storage + IndexedDB
  firefox/
    manifest.json          ← WebExtensions V2/V3 hybrid
    background.ts          ← browser.* APIs (polyfilled)
    storage.ts             ← browser.storage + IndexedDB
  safari/
    manifest.json          ← Safari Web Extension
    ...
```

**Key difference: Firefox** uses `browser.*` instead of `chrome.*`. The `webextension-polyfill` library bridges this. The main code stays identical; only the platform adapter changes.

**Safari** requires an Xcode project wrapper. It's the most expensive port. Defer until there's demand.

---

## 18. Scalability Considerations

### 18.1 At 1K Users (Month 6)

- Supabase free tier handles everything
- AI costs: ~$200/month (essays)
- Storage: <1 GB total
- No scaling concerns

### 18.2 At 10K Users (Month 12)

- Supabase Pro ($25/month) needed for connection limits
- AI costs: ~$2K/month
- Storage: ~10 GB
- Consider: batch essay requests during peak hours to manage Claude API rate limits

### 18.3 At 100K Users (Year 2)

- Supabase Team plan or self-hosted Postgres
- AI costs: ~$15K/month (offset by $90K+ MRR from Pro subscriptions)
- Storage: ~100 GB
- Consider: caching company research snapshots (shared across users, not user-specific)
- Consider: edge caching for popular deterministic rules (CDN-delivered rule updates)

### 18.4 At 1M Users (Year 3+)

- Self-hosted Postgres cluster (or managed: Neon, Supabase Enterprise)
- AI costs: ~$100K/month (need to negotiate Anthropic volume pricing)
- Multiple edge function regions (US, EU, Asia)
- Consider: on-device essay generation using smaller models (Llama 3, Phi-3) to reduce cloud costs

---

## 19. Engineering Roadmap

### 19.1 Delivery Model — Recommendation: Agile with Fixed Milestones

**Why not Waterfall:**
- Form detection robustness requires continuous iteration (you can't spec every DOM edge case upfront)
- User feedback on UX (ghost text, pill placement) needs rapid cycling
- AI prompt tuning is inherently iterative

**Why not pure Agile:**
- Some components have hard dependencies (auth must work before sync, matcher must work before learning)
- Chrome Web Store review has a 1–2 week lead time

**Recommendation: 2-week sprints with 4 fixed milestones:**

### Milestone 1: Core Extension (Weeks 1–4)

Sprint 1 (Week 1–2):
- [ ] Repo setup (monorepo structure)
- [ ] Manifest V3 boilerplate
- [ ] Content script: form detection + field signature extraction
- [ ] Deterministic matcher (Steps 1–3): 200+ regex/keyword rules
- [ ] Test harness: 10 saved HTML snapshots from real sites
- [ ] Target: >80% recall on test corpus

Sprint 2 (Week 3–4):
- [ ] Popup UI: auth screen + profile editor (React + Tailwind)
- [ ] Supabase project: auth (Google OAuth + email/password)
- [ ] chrome.storage.local: profile CRUD
- [ ] Filler: value injection with React/SPA compatibility
- [ ] Floating pill overlay: "Fill N fields" button
- [ ] Target: install extension, sign in, fill a Greenhouse form

### Milestone 2: Learning + Embeddings (Weeks 5–8)

Sprint 3 (Week 5–6):
- [ ] MiniLM integration (transformers.js, lazy-loaded into IndexedDB)
- [ ] Embedding computation on profile save
- [ ] Step 5: cosine similarity matching
- [ ] Learning loop: detect typing in unknown fields, prompt "Save as?"
- [ ] Dedup check before prompting
- [ ] Target: extension learns 5 new fields per session

Sprint 4 (Week 7–8):
- [ ] Ghost text overlay (pre-fill hints in focused fields)
- [ ] Per-domain enable/disable (popup toggle)
- [ ] Sensitive domain blocklist (banks, gov, healthcare)
- [ ] Field cache (IndexedDB, persist across sessions)
- [ ] Target: returning user sees 90%+ fields auto-filled on familiar sites

### Milestone 3: AI + Resume (Weeks 9–12)

Sprint 5 (Week 9–10):
- [ ] Resume upload to Supabase Storage
- [ ] Edge function: /parse-resume (Claude Sonnet)
- [ ] Resume → profile extraction with user review
- [ ] Edge function: /generate-essay (Claude Sonnet, streaming)
- [ ] Essay generation overlay UI
- [ ] Target: upload resume, get 42 fields, generate one essay

Sprint 6 (Week 11–12):
- [ ] Cloud sync engine (delta sync, 5-minute batches)
- [ ] Sync queue + offline support
- [ ] Audit log (local, viewable in popup)
- [ ] Privacy policy page
- [ ] Chrome Web Store submission prep (screenshots, description, permissions justification)
- [ ] Target: submitted to Chrome Web Store for review

### Milestone 4: Launch + Monetization (Weeks 13–16)

Sprint 7 (Week 13–14):
- [ ] Landing page (Next.js, Vercel)
- [ ] Waitlist → launch email sequence
- [ ] Stripe integration for Pro tier
- [ ] Usage limits enforcement (free: 5 essays/month, 100 entries)
- [ ] Target: 50 beta testers, fix critical bugs

Sprint 8 (Week 15–16):
- [ ] Public launch: Chrome Web Store live
- [ ] Show HN post
- [ ] Product Hunt launch (coordinate)
- [ ] Reddit posts (r/productivity, r/cscareerquestions)
- [ ] Target: 500 installs in first week

### Post-Launch Sprints (Ongoing)

- Edge/Brave port (trivial — same Manifest V3)
- LLM field classifier (Step 6, Haiku batch)
- Company research for essays (Pro feature)
- Essay history + reuse
- Dashboard (full web app for profile management)
- Firefox port
- B2B tier (career centers, bootcamps)

---

## 20. Recommended Final Architecture

### 20.1 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER'S BROWSER                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  CHROME EXTENSION (Manifest V3)                           │   │
│  │                                                           │   │
│  │  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │   │
│  │  │  Popup    │  │ Content Script│  │ Background SW     │  │   │
│  │  │  (React)  │  │ (per page)   │  │ (singleton)       │  │   │
│  │  │           │  │              │  │                    │  │   │
│  │  │  Auth     │  │  Detector    │  │  Auth Manager      │  │   │
│  │  │  Profile  │  │  Matcher     │  │  Sync Engine       │  │   │
│  │  │  Settings │  │  Filler      │  │  AI Client         │  │   │
│  │  │  Resume   │  │  Learner     │  │  Embedder (MiniLM) │  │   │
│  │  │           │  │  Overlay UI  │  │  Profile Store     │  │   │
│  │  └──────────┘  └──────────────┘  └───────────────────┘  │   │
│  │                                                           │   │
│  │  ┌──────────────────────────────────────────────────────┐│   │
│  │  │  LOCAL STORAGE                                        ││   │
│  │  │  chrome.storage.local: profile, settings, session     ││   │
│  │  │  IndexedDB: embeddings, field_cache, MiniLM model     ││   │
│  │  └──────────────────────────────────────────────────────┘│   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              │ HTTPS (only for: auth, sync,     │
│                              │ resume upload, AI generation)     │
└──────────────────────────────┼───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                         SUPABASE                                  │
│                                                                   │
│  Auth ─────── Google OAuth + Email/Password                      │
│  Postgres ─── profile_entries, resumes (refs), activity_log      │
│               (NO pgvector needed — embeddings are local)        │
│  Storage ──── Resume PDFs (signed URLs, per-user folders)        │
│  Edge Fns ─── /parse-resume, /generate-essay, /sync-profile,    │
│               /classify-fields, /suggest-key, /research-company  │
└──────────────────────────────────────────────────────────────────┘
                               │
                               │ (Edge Functions call externally)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│  ANTHROPIC CLAUDE API                                             │
│  Sonnet: resume parsing, essay generation                        │
│  Haiku:  field classification, key suggestion, company research  │
└──────────────────────────────────────────────────────────────────┘
```

### 20.2 Key Architectural Principles

1. **Local-first.** All matching happens in the browser. Cloud is for backup, auth, and AI.

2. **AI as exception, not default.** 95% of fills cost $0. AI fires only when (a) field is truly ambiguous (Haiku, <$0.001), or (b) user clicks "Generate" on an essay (Sonnet, ~$0.05).

3. **Profile is a key-value store, not a fixed schema.** No rigid "name, email, phone" form. The profile holds whatever the user fills over time. This is the learning moat.

4. **Embeddings are local and recomputable.** Cloud stores text; device computes vectors. No pgvector needed. Simplest possible backend.

5. **Privacy is the product.** Form data never leaves the browser. This isn't just a policy — it's the architecture. Steps 1–5 of the waterfall are physically incapable of leaking data.

6. **Cloud sync is opt-in and delta-only.** Batched every 5 minutes. User can turn it off entirely and use the extension as a purely local tool.

### 20.3 Tradeoffs Accepted

| Decision | What we gain | What we lose |
|---|---|---|
| No pgvector | Simpler backend, lower cost | Cloud-side similarity search (we don't need it) |
| MiniLM bundled (22 MB) | Offline matching, privacy | Larger extension download |
| Batched sync (not real-time) | Lower cost, simpler | 5-min staleness on multi-device |
| No auto-submit | Trust, positioning | Can't compete on "speed" with LazyApply |
| No credit cards | Focused scope, safety | Users need a separate password manager |
| Manifest V3 only | Chrome Web Store compliance | V2 features (persistent background) lost |

### 20.4 Naming — Updated Candidates

Since Quill is taken (quill.dev is active, quill.com is $17K):

| Name | Domain ideas | Vibe | Strengths |
|---|---|---|---|
| **Plume** | plume.so, getplume.dev, plume.app | Writing feather, elegant | Short, unique, hints at essay quality |
| **Forge** | forgeautofill.com, useforge.dev | Building, crafting | Strong, memorable, implies creation |
| **Imprint** | imprint.so, getimprint.dev | Identity, mark on forms | Directly metaphorical for profiles |
| **Scribl** | scribl.io, scribl.dev | Writing, casual, fun | Unique spelling, available likely |
| **Forma** | forma.so, useforma.dev | Forms (Latin root) | Directly descriptive, international |
| **Tessera** | tessera.so, tessera.dev | Mosaic tile (identity pieces) | Sophisticated, unique, strong brand |
| **Ditto** | getditto.dev, ditto.so | "Same again" — auto-repeat | Fun, memorable, exactly what the product does |
| **Karta** | karta.so, getkarta.dev | Card/profile (Sanskrit/Nordic) | Short, unique, culturally resonant |

**Top pick: Ditto** — it's literally what the product does ("same information, again"). Short, fun, memorable, and likely available as getditto.dev or useditto.com. Second choice: **Plume** (elegant, writing angle) or **Forma** (descriptive, international).

---

## Appendix A: Database Schema (Supabase)

```sql
-- Auth managed by Supabase

create table profile_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  canonical_key text not null,
  display_label text not null,
  aliases text[] default '{}',
  value text not null,
  category text,
  source text default 'manual',  -- 'manual' | 'learned' | 'resume'
  sensitive boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_used timestamptz,
  use_count int default 0
);

-- RLS: users can only see their own entries
alter table profile_entries enable row level security;
create policy "Users can CRUD own entries"
  on profile_entries for all
  using (auth.uid() = user_id);

create table resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  label text not null,
  storage_path text not null,
  parsed_text text,
  is_default boolean default false,
  created_at timestamptz default now()
);

alter table resumes enable row level security;
create policy "Users can CRUD own resumes"
  on resumes for all
  using (auth.uid() = user_id);

create table activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  event_type text not null,  -- 'autofill' | 'essay_generate' | 'profile_learn' | 'sync'
  domain text,
  field_count int,
  ai_used boolean default false,
  created_at timestamptz default now()
);

alter table activity_log enable row level security;
create policy "Users can read own logs"
  on activity_log for select
  using (auth.uid() = user_id);

create table essay_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  question_text text not null,
  answer_text text not null,
  page_domain text,
  company_hint text,
  created_at timestamptz default now()
);

alter table essay_history enable row level security;
create policy "Users can CRUD own essays"
  on essay_history for all
  using (auth.uid() = user_id);

-- Indexes
create index idx_profile_entries_user on profile_entries(user_id);
create index idx_profile_entries_key on profile_entries(user_id, canonical_key);
create index idx_resumes_user on resumes(user_id);
create index idx_activity_log_user on activity_log(user_id, created_at desc);
create index idx_essay_history_user on essay_history(user_id, created_at desc);
```

## Appendix B: Manifest.json (Chrome)

```json
{
  "manifest_version": 3,
  "name": "Ditto — Universal Autofill",
  "version": "1.0.0",
  "description": "Fill any form on any website. Learns as you go. AI for the hard questions.",
  "permissions": [
    "activeTab",
    "storage",
    "identity",
    "alarms"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content-script.js"],
      "css": ["content-style.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "web_accessible_resources": [
    {
      "resources": ["miniml/*"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

## Appendix C: AI Cost Model (Updated)

| Operation | Model | Input tokens | Output tokens | Cost per call | Frequency |
|---|---|---|---|---|---|
| Resume parse | Sonnet | ~3,000 | ~1,500 | ~$0.02 | Once per resume |
| Essay generation | Sonnet | ~2,000 | ~500 | ~$0.05 | 5–20/month (Pro) |
| Field classification | Haiku | ~500 | ~200 | ~$0.0001 | Rare (2% of pages) |
| Key suggestion | Haiku | ~200 | ~50 | ~$0.0001 | On learn events |
| Company research | Haiku + search | ~1,000 | ~500 | ~$0.005 | Pro only, on demand |

**Monthly cost per user type:**

| User type | Essays/mo | Classifications/mo | Total AI cost |
|---|---|---|---|
| Free (casual) | 2 | 5 | ~$0.10 |
| Free (active) | 5 | 15 | ~$0.25 |
| Pro (normal) | 20 | 30 | ~$1.00 |
| Pro (power) | 50 | 50 | ~$2.50 |

At $9/month Pro, even power users have healthy margins.
