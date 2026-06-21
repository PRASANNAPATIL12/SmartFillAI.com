import type { IAIProvider, AIProviderName } from './types';
import { GroqProvider } from './groq';
import { GeminiProvider } from './gemini';
import { getProviderConfig } from './config';
import { ENV_GROQ_API_KEY, ENV_GEMINI_API_KEY } from './env';

/**
 * AIProviderFactory — single entry-point for all AI calls.
 *
 * Keys are OWNER-provided and bundled at build time from .env.local. End
 * users never enter an API key — there is no key-entry UI. The factory reads
 * the bundled env key for whichever provider the config selects, with a
 * fallback to the other provider if the primary is unreachable.
 */
export class AIProviderFactory {
  private static _instance: IAIProvider | null = null;

  static async getProvider(): Promise<IAIProvider> {
    // Return cached instance without pinging — the ping wastes a quota request
    // on every call. If an actual request fails, the caller's catch handles it.
    if (this._instance) return this._instance;

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
      `No AI provider available — the bundled ${config.provider} key is missing or invalid. ` +
      `Check VITE_GEMINI_API_KEY / VITE_GROQ_API_KEY in .env.local at build time.`
    );
  }

  /** Call after config change to force re-creation. */
  static refresh(): void {
    this._instance = null;
  }

  // ── private ────────────────────────────────────────────────────────────────

  private static async build(name: AIProviderName): Promise<IAIProvider | null> {
    // Keys come ONLY from the build-time env bundle (.env.local). No
    // chrome.storage / user-entered keys — there is no key-entry UI.
    switch (name) {
      case 'groq':
        return ENV_GROQ_API_KEY ? new GroqProvider(ENV_GROQ_API_KEY) : null;
      case 'gemini':
        return ENV_GEMINI_API_KEY ? new GeminiProvider(ENV_GEMINI_API_KEY) : null;
    }
  }
}
