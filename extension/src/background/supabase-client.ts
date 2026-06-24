import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ENV_SUPABASE_URL, ENV_SUPABASE_ANON_KEY } from './supabase-env';
import type { Session } from '@shared/types';

export type DbClient = SupabaseClient;

const AUTH_OPTIONS = {
  // We manage the session ourselves in chrome.storage.local
  storage:            undefined,
  autoRefreshToken:   false,
  persistSession:     false,
  detectSessionInUrl: false,
} as const;

let _anonClient: DbClient | null = null;

function rawClient(): DbClient {
  if (!ENV_SUPABASE_URL || !ENV_SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local'
    );
  }
  if (!_anonClient) {
    _anonClient = createClient(ENV_SUPABASE_URL, ENV_SUPABASE_ANON_KEY, {
      auth: AUTH_OPTIONS,
    });
  }
  return _anonClient;
}

// ── Authenticated client cache ─────────────────────────────────────────────────
//
// Previous approach: called client.auth.setSession() on every sync operation.
// Problem: setSession() internally calls _getUser (a network request to
// /auth/v1/user to validate the token). When Supabase is briefly unreachable
// this floods the SW console with "TypeError: Failed to fetch" on every
// push/pull, even when the underlying operation hasn't been attempted yet.
//
// Fix: inject the Bearer token via global request headers instead. The Supabase
// PostgREST/storage APIs accept Authorization: Bearer <access_token> directly.
// No validation round-trip — the client is ready for DB operations immediately
// and auth errors surface only when an actual query fails.
//
// Cache key is the access token string: a new client is only built when the
// token rotates (typically once per hour on Supabase default settings).

let _authCache: { accessToken: string; client: DbClient } | null = null;

/**
 * Returns a Supabase client authenticated for the given session.
 * Uses a cached client when the access token hasn't changed.
 */
export function getAuthClient(session: Session): DbClient {
  if (_authCache?.accessToken === session.accessToken) {
    return _authCache.client;
  }
  if (!ENV_SUPABASE_URL || !ENV_SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local'
    );
  }
  const client = createClient(ENV_SUPABASE_URL, ENV_SUPABASE_ANON_KEY, {
    auth: AUTH_OPTIONS,
    global: {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
      },
    },
  });
  _authCache = { accessToken: session.accessToken, client };
  return client;
}

export function isSupabaseConfigured(): boolean {
  return !!(ENV_SUPABASE_URL && ENV_SUPABASE_ANON_KEY);
}

export { rawClient as getAnonymousClient };
