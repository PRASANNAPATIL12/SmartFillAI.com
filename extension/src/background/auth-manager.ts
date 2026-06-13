import type { Session } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';

// Supabase auth integration comes in Task 6.1.
// This module owns all session reads/writes in chrome.storage.

export async function getSession(): Promise<Session | null> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  const session = r[STORAGE_KEYS.SESSION] as Session | undefined;
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    await clearSession();
    return null;
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

// Called by the sync engine (Task 6.2) after a successful token refresh.
export async function extendSession(newAccessToken: string, newExpiresAt: number): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await setSession({ ...session, accessToken: newAccessToken, expiresAt: newExpiresAt });
}
