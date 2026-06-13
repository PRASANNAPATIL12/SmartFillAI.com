import type { IAIProvider, AIProviderName } from './types';
import { GroqProvider } from './groq';
import { GeminiProvider } from './gemini';
import { getProviderConfig, getAPIKey } from './config';
import { ENV_GROQ_API_KEY, ENV_GEMINI_API_KEY } from './env';

/**
 * AIProviderFactory — single entry-point for all AI calls.
 *
 * Provider priority:
 *   1. API key stored in chrome.storage (user-entered via settings UI)
 *   2. Env var baked in at build time (.env.local, dev-only convenience)
 *   3. Fallback provider (if primary is unavailable)
 */
export class AIProviderFactory {
  private static _instance: IAIProvider | null = null;

  static async getProvider(): Promise<IAIProvider> {
    if (this._instance) {
      const alive = await this._instance.isAvailable().catch(() => false);
      if (alive) return this._instance;
      // Primary down — fall through to rebuild with fallback
    }

    const config = await getProviderConfig();

    // Try primary
    let instance = await this.build(config.provider);
    if (instance && await instance.isAvailable().catch(() => false)) {
      this._instance = instance;
      return this._instance;
    }

    // Try fallback
    if (config.fallbackProvider && config.fallbackProvider !== config.provider) {
      instance = await this.build(config.fallbackProvider);
      if (instance && await instance.isAvailable().catch(() => false)) {
        this._instance = instance;
        return this._instance;
      }
    }

    throw new Error(
      `No AI provider available. ` +
      `Set your API key in the extension settings (${config.provider} / ${config.fallbackProvider ?? 'no fallback'}).`
    );
  }

  /** Call after settings change to force re-creation. */
  static refresh(): void {
    this._instance = null;
  }

  // ── private ────────────────────────────────────────────────────────────────

  private static async build(name: AIProviderName): Promise<IAIProvider | null> {
    // chrome.storage key takes precedence; env var is dev-only convenience
    const storedKey = await getAPIKey(name).catch(() => undefined);

    switch (name) {
      case 'groq': {
        const key = storedKey ?? ENV_GROQ_API_KEY;
        return key ? new GroqProvider(key) : null;
      }
      case 'gemini': {
        const key = storedKey ?? ENV_GEMINI_API_KEY;
        return key ? new GeminiProvider(key) : null;
      }
    }
  }
}
