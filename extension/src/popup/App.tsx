import React, { useEffect, useState } from 'react';
import { getProviderConfig, setAPIKey, setProviderConfig } from '@/ai-providers';
import type { AIProviderName } from '@/ai-providers';

/**
 * Popup App — skeleton for Task 2.3.
 * Currently shows: AI provider status + API key setup.
 * Full profile editor, sync status, and settings added in Task 2.3.
 */

type Screen = 'loading' | 'setup' | 'home';

export default function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>('loading');
  const [provider, setProvider] = useState<AIProviderName>('groq');
  const [apiKey, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getProviderConfig().then(cfg => {
      setProvider(cfg.provider);
      setScreen('home');
    });
  }, []);

  async function handleSaveKey(): Promise<void> {
    if (!apiKey.trim()) {
      setError('API key cannot be empty.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await setAPIKey(provider, apiKey.trim());
      await setProviderConfig({ provider });
      setScreen('home');
    } catch (e) {
      setError('Failed to save key. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (screen === 'loading') {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (screen === 'setup') {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-xl">✨</span>
          <h1 className="text-base font-semibold text-slate-800">Setup Ditto</h1>
        </div>
        <p className="text-sm text-slate-600">
          Choose your AI provider and add your API key to get started.
        </p>

        {/* Provider selector */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-700">AI Provider</label>
          <select
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400"
            value={provider}
            onChange={e => setProvider(e.target.value as AIProviderName)}
          >
            <option value="groq">GROQ (fast, affordable)</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </div>

        {/* API key input */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-700">
            {provider === 'groq' ? 'GROQ' : 'Gemini'} API Key
          </label>
          <input
            type="password"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400"
            placeholder={provider === 'groq' ? 'gsk_...' : 'AIza...'}
            value={apiKey}
            onChange={e => setApiKeyInput(e.target.value)}
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <button
          onClick={handleSaveKey}
          disabled={saving}
          className="w-full py-2 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-50 rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>

        <p className="text-xs text-slate-400 text-center">
          Keys are encrypted and stored locally. Never shared.
        </p>
      </div>
    );
  }

  // Home screen (placeholder — full UI in Task 2.3)
  return (
    <div className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">✨</span>
          <h1 className="text-base font-semibold text-slate-800">Ditto</h1>
        </div>
        <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
          {provider === 'groq' ? 'GROQ' : 'Gemini'} ●
        </span>
      </div>

      <hr className="border-slate-100" />

      {/* Status */}
      <div className="text-sm text-slate-600 bg-slate-50 rounded-lg p-3">
        <p className="font-medium text-slate-800">Extension Active</p>
        <p className="text-xs mt-0.5">
          Visit any page with a form — Ditto will detect and fill fields automatically.
        </p>
      </div>

      {/* Quick actions — filled out in Task 2.3 */}
      <button className="w-full py-2 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 rounded-lg transition-colors">
        ⚡ Fill This Page
      </button>

      <div className="text-center">
        <button
          onClick={() => setScreen('setup')}
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          Change AI Provider
        </button>
      </div>
    </div>
  );
}
