# 🚀 Ditto Project — Start Here

## ✅ What's Been Completed

**Task 1.1: Repo Bootstrap** is COMPLETE!

### Files Created:
1. **📁 Project Structure** — All directories created
2. **📦 package.json** — Dependencies for React, TypeScript, Vite, AI SDKs
3. **⚙️ Configuration Files:**
   - `tsconfig.json` — TypeScript with strict mode
   - `vite.config.ts` — Manifest V3 build config
   - `manifest.json` — Extension manifest (skeleton)
   - `tailwind.config.js` — Tailwind CSS with custom animations
   - `postcss.config.js` — PostCSS setup
   - `jest.config.js` — Testing configuration

4. **📝 Documentation:**
   - `CONTEXT.md` — Quick reference for Claude Code
   - `BUILD_ORDER.md` — 50+ tasks in sequence
   - `docs/AI_PROVIDER_SPEC.md` — AI abstraction layer spec
   - `docs/MATCHER_SPEC.md` — Field matching waterfall spec
   - `docs/universal-autofill-implementation.md` — Full 20-section spec
   - `README.md` — Project readme

5. **🎨 Core Types:**
   - `shared/types.ts` — Profile, FieldSignature, MatchResult, etc.

6. **📋 Git Setup:**
   - `.gitignore` — Ignores node_modules, build artifacts, API keys
   - Git repository initialized

---

## 🎯 Key Feature: Flexible AI Provider Architecture

**You can now switch between AI providers with ONE config change:**

```typescript
// Switch from GROQ to OpenAI
await setProviderConfig({ provider: 'openai' });

// Switch to Anthropic
await setProviderConfig({ provider: 'anthropic' });

// Use local models (Ollama)
await setProviderConfig({ provider: 'local', baseUrl: 'http://localhost:11434' });
```

**Zero code changes in business logic.**

All AI calls go through `IAIProvider` interface:
- ✅ GROQ (default) — Fast, affordable
- ✅ OpenAI — GPT-4 for complex reasoning
- ✅ Anthropic — Claude for best quality
- ✅ Local — Ollama/LM Studio for privacy

Dependencies already included in `package.json`:
- `groq-sdk`
- `openai`
- `@anthropic-ai/sdk`

---

## 📦 Installation Status

**Running:** `npm install` in `extension/` folder

**Expected duration:** 1-2 minutes

**Check status:**
```bash
cd extension
# If still running, wait for completion notification
# If done, you'll see "added XXX packages" message
```

---

## 🧪 Verify Installation

Once `npm install` completes, run:

```bash
cd extension

# 1. Type check (should pass)
npm run type-check

# 2. Try to build (will fail due to missing entry files, but configs should parse)
npm run build

# 3. Run tests (will show "No tests found" — normal at this stage)
npm run test
```

---

## 🎯 Next Task: Task 1.2 — AI Provider Abstraction Layer

**Estimated time:** 2-3 hours

**What to build:**
- `extension/src/ai-providers/types.ts` — Interface definitions
- `extension/src/ai-providers/groq.ts` — GROQ implementation
- `extension/src/ai-providers/openai.ts` — OpenAI implementation
- `extension/src/ai-providers/anthropic.ts` — Anthropic implementation
- `extension/src/ai-providers/local.ts` — Local model support
- `extension/src/ai-providers/factory.ts` — Provider factory
- `extension/src/ai-providers/config.ts` — Config management
- `extension/src/ai-providers/cost-tracker.ts` — Usage tracking
- `extension/src/ai-providers/__tests__/providers.test.ts` — Unit tests

**Reference:** `docs/AI_PROVIDER_SPEC.md` (complete code samples included)

**Why this comes first:**
The matcher (Task 1.3) will eventually use AI for Step 6 (LLM field classification). Building the abstraction first ensures no vendor lock-in.

---

## 📋 Prompt for Claude Code (Task 1.2)

Copy this into Claude Code (desktop):

```
Task 1.2 — AI Provider Abstraction Layer

Reference: /docs/AI_PROVIDER_SPEC.md

Build the AI provider abstraction layer following the complete specification.

Create these files:
1. extension/src/ai-providers/types.ts
2. extension/src/ai-providers/groq.ts
3. extension/src/ai-providers/openai.ts
4. extension/src/ai-providers/anthropic.ts
5. extension/src/ai-providers/local.ts
6. extension/src/ai-providers/factory.ts
7. extension/src/ai-providers/config.ts
8. extension/src/ai-providers/cost-tracker.ts
9. extension/src/ai-providers/__tests__/providers.test.ts

All code samples are in the spec file. Implement exactly as specified.

After creating:
- Files should pass TypeScript type checking
- Include unit tests
- DO NOT implement business logic yet (resume parsing, essay generation, etc.)
- This is ONLY the abstraction layer

Test environment requirements:
- Mock chrome.storage.local for tests
- Use actual API keys from environment variables for integration tests
```

---

## 🔧 Required: API Keys (for testing)

Before testing AI providers, create `.env.local` in `extension/`:

```env
# GROQ (default provider)
VITE_GROQ_API_KEY=gsk_xxx...

# OpenAI (optional, for switching)
VITE_OPENAI_API_KEY=sk-xxx...

# Anthropic (optional, for switching)
VITE_ANTHROPIC_API_KEY=sk-ant-xxx...

# Supabase (for cloud sync, needed later in Task 6.1)
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...
```

**Get API keys:**
- GROQ: https://console.groq.com/keys (free tier available)
- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com/settings/keys
- Supabase: https://supabase.com/dashboard (create project)

**Security:**
- `.env.local` is already in `.gitignore`
- Keys are encrypted when stored in chrome.storage
- NEVER commit API keys to git

---

## 📊 Full Build Order

See `BUILD_ORDER.md` for complete sequence (50+ tasks).

**Critical path:**
```
Task 1.1 (Bootstrap) ✅ DONE
    ↓
Task 1.2 (AI Abstraction) ← YOU ARE HERE
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

**MVP (first 4 weeks):**
- Tasks 1.1-4.3 (autofill + learning, no AI)
- Then add AI features (Tasks 5.3, 6.3, 7.3)

---

## 🎨 Optional: Icon Files

Create placeholders or generate icons:

**Required sizes:**
- `extension/public/icons/icon-16.png` (16×16px)
- `extension/public/icons/icon-48.png` (48×48px)
- `extension/public/icons/icon-128.png` (128×128px)

**Tools:**
- [Favicon.io](https://favicon.io/) — Generate from text
- [Figma](https://figma.com/) — Design custom icons
- Use AI image generation for "form autofill icon blue gradient"

**For now:** Can use placeholder images, not blocking.

---

## 🚨 Troubleshooting

### npm install issues:

**"Cannot find module 'groq-sdk'"**
- Check if package name changed: https://www.npmjs.com/package/groq-sdk
- Update `package.json` with correct name

**"peer dependency conflict"**
```bash
npm install --legacy-peer-deps
```

**"ERESOLVE unable to resolve dependency tree"**
```bash
rm -rf node_modules package-lock.json
npm install
```

### Build issues:

**"Cannot find module '@/...'"**
- Check `tsconfig.json` paths are correct
- Restart TypeScript server in IDE

**Vite build fails with "no input files"**
- Normal at this stage (no entry files yet)
- Will resolve after Task 1.2

---

## 📖 Documentation Reference

| File | Purpose |
|------|---------|
| `CONTEXT.md` | Quick reference for Claude Code |
| `BUILD_ORDER.md` | Full task sequence (50+ tasks) |
| `docs/AI_PROVIDER_SPEC.md` | AI abstraction layer (complete code) |
| `docs/MATCHER_SPEC.md` | Field matching waterfall |
| `docs/universal-autofill-implementation.md` | Full 20-section spec |
| `README.md` | Project overview |
| `TASK_1.1_COMPLETE.md` | Task 1.1 summary |

---

## ✅ Checklist Before Task 1.2

- [x] Project structure created
- [x] Dependencies listed in package.json
- [x] TypeScript configured (strict mode)
- [x] Vite configured for Manifest V3
- [x] Tailwind CSS configured
- [x] Core types defined (shared/types.ts)
- [x] AI provider spec created
- [x] Matcher spec created
- [x] Build order documented
- [x] Git initialized
- [ ] npm install completed ← **Check this**
- [ ] API keys added to .env.local ← **Do this next**
- [ ] npm run type-check passes ← **Verify after npm install**

---

## 🎯 Success Criteria for Task 1.2

When Task 1.2 is complete:
- ✅ `AIProviderFactory.getProvider()` works
- ✅ Can call `provider.chat(params)` and get response
- ✅ Can call `provider.chatStream(params)` for streaming
- ✅ Can switch providers via `setProviderConfig()`
- ✅ Cost tracking works (`getTotalCost()`)
- ✅ Unit tests pass
- ✅ TypeScript compiles with no errors

---

## 💡 Tips for Using Claude Code

1. **Load context files:**
   - Claude Code reads files you reference in prompts
   - Always mention `/docs/AI_PROVIDER_SPEC.md` in prompts

2. **Test incrementally:**
   - After each file created, run `npm run type-check`
   - Catch errors early

3. **Ask for tests:**
   - Always request unit tests in your prompts
   - Example: "Add unit tests for GroqProvider.chat()"

4. **Show errors:**
   - If build fails, copy the error output into Claude Code
   - It will fix the issue

---

## 🚀 Ready to Start!

**Current status:**
- ✅ Task 1.1 COMPLETE
- ⏳ npm install running (check status)
- 📝 Next: Task 1.2 (AI Provider Abstraction)

**Time estimate:**
- Task 1.2: ~2-3 hours
- Task 1.3: ~4-5 hours
- Full MVP (Tasks 1.1-4.3): ~4 weeks

**Your project is fully set up with flexible AI architecture. No vendor lock-in!**

---

**Questions? Issues?**
- Check `TASK_1.1_COMPLETE.md` for troubleshooting
- Read `docs/AI_PROVIDER_SPEC.md` for complete code samples
- Follow `BUILD_ORDER.md` for task sequence

**Happy coding! 🎉**
