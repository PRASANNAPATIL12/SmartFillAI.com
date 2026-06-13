/* eslint-disable @typescript-eslint/no-explicit-any */
const meta = (typeof import.meta !== 'undefined' ? import.meta : {}) as any;
const env  = meta.env ?? {};

export const ENV_SUPABASE_URL:      string = env.VITE_SUPABASE_URL      ?? '';
export const ENV_SUPABASE_ANON_KEY: string = env.VITE_SUPABASE_ANON_KEY ?? '';
