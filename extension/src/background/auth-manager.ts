import type { Session } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';
import { getAnonymousClient, getAuthClient, isSupabaseConfigured } from './supabase-client';

// ── Session storage (chrome.storage.local) ────────────────────────────────────

export async function getSession(): Promise<Session | null> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  const session = r[STORAGE_KEYS.SESSION] as Session | undefined;
  if (!session) return null;

  // Grace period: 60 s before expiry, try a token refresh
  if (session.expiresAt - Date.now() < 60_000) {
    try {
      const refreshed = await refreshSession(session.refreshToken);
      return refreshed;
    } catch {
      await clearSession();
      return null;
    }
  }

  return session;
}

export async function setSession(session: Session): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.SESSION);
}

export async function isLoggedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}

export async function getCurrentUserId(): Promise<string | null> {
  return (await getSession())?.userId ?? null;
}

export async function extendSession(newAccessToken: string, newExpiresAt: number): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await setSession({ ...session, accessToken: newAccessToken, expiresAt: newExpiresAt });
}

// ── Supabase auth actions ─────────────────────────────────────────────────────

export async function signIn(email: string, password: string): Promise<Session> {
  if (!isSupabaseConfigured()) {
    throw new Error('Cloud sync not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }

  const client = getAnonymousClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error || !data.session || !data.user) {
    throw new Error(error?.message ?? 'Sign-in failed');
  }

  const session: Session = {
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId:       data.user.id,
    email:        data.user.email ?? email,
    expiresAt:    (data.session.expires_at ?? 0) * 1000, // Supabase returns seconds
  };

  await setSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  const session = await getSession();
  if (session) {
    try {
      const client = await getAuthClient(session);
      await client.auth.signOut();
    } catch {
      // Best-effort — clear local state regardless
    }
  }
  await clearSession();
}

async function refreshSession(refreshToken: string): Promise<Session> {
  const client = getAnonymousClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });

  if (error || !data.session || !data.user) {
    throw new Error(error?.message ?? 'Token refresh failed');
  }

  const session: Session = {
    accessToken:  data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId:       data.user.id,
    email:        data.user.email ?? '',
    expiresAt:    (data.session.expires_at ?? 0) * 1000,
  };

  await setSession(session);
  return session;
}

/** Called on each 5-min alarm to proactively refresh expiring tokens. */
export async function refreshSessionIfNeeded(): Promise<void> {
  const session = await getSession(); // handles refresh internally
  if (!session) return; // already expired or refresh failed — nothing to do
}
