/**
 * Thin wrapper so factory.ts never touches import.meta directly.
 * Jest replaces this entire file via moduleNameMapper → env.mock.ts
 *
 * IMPORTANT: Use the literal `import.meta.env.VITE_*` pattern so Vite's
 * define plugin can statically replace these with the actual key values
 * at build time. Accessing through a variable (meta.env.VITE_*) defeats
 * the static replacement and leaves keys empty at runtime.
 */

export const ENV_GROQ_API_KEY: string = import.meta.env.VITE_GROQ_API_KEY ?? '';
export const ENV_GEMINI_API_KEY: string = import.meta.env.VITE_GEMINI_API_KEY ?? '';
