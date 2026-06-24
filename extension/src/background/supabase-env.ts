// IMPORTANT: Use the literal `import.meta.env.VITE_*` pattern so Vite's
// define plugin can statically replace these with the actual key values at
// build time. Dynamic access (e.g. meta.env[key]) prevents static replacement.

export const ENV_SUPABASE_URL:      string = import.meta.env.VITE_SUPABASE_URL      ?? '';
export const ENV_SUPABASE_ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
