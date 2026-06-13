# Project Context for Claude Code

## Product
Universal Autofill Chrome Extension called "Ditto"

## Key Files to Reference
- `/docs/universal-autofill-implementation.md` ← The full spec (20 sections)
- `/docs/AI_PROVIDER_SPEC.md` ← AI provider abstraction layer
- `/docs/MATCHER_SPEC.md` ← Waterfall rules for field detection
- `/BUILD_ORDER.md` ← Task sequence and dependencies

## Tech Stack
- **Frontend**: React 18 + TypeScript + Tailwind CSS + Vite
- **Extension**: Manifest V3 + Service Worker
- **Storage**: chrome.storage.local + IndexedDB
- **AI Providers** (FLEXIBLE):
  - Primary: GROQ API (fast, affordable)
  - Fallback: OpenAI, Anthropic, local models, or any other provider
  - Embeddings: Local MiniLM via @xenova/transformers (privacy-first)
- **Backend**: Supabase (auth, database, storage, edge functions)

## AI Provider Architecture (CRITICAL)
**We use a provider-agnostic abstraction layer.**

All AI calls go through `IAIProvider` interface:
```typescript
interface IAIProvider {
  name: string;
  chat(params): Promise<ChatResponse>;
  chatStream(params): AsyncIterator<ChatChunk>;
  embed(text): Promise<number[]>; // Optional, falls back to local
}
```

Current implementations:
- `GroqProvider` (default)
- `OpenAIProvider` (ready to swap)
- `AnthropicProvider` (ready to swap)
- `LocalProvider` (Ollama/LM Studio)

Switching providers = change ONE config line. Zero code changes.

## Key Constraints
1. **Form data NEVER leaves the browser** in steps 1-5 of waterfall
2. **Embeddings computed locally** using MiniLM (privacy + offline support)
3. **All matching must complete in <100ms**
4. **Extension must work offline** (except essay generation)
5. **AI provider can be changed via config** without touching business logic

## Build Order (see BUILD_ORDER.md)
1. Repo bootstrap + dependencies
2. **AI Provider abstraction layer** (interface + GROQ implementation)
3. Matcher in isolation (deterministic rules only, unit tests)
4. Extension shell (manifest + popup + content script)
5. Storage layer (chrome.storage + IndexedDB)
6. Profile sync to Supabase
7. AI integration (resume parsing, essay generation)
...and so on

## Important
- After creating a file, test it locally BEFORE moving to next module
- Keep git commits after each successful module
- Add unit tests to every component
- Never hardcode AI provider details in business logic
- All AI calls must go through the abstraction layer

## Privacy First
- Embeddings = local only (MiniLM runs in browser)
- Form data = never sent to cloud (only when user clicks "Generate")
- AI provider choice = user's preference, stored locally
- API keys = encrypted in chrome.storage, never in code
