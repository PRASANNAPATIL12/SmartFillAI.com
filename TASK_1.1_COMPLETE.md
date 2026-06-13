# Task 1.1: Repo Bootstrap — COMPLETE ✅

## What Was Created

### 1. Project Structure
```
ditto/
├── docs/
│   ├── universal-autofill-implementation.md  ✅ (moved from root)
│   ├── AI_PROVIDER_SPEC.md                  ✅ (created)
│   ├── MATCHER_SPEC.md                      ✅ (created)
│   └── (more specs to be created per task)
├── extension/
│   ├── src/
│   │   ├── ai-providers/      📁 (ready for Task 1.2)
│   │   ├── background/         📁 (ready for Task 2.1)
│   │   ├── content-script/     📁 (ready for Task 2.2)
│   │   ├── popup/              📁 (ready for Task 2.3)
│   │   └── types/              📁 (ready for types)
│   ├── public/
│   │   ├── icons/              📁 (needs icon files)
│   │   └── fonts/              📁 (optional)
│   ├── package.json            ✅
│   ├── tsconfig.json           ✅
│   ├── tsconfig.node.json      ✅
│   ├── vite.config.ts          ✅
│   ├── manifest.json           ✅
│   ├── tailwind.config.js      ✅
│   ├── postcss.config.js       ✅
│   └── jest.config.js          ✅
├── shared/
│   └── types.ts                ✅ (core types defined)
├── supabase/
│   ├── migrations/             📁 (ready for Task 6.1)
│   └── functions/              📁 (ready for Task 6.1)
├── tests/                      📁 (E2E tests later)
├── .gitignore                  ✅
├── BUILD_ORDER.md              ✅
├── CONTEXT.md                  ✅
└── README.md                   ✅
```

---

## 🎯 Key Updates from Original Plan

### AI Provider Flexibility (NEW)
The architecture now includes:

1. **Abstraction Layer** (`docs/AI_PROVIDER_SPEC.md`)
   - `IAIProvider` interface
   - GROQ implementation (default)
   - OpenAI implementation
   - Anthropic implementation
   - Local model support (Ollama)
   - Provider factory
   - Config management
   - Cost tracking

2. **Zero Vendor Lock-In**
   - Switch providers via ONE config change
   - No code changes needed in business logic
   - All AI calls go through abstraction

3. **Updated Dependencies** (package.json)
   - `groq-sdk` — GROQ API client
   - `openai` — OpenAI API client
   - `@anthropic-ai/sdk` — Anthropic API client
   - All three included, use whichever you want

---

## 📋 Next Steps

### Immediate: Install Dependencies

```bash
cd extension
npm install
```

**Expected output:**
```
added 247 packages, and audited 248 packages in 45s

123 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

If errors occur, they'll likely be version conflicts. Let me know and I'll fix them.

---

### Next Task: Task 1.2 — AI Provider Abstraction Layer

**Location:** `extension/src/ai-providers/`

**Files to create:**
1. `types.ts` — Interface definitions (`IAIProvider`, etc.)
2. `groq.ts` — GROQ implementation
3. `openai.ts` — OpenAI implementation
4. `anthropic.ts` — Anthropic implementation
5. `local.ts` — Local model support
6. `factory.ts` — Provider factory
7. `config.ts` — Config management
8. `cost-tracker.ts` — Usage tracking
9. `__tests__/providers.test.ts` — Unit tests

**Reference:** `docs/AI_PROVIDER_SPEC.md` (already created)

**Why this comes before the matcher:**
The matcher (Task 1.3) will eventually use the AI provider for Step 6 (LLM field classification). Building the abstraction first ensures we never hardcode provider details.

---

### Task 1.2 Prompt for Claude Code

Copy this into Claude Code (desktop):

```
Task 1.2 — AI Provider Abstraction Layer

Reference: /docs/AI_PROVIDER_SPEC.md

Build the AI provider abstraction layer:

1. Create extension/src/ai-providers/types.ts
   - Export IAIProvider interface
   - Export ChatParams, ChatResponse, ChatChunk types
   - Export EmbedResponse, ProviderConfig types
   - Export AIProviderName type

2. Create extension/src/ai-providers/groq.ts
   - Implement GroqProvider class
   - Implements IAIProvider
   - Support chat() and chatStream()
   - Calculate costs based on GROQ pricing

3. Create extension/src/ai-providers/openai.ts
   - Implement OpenAIProvider class
   - Support chat() and chatStream()
   - Calculate costs based on OpenAI pricing

4. Create extension/src/ai-providers/anthropic.ts
   - Implement AnthropicProvider class
   - Support chat() and chatStream()
   - Calculate costs based on Anthropic pricing

5. Create extension/src/ai-providers/local.ts
   - Implement LocalProvider class (Ollama support)
   - Support chat() and chatStream()
   - Cost = $0 (local)

6. Create extension/src/ai-providers/factory.ts
   - Export AIProviderFactory class
   - getProvider() method (singleton)
   - createProvider() method (private)
   - refresh() method

7. Create extension/src/ai-providers/config.ts
   - getProviderConfig(), setProviderConfig()
   - getAPIKey(), setAPIKey() (with encryption)
   - encryptKey(), decryptKey() helpers

8. Create extension/src/ai-providers/cost-tracker.ts
   - logCost(), getTotalCost(), getCostByProvider()

9. Create extension/src/ai-providers/__tests__/providers.test.ts
   - Test GroqProvider.chat()
   - Test GroqProvider.chatStream()
   - Test AIProviderFactory.getProvider()
   - Mock chrome.storage.local

Reference: The complete code is in /docs/AI_PROVIDER_SPEC.md

After creating:
- All files should pass TypeScript type checking
- Add unit tests
- DO NOT implement resume parsing, essay generation, or field classification yet
- This is just the abstraction layer

Dependencies:
- groq-sdk (already in package.json)
- openai (already in package.json)
- @anthropic-ai/sdk (already in package.json)
```

---

## 🧪 Verification Steps After npm install

Run these commands to verify everything works:

```bash
# 1. Type check
npm run type-check
# Expected: "tsc: No errors"

# 2. Build (won't work yet, but should parse configs)
npm run build
# Expected: Error about missing entry files (normal at this stage)

# 3. Test (will fail until we add tests, but should parse config)
npm run test
# Expected: "No tests found" (normal)
```

---

## 📝 Git Commit

Once `npm install` succeeds:

```bash
git init
git add .
git commit -m "Task 1.1: Repo bootstrap with AI provider abstraction

- Setup TypeScript, Vite, React, Tailwind
- Configure Manifest V3 for Chrome extension
- Create core type definitions
- Add AI provider SDKs (GROQ, OpenAI, Anthropic)
- Create project structure
- Add documentation (AI_PROVIDER_SPEC.md, MATCHER_SPEC.md, BUILD_ORDER.md)
- Flexible AI provider architecture (no vendor lock-in)"
```

---

## 🎨 Icon Files Needed

Create placeholder icons or use tools like [Favicon.io](https://favicon.io/) to generate:

**Required:**
- `extension/public/icons/icon-16.png` (16×16px)
- `extension/public/icons/icon-48.png` (48×48px)
- `extension/public/icons/icon-128.png` (128×128px)

**Design:** Simple "D" letter or form icon with blue gradient.

For now, you can use placeholder images or create them later before publishing.

---

## 📊 Progress Tracker

✅ Task 1.1: Repo Bootstrap (COMPLETE)  
⏳ Task 1.2: AI Provider Abstraction Layer (NEXT)  
⬜ Task 1.3: Field Matcher (deterministic)  
⬜ Task 2.1: Service Worker  
⬜ Task 2.2: Content Script  
...and 50+ more tasks in BUILD_ORDER.md

---

## 🚨 Troubleshooting

### If `npm install` fails:

**Error: "Cannot find module 'groq-sdk'"**
- Solution: The package name might have changed. Check [GROQ docs](https://console.groq.com/docs/quickstart) for latest SDK name.

**Error: "peer dependency conflict"**
- Solution: Run `npm install --legacy-peer-deps`

**Error: "ERESOLVE unable to resolve dependency tree"**
- Solution: Delete `package-lock.json` and `node_modules/`, then `npm install` again.

### If TypeScript errors appear:

Check `tsconfig.json` paths are correct:
```json
"paths": {
  "@/*": ["src/*"],
  "@shared/*": ["../shared/*"]
}
```

---

## 💡 Development Tips

1. **Load extension in Chrome:**
   - `chrome://extensions/` → Enable Developer Mode → Load Unpacked → Select `extension/dist/`

2. **Hot reload:**
   - Run `npm run dev` for auto-rebuild on file changes
   - Reload extension manually in `chrome://extensions/`

3. **Debugging:**
   - Background script: `chrome://extensions/` → Inspect service worker
   - Content script: Right-click page → Inspect → Console
   - Popup: Right-click extension icon → Inspect popup

4. **Test in real forms:**
   - Greenhouse: `https://boards.greenhouse.io/embed/job_app?for=example`
   - LinkedIn: Profile edit page
   - Generic: `https://www.w3schools.com/html/html_forms.asp`

---

## ✅ Task 1.1 Complete!

You now have:
- ✅ Full project structure
- ✅ All configuration files (TypeScript, Vite, Tailwind)
- ✅ Core type definitions
- ✅ AI provider abstraction spec
- ✅ Field matcher spec
- ✅ Build order with 50+ tasks
- ✅ Comprehensive documentation

**Next:** Run `npm install`, then move to Task 1.2 (AI Provider Abstraction Layer).

---

**Time to complete Task 1.1:** ~30 minutes  
**Time to complete Task 1.2:** ~2-3 hours (with tests)  
**Time to complete Task 1.3:** ~4-5 hours (matcher + tests)

**MVP (Tasks 1.1-4.3):** ~4 weeks solo, full-time
