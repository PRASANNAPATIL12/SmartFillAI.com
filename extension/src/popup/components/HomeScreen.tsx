import React, { useCallback, useEffect, useState } from 'react';
import type { DocumentMeta, ProfileEntry } from '@shared/types';
import { sendToBackground, sendToActiveTab } from '../utils/messages';
import { getAllQAEntries } from '@/content-script/qa-cache';

interface SessionInfo {
  userId:    string;
  email:     string;
  expiresAt: number;
}

interface Props {
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
  session, onGoProfile, onGoSettings, onGoDocuments, onGoAnswers, onGoLogin, onSignOut,
}: Props): React.ReactElement {
  const [entries,      setEntries]      = useState<ProfileEntry[]>([]);
  const [docCount,     setDocCount]     = useState(0);
  const [answerCount,  setAnswerCount]  = useState(0);
  const [fillState,    setFillState]    = useState<FillState>('idle');
  const [fillResult,   setFillResult]   = useState<{ filled: number; skipped: number } | null>(null);
  const [fillError,    setFillError]    = useState('');
  const [syncing,      setSyncing]      = useState(false);
  const [fieldStats,   setFieldStats]   = useState<{ total: number; matched: number } | null>(null);
  const [isOnline,     setIsOnline]     = useState(navigator.onLine);

  useEffect(() => {
    const onOnline  = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online',  onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online',  onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    sendToBackground<ProfileEntry[]>('GET_PROFILE')
      .then(setEntries).catch(() => setEntries([]));
    sendToBackground<DocumentMeta[]>('GET_DOCUMENTS')
      .then(docs => setDocCount(docs.length)).catch(() => setDocCount(0));
    getAllQAEntries()
      .then(entries => setAnswerCount(entries.length)).catch(() => setAnswerCount(0));
    sendToActiveTab<{ total: number; matched: number }>('GET_FIELD_STATS')
      .then(stats => setFieldStats(stats)).catch(() => setFieldStats(null));
  }, []);

  const handleFill = useCallback(async () => {
    setFillState('filling');
    setFillError('');
    try {
      const result = await sendToActiveTab<{ filled: number; skipped: number }>('FILL_ALL');
      setFillResult(result);
      setFillState(result.filled === 0 ? 'error' : 'done');
      sendToActiveTab<{ total: number; matched: number }>('GET_FIELD_STATS')
        .then(stats => setFieldStats(stats)).catch(() => {});
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
      // silently ignore
    } finally {
      setSyncing(false);
    }
  }, []);

  const categoryCount = new Set(entries.map(e => e.category)).size;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="glass-header flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold text-slate-800 tracking-tight">SmartFillAI</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={onGoProfile} title="Profile"
            className="glass-btn-icon text-slate-600 hover:text-slate-800">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </button>
          <button onClick={onGoSettings} title="Settings"
            className="glass-btn-icon text-slate-600 hover:text-slate-800">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Offline indicator ── */}
      {!isOnline && (
        <div className="mx-3 mt-2 px-3 py-2 bg-amber-50/80 border border-amber-100 rounded-xl flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M18.364 5.636a9 9 0 010 12.728m-3.536-3.536a4 4 0 000-5.656M5.636 5.636a9 9 0 000 12.728m3.536-3.536a4 4 0 010-5.656M12 12v.01" />
          </svg>
          <p className="text-xs text-amber-700">Offline — autofill works, sync paused</p>
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">

        {/* Fill button */}
        <button
          onClick={handleFill}
          disabled={fillState === 'filling'}
          className={`w-full py-3 rounded-xl text-sm font-semibold transition-all shadow-sm ${
            fillState === 'done'
              ? 'bg-emerald-500 text-white shadow-emerald-200'
              : fillState === 'error'
                ? 'bg-red-100/80 text-red-700 backdrop-blur-sm border border-red-200/50'
                : 'bg-sky-500 hover:bg-sky-600 active:bg-sky-700 text-white shadow-sky-200'
          } disabled:opacity-60`}
        >
          {fillState === 'filling' && (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Filling…
            </span>
          )}
          {fillState === 'done' && fillResult && (() => {
            const total = fieldStats?.total ?? (fillResult.filled + fillResult.skipped);
            return total > fillResult.filled
              ? `Filled ${fillResult.filled} / ${total} fields`
              : `Filled ${fillResult.filled} field${fillResult.filled !== 1 ? 's' : ''}`;
          })()}
          {fillState === 'error' && fillError}
          {fillState === 'idle' && 'Fill This Page'}
        </button>

        {/* Field detection sub-line */}
        {fieldStats && fieldStats.total > 0 && fillState === 'idle' && (
          <p className="text-center text-xs text-slate-500 -mt-1">
            {fieldStats.total} field{fieldStats.total !== 1 ? 's' : ''} detected
            {fieldStats.matched > 0 && ` · ${fieldStats.matched} from profile`}
          </p>
        )}

        {/* Profile — single row */}
        <button
          onClick={onGoProfile}
          className="glass-card w-full flex items-center justify-between px-4 py-3 hover:bg-white/80 transition-colors text-left"
        >
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-0.5">Profile</p>
            {entries.length === 0 ? (
              <p className="text-sm text-slate-400">No entries yet — tap to add</p>
            ) : (
              <p className="text-sm text-slate-700 font-medium">
                {entries.length} entr{entries.length !== 1 ? 'ies' : 'y'}
                {categoryCount > 0 && (
                  <span className="text-slate-400 font-normal">
                    {' '}across {categoryCount} categor{categoryCount !== 1 ? 'ies' : 'y'}
                  </span>
                )}
              </p>
            )}
          </div>
          <svg className="w-4 h-4 text-slate-400 flex-shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Documents */}
        <button
          onClick={onGoDocuments}
          className="glass-card w-full flex items-center justify-between px-4 py-3 hover:bg-white/80 transition-colors text-left"
        >
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-0.5">Documents</p>
            <p className="text-sm text-slate-700 font-medium">
              {docCount === 0
                ? <span className="text-slate-400 font-normal">No files yet — tap to upload</span>
                : `${docCount} file${docCount !== 1 ? 's' : ''} ready`}
            </p>
          </div>
          <svg className="w-4 h-4 text-slate-400 flex-shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* Answers */}
        <button
          onClick={onGoAnswers}
          className="glass-card w-full flex items-center justify-between px-4 py-3 hover:bg-white/80 transition-colors text-left"
        >
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-0.5">Answers</p>
            <p className="text-sm text-slate-700 font-medium">
              {answerCount === 0
                ? <span className="text-slate-400 font-normal">Remembered answers appear here</span>
                : `${answerCount} remembered answer${answerCount !== 1 ? 's' : ''}`}
            </p>
          </div>
          <svg className="w-4 h-4 text-slate-400 flex-shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>

        {/* How it works — shown only when profile is empty */}
        {entries.length === 0 && (
          <div className="glass-card px-4 py-3 space-y-1.5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">How it works</p>
            <ol className="space-y-1 list-decimal list-inside text-xs text-slate-500">
              <li>Add your profile data once</li>
              <li>Visit any job application form</li>
              <li>Click "Fill This Page" — done</li>
            </ol>
          </div>
        )}

        {/* ── Cloud sync banner ── */}
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
      </div>
    </div>
  );
}
