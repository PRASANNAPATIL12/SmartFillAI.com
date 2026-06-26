// Jest mock — swapped in via moduleNameMapper in jest.config.js so unit
// tests don't have to wrestle with Vite's `import.meta.env`.
export const ENV_SUPABASE_URL:      string = 'http://localhost:54321';
export const ENV_SUPABASE_ANON_KEY: string = 'test-anon-key';
