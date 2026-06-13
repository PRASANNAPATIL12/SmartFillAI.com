import React, { useRef, useState } from 'react';
import type { ProfileEntry } from '@shared/types';
import { sendToBackground } from '../utils/messages';

interface Props {
  onBack:   () => void;
  onImport: (entries: ProfileEntry[]) => void;
}

type Mode = 'text' | 'pdf';
type Status = 'idle' | 'parsing' | 'done' | 'error';

export default function ResumeScreen({ onBack, onImport }: Props): React.ReactElement {
  const [mode,        setMode]        = useState<Mode>('text');
  const [text,        setText]        = useState('');
  const [fileName,    setFileName]    = useState('');
  const [pdfBase64,   setPdfBase64]   = useState('');
  const [status,      setStatus]      = useState<Status>('idle');
  const [error,       setError]       = useState('');
  const [importCount, setImportCount] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.pdf')) { setError('Please select a PDF file.'); return; }
    setFileName(file.name);
    setError('');

    const reader = new FileReader();
    reader.onload = () => {
      // result is a Data URL like "data:application/pdf;base64,..."
      const dataUrl = reader.result as string;
      const base64  = dataUrl.split(',')[1];
      setPdfBase64(base64);
    };
    reader.readAsDataURL(file);
  }

  async function handleImport(): Promise<void> {
    if (mode === 'text' && !text.trim()) { setError('Please paste your resume text.'); return; }
    if (mode === 'pdf'  && !pdfBase64)   { setError('Please select a PDF file.');       return; }

    setStatus('parsing');
    setError('');

    try {
      const payload = mode === 'pdf' ? { pdfBase64 } : { text };
      const result  = await sendToBackground<{ entries: ProfileEntry[] }>('PARSE_RESUME', payload);
      setImportCount(result.entries.length);
      setStatus('done');
      onImport(result.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parsing failed. Try again.');
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="text-slate-400 hover:text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-base font-semibold text-slate-800">Resume Imported</h1>
        </div>
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 text-center">
          <p className="text-2xl font-bold text-emerald-600">{importCount}</p>
          <p className="text-sm text-emerald-700">profile entries created</p>
        </div>
        <button onClick={onBack}
          className="w-full py-2 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 rounded-lg transition-colors">
          View Profile
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-600">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-base font-semibold text-slate-800">Import Resume</h1>
          <p className="text-xs text-slate-400">AI extracts your data into the profile automatically.</p>
        </div>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
        {(['text', 'pdf'] as Mode[]).map(m => (
          <button key={m}
            onClick={() => { setMode(m); setError(''); }}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
              mode === m ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {m === 'text' ? 'Paste Text' : 'Upload PDF'}
          </button>
        ))}
      </div>

      {mode === 'text' ? (
        <textarea
          value={text}
          onChange={e => { setText(e.target.value); setError(''); }}
          placeholder="Paste your resume text here…"
          rows={10}
          className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400 resize-none font-mono"
        />
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            PDF parsing requires <strong>Gemini</strong> as your AI provider.
          </p>
          <div
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-slate-200 hover:border-sky-300 rounded-xl p-6 text-center cursor-pointer transition-colors"
          >
            <p className="text-sm text-slate-500">
              {fileName || 'Click to select a PDF'}
            </p>
            {fileName && <p className="text-xs text-emerald-500 mt-1">Ready to import</p>}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,application/pdf"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <button
        onClick={handleImport}
        disabled={status === 'parsing'}
        className="w-full py-2.5 text-sm font-semibold text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-50 rounded-xl transition-colors"
      >
        {status === 'parsing' ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Parsing resume…
          </span>
        ) : 'Import Resume'}
      </button>
    </div>
  );
}
