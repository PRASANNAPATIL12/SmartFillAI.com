import React, { useState } from 'react';
import { setAPIKey, setProviderConfig } from '@/ai-providers';
import type { AIProviderName } from '@/ai-providers';

interface Props {
  initialProvider: AIProviderName;
  onDone: (provider: AIProviderName) => void;
}

export default function SetupScreen({ initialProvider, onDone }: Props): React.ReactElement {
  const [provider, setProvider] = useState<AIProviderName>(initialProvider);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave(): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('API key cannot be empty.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await setAPIKey(provider, trimmed);
      await setProviderConfig({ provider, fallbackProvider: provider === 'groq' ? 'gemini' : 'groq' });
      onDone(provider);
    } catch {
      setError('Failed to save key — please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-base font-semibold text-slate-800">Setup Ditto</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Add your AI provider key to get started. Keys are stored locally and never shared.
        </p>
      </div>

      {/* Provider selector */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-600">AI Provider</label>
        <select
          value={provider}
          onChange={e => { setProvider(e.target.value as AIProviderName); setError(''); }}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400 bg-white"
        >
          <option value="groq">GROQ — Llama 3.3 (fast, free tier)</option>
          <option value="gemini">Google Gemini 2.0 Flash</option>
        </select>
      </div>

      {/* API key input */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-600">
          {provider === 'groq' ? 'GROQ' : 'Gemini'} API Key
        </label>
        <input
          type="password"
          autoComplete="off"
          placeholder={provider === 'groq' ? 'gsk_...' : 'AIza...'}
          value={apiKey}
          onChange={e => { setApiKey(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <div className="space-y-1.5">
        <a
          href={
            provider === 'groq'
              ? 'https://console.groq.com/keys'
              : 'https://aistudio.google.com/app/apikey'
          }
          target="_blank"
          rel="noreferrer"
          className="block text-xs text-sky-500 hover:underline"
        >
          Get a free {provider === 'groq' ? 'GROQ' : 'Gemini'} API key →
        </a>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full py-2 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-50 rounded-lg transition-colors"
      >
        {saving ? 'Saving…' : 'Save & Continue'}
      </button>
    </div>
  );
}
