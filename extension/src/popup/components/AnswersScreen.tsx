import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getAllQAEntries, updateQAEntry, deleteQAEntry, type QASource } from '@/content-script/qa-cache';
import { STORAGE_KEYS } from '@shared/types';

interface QARow {
  question: string;
  answer: string;
  source: QASource;
  alternativeCount: number;
}

interface UndoPending {
  row: QARow;
  expiresAt: number;
}

interface Props {
  onBack: () => void;
}

const UNDO_DURATION_MS = 8000;

export default function AnswersScreen({ onBack }: Props): React.ReactElement {
  const [rows,        setRows]        = useState<QARow[]>([]);
  const [search,      setSearch]      = useState('');
  const [editingQ,    setEditingQ]    = useState<string | null>(null);
  const [editValue,   setEditValue]   = useState('');
  const [loading,     setLoading]     = useState(true);
  const [undoPending, setUndoPending] = useState<UndoPending | null>(null);
  const [toastPct,    setToastPct]    = useState(100);
  const commitTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer     = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearUndo = useCallback(() => {
    if (commitTimer.current) { clearTimeout(commitTimer.current);  commitTimer.current  = null; }
    if (tickTimer.current)   { clearInterval(tickTimer.current);   tickTimer.current    = null; }
    setUndoPending(null);
    setToastPct(100);
  }, []);

  const loadEntries = useCallback(async () => {
    const entries = await getAllQAEntries();
    entries.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'llm' ? -1 : 1;
      return a.question.localeCompare(b.question);
    });
    setRows(entries);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEntries();
    const handler = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (STORAGE_KEYS.QA_CACHE in changes) loadEntries();
    };
    chrome.storage.onChanged.addListener(handler);
    return () => {
      chrome.storage.onChanged.removeListener(handler);
      clearUndo();
    };
  }, [loadEntries, clearUndo]);

  const filtered = search.trim()
    ? rows.filter(r =>
        r.question.toLowerCase().includes(search.toLowerCase()) ||
        r.answer.toLowerCase().includes(search.toLowerCase())
      )
    : rows;

  const startEdit = (q: string, currentAnswer: string) => {
    setEditingQ(q);
    setEditValue(currentAnswer);
  };

  const saveEdit = async () => {
    if (!editingQ) return;
    await updateQAEntry(editingQ, editValue);
    setEditingQ(null);
    await loadEntries();
  };

  const handleDelete = (row: QARow) => {
    // Commit any previous pending delete immediately before starting a new one
    if (undoPending) {
      deleteQAEntry(undoPending.row.question).catch(() => {});
      clearUndo();
    }

    // Optimistic removal from list
    setRows(prev => prev.filter(r => r.question !== row.question));

    const expiresAt = Date.now() + UNDO_DURATION_MS;
    setUndoPending({ row, expiresAt });
    setToastPct(100);

    // Progress bar tick every 80ms
    tickTimer.current = setInterval(() => {
      const remaining = expiresAt - Date.now();
      setToastPct(Math.max(0, (remaining / UNDO_DURATION_MS) * 100));
    }, 80);

    // Commit delete after timeout
    commitTimer.current = setTimeout(() => {
      deleteQAEntry(row.question).catch(() => {});
      clearUndo();
    }, UNDO_DURATION_MS);
  };

  const handleUndo = () => {
    if (!undoPending) return;
    // Restore the row
    setRows(prev => {
      const next = [...prev, undoPending.row];
      next.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'llm' ? -1 : 1;
        return a.question.localeCompare(b.question);
      });
      return next;
    });
    clearUndo();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass-header flex items-center gap-2 px-4 py-3">
        <button onClick={onBack} className="glass-btn-icon text-slate-600 hover:text-slate-800">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-slate-800 flex-1">Remembered Answers</span>
        {!loading && (
          <span className="text-xs font-medium text-slate-400 bg-white/40 px-2 py-0.5 rounded-full">
            {rows.length}
          </span>
        )}
      </div>

      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <svg className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-400 pointer-events-none"
            fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search questions…"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white/60 border border-white/70 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400 text-slate-700 placeholder-slate-400"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {loading && (
          <div className="flex justify-center py-8">
            <span className="w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && filtered.length === 0 && !undoPending && (
          <div className="flex flex-col items-center py-8 text-center">
            <p className="text-sm text-slate-500">
              {rows.length === 0 ? 'No answers saved yet.' : 'No matches.'}
            </p>
            {rows.length === 0 && (
              <p className="text-xs text-slate-400 mt-1">
                Fill a form and your answers to questions will appear here.
              </p>
            )}
          </div>
        )}

        {!loading && filtered.map(row => (
          <div key={row.question} className="glass-card px-3 py-2.5 group">
            {/* Question */}
            <p className="text-xs text-slate-500 leading-relaxed break-words mb-1.5"
              title={row.question}>
              {row.question.length > 120 ? row.question.slice(0, 120) + '…' : row.question}
            </p>

            {editingQ === row.question ? (
              /* Edit mode */
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') setEditingQ(null);
                  }}
                  className="flex-1 px-2 py-1 text-xs bg-white/60 border border-sky-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400 text-slate-800"
                />
                <button onClick={saveEdit}
                  className="px-2.5 py-1 text-xs font-medium bg-sky-500 text-white rounded-lg hover:bg-sky-600 transition-colors">
                  Save
                </button>
                <button onClick={() => setEditingQ(null)}
                  className="px-2 py-1 text-xs bg-white/60 border border-white/70 text-slate-600 rounded-lg hover:bg-white/80 transition-colors">
                  Cancel
                </button>
              </div>
            ) : (
              /* Normal view */
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-slate-800 truncate" title={row.answer}>
                    {row.answer.length > 80 ? row.answer.slice(0, 80) + '…' : row.answer}
                  </span>
                  <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium ${
                    row.source === 'llm'
                      ? 'bg-violet-50 text-violet-600'
                      : 'bg-emerald-50 text-emerald-600'
                  }`}>
                    {row.source === 'llm' ? 'AI' : 'You'}
                  </span>
                  {row.alternativeCount > 1 && (
                    <span className="flex-shrink-0 text-[10px] text-slate-400">
                      +{row.alternativeCount - 1}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 ml-2">
                  <button
                    onClick={() => startEdit(row.question, row.answer)}
                    title="Edit answer"
                    className="p-1.5 rounded-lg hover:bg-white/70 text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(row)}
                    title="Delete answer"
                    className="p-1.5 rounded-lg hover:bg-red-50/60 text-slate-400 hover:text-red-500 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Undo toast */}
      {undoPending && (
        <div className="mx-3 mb-3 glass-card px-3 py-2 flex items-center justify-between overflow-hidden relative">
          {/* Progress bar */}
          <div
            className="absolute bottom-0 left-0 h-0.5 bg-sky-400 transition-none"
            style={{ width: `${toastPct}%` }}
          />
          <p className="text-xs text-slate-600">Answer deleted</p>
          <button
            onClick={handleUndo}
            className="text-xs font-semibold text-sky-600 hover:text-sky-700 ml-4"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
