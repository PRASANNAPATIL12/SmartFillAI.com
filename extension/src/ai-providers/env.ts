/**
 * Thin wrapper so factory.ts never touches import.meta directly.
 * Jest replaces this entire file via moduleNameMapper → env.mock.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const meta = (typeof import.meta !== 'undefined' ? import.meta : {}) as any;
const env = meta.env ?? {};

export const ENV_GROQ_API_KEY: string = env.VITE_GROQ_API_KEY ?? '';
export const ENV_GEMINI_API_KEY: string = env.VITE_GEMINI_API_KEY ?? '';
