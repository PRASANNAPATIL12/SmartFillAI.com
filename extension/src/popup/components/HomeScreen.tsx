import React, { useCallback, useEffect, useState } from 'react';
import type { DocumentMeta, ProfileEntry } from '@shared/types';
import type { AIProviderName } from '@/ai-providers';
import { sendToBackground, sendToActiveTab } from '../utils/messages';
import { getAllQAEntries } from '@/content-script/qa-cache';
import { CATEGORY_LABELS, type EntryCategory } from '../utils/canonicalKeys';

interface SessionInfo {
  userId:    string;
  email:     string;
  expiresAt: number;
}

interface Props {
  provider:    AIProviderName;
  session:     SessionInfo | null;
  onGoProfile:   () => void;
  onGoSettings:  () => void;
  onGoDocuments: () => void;
  onGoAnswers:   () => void;
  onGoLogin:     () => void;
  onSignOut:     () => void;
}

type FillState = 'idle' | 'filling' | 'done' | 'error';

export default function HomeScreen({
  provider, session, onGoProfile, onGoSettings, onGoDocuments, onGoAnswers, onGoLogin, onSignOut,
}: Props): React.ReactElement {
  const [entries,    setEntries]    = useState<ProfileEntry[]>([]);
  const [docCount,   setDocCount]   = useState(0);
  const [answerCount, setAnswerCount] = useState(0);
  const [fillState,  setFillState]  = useState<FillState>('idle');
  const [fillResult, setFillResult] = useState<{ filled: number; skipped: number } | null>(null);
  const [fillError,  setFillError]  = useState('');
  const [syncing,    setSyncing]    = useState(false);

  useEffect(() => {
    sendToBackground<ProfileEntry[]>('GET_PROFILE')
      .then(setEntries)
      .catch(() => setEntries([]));
    sendToBackground<DocumentMeta[]>('GET_DOCUMENTS')
      .then(docs => setDocCount(docs.length))
      .catch(() => setDocCount(0));
    getAllQAEntries()
      .then(entries => setAnswerCount(entries.length))
      .catch(() => setAnswerCount(0));
  }, []);

  const handleFill = useCallback(async () => {
    setFillState('filling');
    setFillError('');
    try {
      const result = await sendToActiveTab<{ filled: number; skipped: number }>('FILL_ALL');
      setFillResult(result);
      setFillState(result.filled === 0 ? 'error' : 'done');
      if (result.filled === 0) {
        setFillError(
          entries.length === 0
            ? 'No profile data yet — add some first.'
            : 'No matching fields on this page.'
        );
      }
      setTimeout(() => setFillState('idle'), 3500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let errorText: string;
      if (msg === 'restricted_page' || msg.includes('unavailable') || msg.includes('Cannot access')) {
        errorText = 'Cannot fill this page. Try a regular website.';
      } else if (msg === 'context_invalidated') {
        errorText = 'Extension reloaded — refresh this page.';
      } else if (msg === 'cs_unreachable') {
        errorText = 'Page not ready — please refresh it.';
      } else {
        errorText = 'Fill failed — try refreshing the page.';
      }
      setFillError(errorText);
      setFillState('error');
      setTimeout(() => setFillState('idle'), 4000);
    }
  }, [entries.length]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await sendToBackground('SYNC_NOW');
      const updated = await sendToBackground<ProfileEntry[]>('GET_PROFILE');
      setEntries(updated);
    } catch {
      // silently ignore — user will see stale data
    } finally {
      setSyncing(false);
    }
  }, []);

  const categoryCounts = entries.reduce<Partial<Record<string, number>>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1;
    return acc;
  }, {});

  const providerLabel = provider === 'groq' ? 'GROQ' : 'Gemini';

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-slate-800 tracking-tight">SmartFillAI</span>
          <span className="text-xs bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium">
            {providerLabel}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onGoProfile} title="Manage profile"
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </button>
          <button onClick={onGoSettings} title="Settings"
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

        {/* Fill button */}
        <button
          onClick={handleFill}
          disabled={fillState === 'filling'}
          className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all ${
            fillState === 'done'
              ? 'bg-emerald-500 text-white'
              : fillState === 'error'
                ? 'bg-red-100 text-red-700'
                : 'bg-sky-500 hover:bg-sky-600 text-white'
          } disabled:opacity-60`}
        >
          {fillState === 'filling' && (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Filling…
            </span>
          )}
          {fillState === 'done' && fillResult && (
            `Filled ${fillResult.filled} field${fillResult.filled !== 1 ? 's' : ''}`
          )}
          {fillState === 'error' && fillError}
          {fillState === 'idle' && 'Fill This Page'}
        </button>

        {/* Profile summary */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Profile</span>
            <button onClick={onGoProfile} className="text-xs text-sky-500 hover:underline">
              {entries.length === 0 ? 'Add entries' : 'Manage'}
            </button>
          </div>

          {entries.length === 0 ? (
            <div className="bg-slate-50 rounded-xl p-3 text-center">
              <p className="text-sm text-slate-500">No profile entries yet.</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Add your data and SmartFillAI will fill it into forms automatically.
              </p>
              <button onClick={onGoProfile}
                className="mt-2 text-xs text-sky-500 font-medium hover:underline">
                Add first entry →
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(categoryCounts).map(([cat, count]) => (
                <button key={cat} onClick={onGoProfile}
                  className="flex flex-col items-center bg-slate-50 hover:bg-slate-100 rounded-xl p-2 transition-colors">
                  <span className="text-lg font-bold text-slate-700">{count}</span>
                  <span className="text-xs text-slate-500 capitalize">
                    {CATEGORY_LABELS[cat as EntryCategory] ?? cat}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Documents */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Documents</span>
            <button onClick={onGoDocuments} className="text-xs text-sky-500 hover:underline">
              {docCount === 0 ? 'Upload' : 'Manage'}
            </button>
          </div>
          {docCount === 0 ? (
            <div className="bg-slate-50 rounded-xl p-3 text-center">
              <p className="text-xs text-slate-400">Upload your resume to auto-attach it on applications.</p>
              <button onClick={onGoDocuments}
                className="mt-1.5 text-xs text-sky-500 font-medium hover:underline">
                Upload document →
              </button>
            </div>
          ) : (
            <button onClick={onGoDocuments}
              className="w-full flex items-center justify-between bg-slate-50 hover:bg-slate-100 rounded-xl px-3 py-2 transition-colors">
              <span className="text-xs text-slate-600">
                {docCount} document{docCount !== 1 ? 's' : ''} ready
              </span>
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* Answers */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Answers</span>
            <button onClick={onGoAnswers} className="text-xs text-sky-500 hover:underline">
              {answerCount === 0 ? 'View' : 'Review'}
            </button>
          </div>
          {answerCount === 0 ? (
            <div className="bg-slate-50 rounded-xl p-3 text-center">
              <p className="text-xs text-slate-400">Remembered answers to form questions will appear here.</p>
            </div>
          ) : (
            <button onClick={onGoAnswers}
              className="w-full flex items-center justify-between bg-slate-50 hover:bg-slate-100 rounded-xl px-3 py-2 transition-colors">
              <span className="text-xs text-slate-600">
                {answerCount} remembered answer{answerCount !== 1 ? 's' : ''}
              </span>
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>

        {/* Cloud sync banner */}
        {session ? (
          <div className="bg-sky-50 border border-sky-100 rounded-xl px-3 py-2 flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium text-sky-700 truncate">{session.email}</p>
              <p className="text-xs text-sky-500">Syncing enabled</p>
            </div>
            <div className="flex items-center gap-1 ml-2 flex-shrink-0">
              <button
                onClick={handleSyncNow}
                disabled={syncing}
                title="Sync now"
                className="p-1 rounded-md hover:bg-sky-100 text-sky-600 disabled:opacity-50 transition-colors"
              >
                <svg className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              <button
                onClick={onSignOut}
                title="Sign out"
                className="p-1 rounded-md hover:bg-sky-100 text-sky-600 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={onGoLogin}
            className="w-full py-2 text-xs text-slate-500 bg-slate-50 hover:bg-slate-100 rounded-xl transition-colors border border-slate-100"
          >
            Sign in to sync across devices →
          </button>
        )}

        {entries.length === 0 && (
          <div className="space-y-2 text-xs text-slate-400">
            <p className="font-medium text-slate-500">How it works</p>
            <ol className="space-y-1 list-decimal list-inside">
              <li>Add your profile data once</li>
              <li>Visit any job application form</li>
              <li>Click "Fill This Page" — done</li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
