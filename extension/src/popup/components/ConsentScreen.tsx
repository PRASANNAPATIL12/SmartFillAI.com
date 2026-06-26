import React, { useState } from 'react';
import { sendToBackground } from '../utils/messages';

interface Props {
  onDone: () => void;
}

const CONSENT_SHOWN_KEY = 'global_consent_shown';

export default function ConsentScreen({ onDone }: Props): React.ReactElement {
  const [busy, setBusy] = useState(false);

  async function handleChoice(contributeToGlobal: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await sendToBackground('UPDATE_SETTINGS', { contributeToGlobal });
      await chrome.storage.local.set({ [CONSENT_SHOWN_KEY]: true });
    } catch {
      // Non-fatal — settings will default to ON if this fails, user can adjust in Settings
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass-header flex items-center justify-center px-4 py-3">
        <span className="text-sm font-semibold text-slate-700">Help improve SmartFillAI</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Icon + intro */}
        <div className="flex flex-col items-center text-center pt-2 pb-1">
          <div className="w-12 h-12 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            When you fill a job form, SmartFillAI can anonymously share <em>which fields appear</em> on that portal — so new users get accurate autofill on their first visit.
          </p>
        </div>

        {/* What's shared */}
        <div className="glass-card px-4 py-3 space-y-2">
          <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">What's shared</p>
          {[
            'Field structure — e.g. "first name field exists on this form"',
            'Field type mapping — e.g. "this field is phone_number"',
            'Portal name — e.g. "Greenhouse" or "Workday"',
          ].map(item => (
            <div key={item} className="flex items-start gap-2">
              <svg className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <p className="text-xs text-slate-600 leading-relaxed">{item}</p>
            </div>
          ))}
        </div>

        {/* What's never shared */}
        <div className="glass-card px-4 py-3 space-y-2">
          <p className="text-xs font-semibold text-rose-700 uppercase tracking-wide">Never shared</p>
          {[
            'Your name, email, phone, or any profile value',
            'Your resume text or Q&A answers',
            'Raw field labels (only a one-way hash)',
          ].map(item => (
            <div key={item} className="flex items-start gap-2">
              <svg className="w-3.5 h-3.5 text-rose-400 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
              <p className="text-xs text-slate-600 leading-relaxed">{item}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-400 text-center px-2">
          You can change this anytime in Settings → Community.
        </p>
      </div>

      {/* CTA buttons */}
      <div className="px-4 py-4 space-y-2 border-t border-white/40">
        <button
          onClick={() => handleChoice(true)}
          disabled={busy}
          className="w-full py-2.5 text-sm font-semibold text-white bg-sky-500 hover:bg-sky-600 rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {busy ? (
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : null}
          Turn on
        </button>
        <button
          onClick={() => handleChoice(false)}
          disabled={busy}
          className="w-full py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors disabled:opacity-60"
        >
          Keep off
        </button>
      </div>
    </div>
  );
}
