import React, { useEffect, useState } from 'react';
import type { ProfileEntry } from '@shared/types';
import { sendToBackground } from '../utils/messages';
import type { NewEntryData } from '../../background/profile-store';
import {
  CANONICAL_KEY_OPTIONS,
  CATEGORY_LABELS,
  getKeyLabel,
  type EntryCategory,
} from '../utils/canonicalKeys';

interface Props {
  onBack: () => void;
}

type Mode = 'list' | 'add' | 'edit';

interface EntryForm {
  canonical_key: string;
  display_label: string;
  value: string;
  category: EntryCategory;
  sensitive: boolean;
}

const DEFAULT_FORM: EntryForm = {
  canonical_key: 'email',
  display_label: 'Email Address',
  value: '',
  category: 'contact',
  sensitive: false,
};

const CATEGORY_ORDER: EntryCategory[] = ['contact', 'identity', 'education', 'work', 'social', 'other'];

function maskValue(value: string): string {
  if (value.length <= 4) return '••••';
  return value.slice(0, 2) + '•'.repeat(Math.min(value.length - 4, 8)) + value.slice(-2);
}

export default function ProfileScreen({ onBack }: Props): React.ReactElement {
  const [entries, setEntries] = useState<ProfileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EntryForm>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadEntries();
  }, []);

  async function loadEntries(): Promise<void> {
    try {
      const data = await sendToBackground<ProfileEntry[]>('GET_PROFILE');
      setEntries(data);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  function openAdd(): void {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setError('');
    setMode('add');
  }

  function openEdit(entry: ProfileEntry): void {
    setForm({
      canonical_key: entry.canonical_key,
      display_label: entry.display_label,
      value: entry.value,
      category: (CATEGORY_LABELS[entry.category as EntryCategory] ? entry.category : 'other') as EntryCategory,
      sensitive: entry.sensitive,
    });
    setEditingId(entry.id);
    setError('');
    setMode('edit');
  }

  function cancelForm(): void {
    setMode('list');
    setEditingId(null);
    setError('');
  }

  async function handleSave(): Promise<void> {
    if (!form.value.trim()) {
      setError('Value cannot be empty.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (mode === 'add') {
        const data: NewEntryData = {
          canonical_key: form.canonical_key,
          display_label: form.display_label || getKeyLabel(form.canonical_key),
          aliases: [],
          value: form.value.trim(),
          category: form.category,
          source: 'manual',
          sensitive: form.sensitive,
        };
        const created = await sendToBackground<ProfileEntry>('ADD_ENTRY', data);
        setEntries(prev => [...prev, created]);
      } else if (mode === 'edit' && editingId) {
        const updated = await sendToBackground<ProfileEntry>('UPDATE_ENTRY', {
          id: editingId,
          patch: {
            display_label: form.display_label || getKeyLabel(form.canonical_key),
            value: form.value.trim(),
            category: form.category,
            sensitive: form.sensitive,
          },
        });
        setEntries(prev => prev.map(e => (e.id === editingId ? updated : e)));
      }
      setMode('list');
      setEditingId(null);
    } catch {
      setError('Failed to save entry.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm('Delete this entry?')) return;
    try {
      await sendToBackground('DELETE_ENTRY', { id });
      setEntries(prev => prev.filter(e => e.id !== id));
    } catch {
      // silent fail — entry stays visible until next reload
    }
  }

  // Update display_label automatically when canonical_key changes (only if user hasn't customized it)
  function handleKeyChange(key: string): void {
    const option = CANONICAL_KEY_OPTIONS.find(o => o.key === key);
    setForm(f => ({
      ...f,
      canonical_key: key,
      display_label: option?.label ?? f.display_label,
      category: option?.category ?? f.category,
    }));
  }

  // Group entries by category in defined order
  const grouped = CATEGORY_ORDER.reduce<Record<string, ProfileEntry[]>>((acc, cat) => {
    const cat_entries = entries.filter(e => e.category === cat);
    if (cat_entries.length > 0) acc[cat] = cat_entries;
    return acc;
  }, {});
  // Append entries with unrecognised categories
  entries.forEach(e => {
    if (!CATEGORY_ORDER.includes(e.category as EntryCategory)) {
      (grouped['other'] ??= []).push(e);
    }
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <button
          onClick={mode !== 'list' ? cancelForm : onBack}
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {mode !== 'list' ? 'Cancel' : 'Back'}
        </button>
        <span className="text-sm font-semibold text-slate-700">
          {mode === 'add' ? 'Add Entry' : mode === 'edit' ? 'Edit Entry' : `Profile (${entries.length})`}
        </span>
        {mode === 'list' && (
          <button
            onClick={openAdd}
            className="text-sm text-sky-500 font-medium hover:text-sky-600"
          >
            + Add
          </button>
        )}
        {mode !== 'list' && <div className="w-10" />}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">

        {/* Entry form (add or edit) */}
        {(mode === 'add' || mode === 'edit') && (
          <div className="px-4 py-3 space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Field Type</label>
              <select
                value={form.canonical_key}
                onChange={e => handleKeyChange(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-sky-400 bg-white"
              >
                {CANONICAL_KEY_OPTIONS.map(o => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Display Label</label>
              <input
                type="text"
                value={form.display_label}
                onChange={e => setForm(f => ({ ...f, display_label: e.target.value }))}
                placeholder="e.g. Work Email"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-sky-400"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">Value</label>
              <input
                type={form.sensitive ? 'password' : 'text'}
                autoComplete="off"
                value={form.value}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                placeholder="Enter value…"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-sky-400"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-600">Mark as sensitive</label>
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, sensitive: !f.sensitive }))}
                className={`relative w-9 h-5 rounded-full transition-colors ${form.sensitive ? 'bg-sky-500' : 'bg-slate-200'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.sensitive ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-2 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-50 rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : mode === 'add' ? 'Add Entry' : 'Save Changes'}
            </button>
          </div>
        )}

        {/* Entry list */}
        {mode === 'list' && (
          <div className="pb-4">
            {loading && (
              <div className="flex justify-center py-8">
                <div className="w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
              </div>
            )}

            {!loading && entries.length === 0 && (
              <div className="flex flex-col items-center py-10 px-4 text-center">
                <p className="text-sm text-slate-500">Your profile is empty.</p>
                <p className="text-xs text-slate-400 mt-1">
                  Add entries and Ditto will fill them into forms automatically.
                </p>
                <button
                  onClick={openAdd}
                  className="mt-3 px-4 py-1.5 text-sm text-white bg-sky-500 hover:bg-sky-600 rounded-lg"
                >
                  Add First Entry
                </button>
              </div>
            )}

            {!loading && Object.entries(grouped).map(([cat, catEntries]) => (
              <div key={cat}>
                <p className="px-4 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide bg-slate-50 border-b border-slate-100">
                  {CATEGORY_LABELS[cat as EntryCategory] ?? cat}
                </p>
                {catEntries.map(entry => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-50 hover:bg-slate-50 group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-700 truncate">{entry.display_label}</p>
                      <p className="text-xs text-slate-400 truncate">
                        {entry.sensitive ? maskValue(entry.value) : entry.value}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => openEdit(entry)}
                        title="Edit"
                        className="p-1.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(entry.id)}
                        title="Delete"
                        className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
