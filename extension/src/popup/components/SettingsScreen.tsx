import React, { useEffect, useState } from 'react';
import type { UserSettings, ProfileEntry, DocumentMeta } from '@shared/types';
import { sendToBackground } from '../utils/messages';
import { getAllQAEntries } from '@/content-script/qa-cache';

interface Props {
  onBack: () => void;
}

export default function SettingsScreen({ onBack }: Props): React.ReactElement {
  const [settings,     setSettings]     = useState<UserSettings | null>(null);
  const [exporting,    setExporting]    = useState(false);
  const [wipeConfirm,  setWipeConfirm]  = useState(false);
  const [wiping,       setWiping]       = useState(false);
  const [wipeDone,     setWipeDone]     = useState(false);

  useEffect(() => {
    sendToBackground<UserSettings>('GET_SETTINGS')
      .then(setSettings)
      .catch(() => {});
  }, []);

  async function toggleSetting(
    key: keyof Pick<UserSettings, 'autoSave' | 'showGhostText' | 'blockSensitiveDomains' | 'cloudSync'>
  ): Promise<void> {
    if (!settings) return;
    const newValue = !settings[key];
    const next = { ...settings, [key]: newValue };
    setSettings(next);
    try {
      const confirmed = await sendToBackground<UserSettings>('UPDATE_SETTINGS', {
        [key]: newValue,
      });
      setSettings(confirmed);
      // When cloud sync is just turned on, push any pending local data immediately
      // so the user doesn't have to wait up to 5 minutes for the next alarm.
      if (key === 'cloudSync' && newValue) {
        sendToBackground('SYNC_NOW').catch(() => {});
      }
    } catch {
      setSettings(settings);
    }
  }

  async function handleExport(): Promise<void> {
    setExporting(true);
    try {
      const [profile, docs, answers] = await Promise.all([
        sendToBackground<ProfileEntry[]>('GET_PROFILE'),
        sendToBackground<DocumentMeta[]>('GET_DOCUMENTS'),
        getAllQAEntries(),
      ]);
      const blob = new Blob(
        [JSON.stringify({ exportedAt: new Date().toISOString(), profile, documents: docs, answers }, null, 2)],
        { type: 'application/json' }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `smartfillai-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silent — user will see nothing downloaded
    } finally {
      setExporting(false);
    }
  }

  async function handleWipe(): Promise<void> {
    setWiping(true);
    try {
      await sendToBackground('WIPE_ALL_DATA');
      setWipeDone(true);
      setWipeConfirm(false);
    } catch {
      // silent
    } finally {
      setWiping(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass-header flex items-center justify-between px-4 py-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <span className="text-sm font-semibold text-slate-700">Settings</span>
        <div className="w-12" />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Sync + Autofill toggles */}
        {settings ? (
          <>
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 px-1">Sync</p>
              <div className="glass-card overflow-hidden">
                <ToggleRow
                  label="Cloud sync"
                  description="Back up your profile and sync it across browsers and devices"
                  checked={settings.cloudSync}
                  onChange={() => toggleSetting('cloudSync')}
                  last
                />
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 px-1">Autofill</p>
              <div className="glass-card overflow-hidden">
                <ToggleRow
                  label="Auto-save fields I fill"
                  description="Remembers values you type and updates them when changed"
                  checked={settings.autoSave}
                  onChange={() => toggleSetting('autoSave')}
                />
                <ToggleRow
                  label="Show field hints"
                  description="Outline fillable fields and preview what will be filled"
                  checked={settings.showGhostText}
                  onChange={() => toggleSetting('showGhostText')}
                />
                <ToggleRow
                  label="Block sensitive domains"
                  description="Disable autofill on banking and health websites"
                  checked={settings.blockSensitiveDomains}
                  onChange={() => toggleSetting('blockSensitiveDomains')}
                  last
                />
              </div>
            </div>
          </>
        ) : (
          <div className="glass-card px-4 py-6 flex justify-center">
            <span className="w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Data management */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 px-1">Data</p>
          <div className="glass-card overflow-hidden">
            {/* Export */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/40">
              <div className="flex-1 pr-4">
                <p className="text-sm font-medium text-slate-700">Export profile data</p>
                <p className="text-xs text-slate-400 mt-0.5">Download your profile, answers and documents as JSON</p>
              </div>
              <button
                onClick={handleExport}
                disabled={exporting}
                className="px-3 py-1.5 text-xs font-medium text-sky-600 bg-sky-50/80 hover:bg-sky-100/80 border border-sky-100 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {exporting ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    Exporting…
                  </span>
                ) : 'Export'}
              </button>
            </div>

            {/* Wipe all data */}
            <div className="px-4 py-3">
              {wipeDone ? (
                <div className="flex items-center gap-2 text-emerald-600">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <p className="text-xs font-medium">All data wiped. You've been signed out.</p>
                </div>
              ) : wipeConfirm ? (
                <div className="space-y-2">
                  <p className="text-xs text-red-700 font-medium">Delete all profile data, answers and documents?</p>
                  <p className="text-xs text-slate-400">This cannot be undone.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setWipeConfirm(false)}
                      className="flex-1 py-1.5 text-xs bg-white/60 border border-white/70 text-slate-600 rounded-lg hover:bg-white/80 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleWipe}
                      disabled={wiping}
                      className="flex-1 py-1.5 text-xs bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors disabled:opacity-60 flex items-center justify-center gap-1.5"
                    >
                      {wiping && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                      {wiping ? 'Deleting…' : 'Delete all'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex-1 pr-4">
                    <p className="text-sm font-medium text-slate-700">Wipe all data</p>
                    <p className="text-xs text-slate-400 mt-0.5">Delete profile, answers, documents and sign out</p>
                  </div>
                  <button
                    onClick={() => setWipeConfirm(true)}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50/80 hover:bg-red-100/80 border border-red-100 rounded-lg transition-colors flex-shrink-0"
                  >
                    Wipe
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* About */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 px-1">About</p>
          <div className="glass-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/40">
              <p className="text-sm text-slate-600">SmartFillAI</p>
              <p className="text-xs text-slate-400">v1.0.0</p>
            </div>
            <div className="px-4 py-3 flex items-center justify-between border-b border-white/40">
              <p className="text-sm text-slate-600">Privacy policy</p>
              <a
                href="https://smartfillai.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-sky-600 hover:text-sky-700 transition-colors"
              >
                smartfillai.com/privacy →
              </a>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs text-slate-400 leading-relaxed">
                Your profile data is stored locally on this device. When cloud sync is enabled,
                it is encrypted in transit and stored in your private Supabase account. AI features
                send only field labels — never your profile values — to GROQ or Gemini.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Toggle row ─────────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label:       string;
  description: string;
  checked:     boolean;
  onChange:    () => void;
  last?:       boolean;
}

function ToggleRow({ label, description, checked, onChange, last }: ToggleRowProps): React.ReactElement {
  return (
    <div
      className={`flex items-center justify-between px-4 py-3 ${!last ? 'border-b border-white/40' : ''} hover:bg-white/30 transition-colors cursor-pointer`}
      onClick={onChange}
    >
      <div className="flex-1 pr-4">
        <p className="text-sm font-medium text-slate-700">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{description}</p>
      </div>
      <div
        role="switch"
        aria-checked={checked}
        className={`relative flex-shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 ${
          checked ? 'bg-sky-500' : 'bg-slate-300'
        }`}
        onClick={e => { e.stopPropagation(); onChange(); }}
      >
        <span
          className={`absolute top-[3px] w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${
            checked ? 'translate-x-[22px]' : 'translate-x-[3px]'
          }`}
        />
      </div>
    </div>
  );
}
