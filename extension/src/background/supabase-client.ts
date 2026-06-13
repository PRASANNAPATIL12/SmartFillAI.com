import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ENV_SUPABASE_URL, ENV_SUPABASE_ANON_KEY } from './supabase-env';
import type { Session } from '@shared/types';

export type DbClient = SupabaseClient;

let _client: DbClient | null = null;

function buildClient(): DbClient {
  if (!ENV_SUPABASE_URL || !ENV_SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local'
    );
  }
  return createClient(ENV_SUPABASE_URL, ENV_SUPABASE_ANON_KEY, {
    auth: {
      // We manage the session ourselves in chrome.storage.local
      storage:             undefined,
      autoRefreshToken:    false,
      persistSession:      false,
      detectSessionInUrl:  false,
    },
  });
}

function rawClient(): DbClient {
  if (!_client) _client = buildClient();
  return _client;
}

/**
 * Returns a Supabase client with the stored session injected.
 * Must be called before any authenticated DB operation.
 */
export async function getAuthClient(session: Session): Promise<DbClient> {
  const client = rawClient();
  await client.auth.setSession({
    access_token:  session.accessToken,
    refresh_token: session.refreshToken,
  });
  return client;
}

export function isSupabaseConfigured(): boolean {
  return !!(ENV_SUPABASE_URL && ENV_SUPABASE_ANON_KEY);
}

export { rawClient as getAnonymousClient };
