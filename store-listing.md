# Chrome Web Store Listing — SmartFillAI

## Extension Name
SmartFillAI — Universal Autofill

## Short Description (max 132 chars)
Fill any job application form in one click. Learns as you go. AI generates cover letters and essays automatically.

## Detailed Description (max 16,000 chars)

**SmartFillAI fills any web form — automatically.**

Stop retyping your name, email, work history and skills on every job application. SmartFillAI learns your profile once, then fills any form on any website: Greenhouse, Workday, Lever, Ashby, Happiest Minds, eBay, and thousands more.

---

### How it works

1. **Add your profile once** — paste in your resume or type your details. SmartFillAI extracts name, contact info, work history, education, skills, and more.

2. **Visit any form** — SmartFillAI detects fillable fields automatically and shows you how many it can fill.

3. **Click "Fill This Page"** — fields fill instantly. The extension handles text inputs, dropdowns, radio buttons, checkboxes, date pickers, and even custom ARIA widgets used by modern frameworks (Angular Material, MUI, Workday).

4. **AI handles the hard questions** — SmartFillAI uses AI to generate tailored cover letters and essay answers based on the company and your background. Each answer is unique per application.

5. **It learns as you go** — fill a field manually and SmartFillAI remembers the answer. Next time it sees a similar question, it fills it automatically.

---

### Key Features

**Universal form support**
- Native HTML5 inputs, selects, textareas
- Custom ARIA widgets (combobox, listbox, radiogroup, contenteditable)
- File upload fields — attaches your resume automatically
- Date pickers in multiple formats
- Phone + country code fields
- Drag-and-drop document zones

**Smart matching — 6-step waterfall**
- Rule-based matching (100ms, no API calls)
- Semantic embedding similarity via local MiniLM model
- AI classification fallback for ambiguous fields (label text only, never your values)

**AI-powered essay generation**
- Cover letters, "why us" essays, competency questions
- Company-aware: detects the company and adapts the answer
- Remembers your past answers and improves them on each use
- Powered by GROQ and Google Gemini (fast, high-quality)

**Resume import**
- Upload a PDF or paste text — SmartFillAI extracts structured profile data
- Automatically generates Q&A pairs from your resume for common application questions

**Privacy-first**
- All profile data stored locally on your device
- Cloud sync is optional and end-to-end encrypted
- AI features only send field labels to external providers — never your values
- Blocks sensitive domains (banking, healthcare) by default

**Works offline**
- Autofill works without internet
- Sync resumes when you reconnect

---

### Privacy

Your data stays on your device. SmartFillAI does not sell data, does not track your browsing, and does not have advertising. Full privacy policy at smartfillai.com/privacy.

---

### Requirements

- Chrome 105+ (or Brave, Edge, Arc)
- An internet connection is required for AI features and optional cloud sync; autofill works offline

---

## Category
Productivity

## Tags / Keywords
autofill, job application, form filler, resume, cover letter, AI, productivity, Greenhouse, Workday, Lever

## Store URL
https://chromewebstore.google.com/detail/smartfillai/[TBD after submission]

---

## Screenshot Guide (5 required, 1280×800 or 640×400)

1. **HomeScreen** — popup open on a job application page showing "12 fields detected · 8 from profile" and the Fill button
2. **Fill in progress** — the form partially filled with values, ghost text visible in remaining fields
3. **Essay generation** — the essay panel open in a textarea showing a generated cover letter
4. **Profile screen** — the profile screen with multiple categories expanded (Contact, Work, Education)
5. **Settings screen** — settings toggles and data export/wipe options

## Promotional image (440×280)
Logo centered on gradient background (blue→purple), tagline: "Your profile. Every form. One click."

---

## Permissions Justification (for reviewer)

| Permission | Reason |
|---|---|
| `activeTab` | Read form fields on the current active tab |
| `scripting` | Programmatically inject content script when not pre-loaded |
| `storage` | Store profile data locally via chrome.storage.local |
| `unlimitedStorage` | IndexedDB for embeddings (can reach 20-50 MB) and documents |
| `alarms` | 5-minute periodic sync alarm + service worker keepalive |
| `<all_urls>` (host) | Detect and fill forms on any website the user visits |

No permissions are used to collect browsing data or monitor user behaviour.
