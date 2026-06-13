import React, { useEffect, useState } from 'react';
import type { UserSettings } from '@shared/types';
import type { AIProviderName } from '@/ai-providers';
import { getAPIKey, setAPIKey, setProviderConfig } from '@/ai-providers';
import { sendToBackground } from '../utils/messages';

interface Props {
  provider: AIProviderName;
  onBack: () => void;
  onProviderChange: (p: AIProviderName) => void;
}

export default function SettingsScreen({ provider, onBack, onProviderChange }: Props): React.ReactElement {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [apiKey, setApiKeyState] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<AIProviderName>(provider);
  const [keySaved, setKeySaved] = useState(false);
  const [monthlyCost, setMonthlyCost] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      sendToBackground<UserSettings>('GET_SETTINGS'),
      getAPIKey(provider),
      sendToBackground<{ monthly: number }>('GET_AI_COST'),
    ]).then(([s, key, cost]) => {
      setSettings(s);
      setApiKeyState(key ? '••••••••' : '');
      setMonthlyCost(cost.monthly);
    }).catch(() => {});
  }, [provider]);

  async function handleSaveKey(): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed || trimmed === '••••••••') return;
    await setAPIKey(selectedProvider, trimmed);
    await setProviderConfig({ provider: selectedProvider, fallbackProvider: selectedProvider === 'groq' ? 'gemini' : 'groq' });
    onProviderChange(selectedProvider);
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  }

  async function toggleSetting(key: keyof Pick<UserSettings, 'autoSave' | 'showGhostText' | 'blockSensitiveDomains' | 'cloudSync'>): Promise<void> {
    if (!settings) return;
    const updated = await sendToBackground<UserSettings>('UPDATE_SETTINGS', {
      [key]: !settings[key],
    });
    setSettings(updated);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <span className="text-sm font-semibold text-slate-700">Settings</span>
        <div className="w-10" />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">

        {/* AI Provider section */}
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">AI Provider</p>
          <div className="space-y-2">
            <select
              value={selectedProvider}
              onChange={e => {
                const p = e.target.value as AIProviderName;
                setSelectedProvider(p);
                setApiKeyState('');
              }}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-sky-400 bg-white"
            >
              <option value="groq">GROQ — Llama 3.3</option>
              <option value="gemini">Google Gemini 2.0 Flash</option>
            </select>

            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="off"
                placeholder="Paste new API key to update"
                value={apiKey}
                onChange={e => setApiKeyState(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-sky-400"
              />
              <button
                onClick={handleSaveKey}
                className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  keySaved
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-sky-500 text-white hover:bg-sky-600'
                }`}
              >
                {keySaved ? 'Saved' : 'Update'}
              </button>
            </div>
          </div>
        </div>

        {/* Autofill toggles */}
        {settings && (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Autofill</p>
            <div className="space-y-0 rounded-xl border border-slate-100 overflow-hidden">
              <ToggleRow
                label="Show field hints"
                description="Highlight fillable fields with a subtle outline"
                checked={settings.showGhostText}
                onChange={() => toggleSetting('showGhostText')}
              />
              <ToggleRow
                label="Auto-save learned values"
                description="Remember values you manually type into forms"
                checked={settings.autoSave}
                onChange={() => toggleSetting('autoSave')}
              />
              <ToggleRow
                label="Block sensitive domains"
                description="Disable on banking and health sites"
                checked={settings.blockSensitiveDomains}
                onChange={() => toggleSetting('blockSensitiveDomains')}
              />
            </div>
          </div>
        )}

        {/* Usage */}
        {monthlyCost !== null && (
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">AI Usage</p>
            <div className="bg-slate-50 rounded-xl p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-slate-500">This month</span>
                <span className="text-sm font-semibold text-slate-700">
                  ${monthlyCost.toFixed(4)}
                </span>
              </div>
              {monthlyCost === 0 && (
                <p className="text-xs text-slate-400 mt-0.5">No AI usage yet.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Toggle row ─────────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
      <div className="flex-1 pr-3">
        <p className="text-sm text-slate-700">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? 'bg-sky-500' : 'bg-slate-200'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}
