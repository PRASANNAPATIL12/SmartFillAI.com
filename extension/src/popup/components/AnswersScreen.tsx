import React, { useCallback, useEffect, useState } from 'react';
import { getAllQAEntries, updateQAEntry, deleteQAEntry, type QASource } from '@/content-script/qa-cache';
import { STORAGE_KEYS } from '@shared/types';

interface QARow {
  question: string;
  answer: string;
  source: QASource;
  alternativeCount: number;
}

interface Props {
  onBack: () => void;
}

export default function AnswersScreen({ onBack }: Props): React.ReactElement {
  const [rows, setRows] = useState<QARow[]>([]);
  const [search, setSearch] = useState('');
  const [editingQ, setEditingQ] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [loading, setLoading] = useState(true);

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
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [loadEntries]);

  const filtered = search.trim()
    ? rows.filter(r => r.question.includes(search.toLowerCase()) || r.answer.toLowerCase().includes(search.toLowerCase()))
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

  const handleDelete = async (q: string) => {
    await deleteQAEntry(q);
    await loadEntries();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <button onClick={onBack}
          className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-slate-800">Remembered Answers</span>
        <span className="ml-auto text-xs text-slate-400">{rows.length}</span>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-slate-50">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search questions..."
          className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-sky-300 text-slate-700 placeholder-slate-400"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-slate-500">
              {rows.length === 0
                ? 'No answers saved yet.'
                : 'No matches.'}
            </p>
            {rows.length === 0 && (
              <p className="text-xs text-slate-400 mt-1">
                Fill a form and your answers to questions will appear here.
              </p>
            )}
          </div>
        ) : (
          filtered.map(row => (
            <div key={row.question}
              className="bg-slate-50 rounded-xl px-3 py-2.5 group">
              {/* Question */}
              <p className="text-xs text-slate-500 leading-relaxed break-words"
                title={row.question}>
                {row.question.length > 120 ? row.question.slice(0, 120) + '...' : row.question}
              </p>

              {/* Answer (editable) */}
              {editingQ === row.question ? (
                <div className="mt-1.5 flex gap-1.5">
                  <input
                    autoFocus
                    type="text"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingQ(null); }}
                    className="flex-1 px-2 py-1 text-xs border border-sky-300 rounded-md focus:outline-none focus:ring-1 focus:ring-sky-400 text-slate-800"
                  />
                  <button onClick={saveEdit}
                    className="px-2 py-1 text-xs bg-sky-500 text-white rounded-md hover:bg-sky-600">
                    Save
                  </button>
                  <button onClick={() => setEditingQ(null)}
                    className="px-2 py-1 text-xs bg-slate-200 text-slate-600 rounded-md hover:bg-slate-300">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="mt-1 flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-slate-800 truncate"
                      title={row.answer}>
                      {row.answer.length > 80 ? row.answer.slice(0, 80) + '...' : row.answer}
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
                    <button onClick={() => startEdit(row.question, row.answer)}
                      title="Edit answer"
                      className="p-1 rounded-md hover:bg-slate-200 text-slate-400 hover:text-slate-600">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button onClick={() => handleDelete(row.question)}
                      title="Delete answer"
                      className="p-1 rounded-md hover:bg-red-50 text-slate-400 hover:text-red-500">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
