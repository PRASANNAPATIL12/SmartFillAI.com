import type { ProviderConfig, AIProviderName } from './types';
import { DEFAULT_PROVIDER_CONFIG } from './types';

const CONFIG_KEY = 'ai_provider_config_v1';
const KEY_PREFIX = 'ai_api_key_';

// ============================================================================
// Provider Config
// ============================================================================

export async function getProviderConfig(): Promise<ProviderConfig> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return (result[CONFIG_KEY] as ProviderConfig | undefined) ?? DEFAULT_PROVIDER_CONFIG;
}

export async function setProviderConfig(patch: Partial<ProviderConfig>): Promise<void> {
  const current = await getProviderConfig();
  await chrome.storage.local.set({ [CONFIG_KEY]: { ...current, ...patch } });
}

// ============================================================================
// API Key Storage (encrypted)
// ============================================================================

export async function getAPIKey(provider: AIProviderName): Promise<string | undefined> {
  const storageKey = KEY_PREFIX + provider;
  const result = await chrome.storage.local.get(storageKey);
  const raw = result[storageKey] as string | undefined;
  if (!raw) return undefined;
  return decryptKey(raw);
}

export async function setAPIKey(provider: AIProviderName, apiKey: string): Promise<void> {
  const storageKey = KEY_PREFIX + provider;
  await chrome.storage.local.set({ [storageKey]: encryptKey(apiKey) });
}

export async function removeAPIKey(provider: AIProviderName): Promise<void> {
  const storageKey = KEY_PREFIX + provider;
  await chrome.storage.local.remove(storageKey);
}

// ============================================================================
// Simple XOR encryption keyed to the extension's own runtime ID.
// Not cryptographically strong — just prevents plaintext keys sitting in storage.
// ============================================================================

function encryptKey(key: string): string {
  const salt = chrome.runtime.id;
  const xored = Array.from(key)
    .map((ch, i) => ch.charCodeAt(0) ^ salt.charCodeAt(i % salt.length))
    .map(n => String.fromCharCode(n))
    .join('');
  return btoa(xored);
}

function decryptKey(encrypted: string): string {
  const salt = chrome.runtime.id;
  return Array.from(atob(encrypted))
    .map((ch, i) => ch.charCodeAt(0) ^ salt.charCodeAt(i % salt.length))
    .map(n => String.fromCharCode(n))
    .join('');
}
