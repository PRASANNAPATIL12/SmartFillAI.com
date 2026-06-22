import type { UserSettings } from '@shared/types';
import { STORAGE_KEYS } from '@shared/types';

export const DEFAULT_SETTINGS: UserSettings = {
  autoSave: true,
  cloudSync: true,
  syncFrequency: '5min',
  showGhostText: true,
  blockSensitiveDomains: true,
  domainOverrides: {},
  aiProvider: {
    provider: 'groq',
  },
};

export async function getSettings(): Promise<UserSettings> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const stored = r[STORAGE_KEYS.SETTINGS] as Partial<UserSettings> | undefined;
  if (!stored) return { ...DEFAULT_SETTINGS, domainOverrides: {} };

  // Deep merge so newly added settings fields get defaults
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    aiProvider: {
      ...DEFAULT_SETTINGS.aiProvider,
      ...(stored.aiProvider ?? {}),
    },
    domainOverrides: stored.domainOverrides ?? {},
  };
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await getSettings();
  const updated: UserSettings = {
    ...current,
    ...patch,
    // Nested objects need explicit spread to avoid full replacement
    aiProvider: patch.aiProvider
      ? { ...current.aiProvider, ...patch.aiProvider }
      : current.aiProvider,
    domainOverrides: patch.domainOverrides !== undefined
      ? patch.domainOverrides
      : current.domainOverrides,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
  return updated;
}
