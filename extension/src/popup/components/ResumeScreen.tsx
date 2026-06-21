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
      <div className="flex flex-col h-full">
        <div className="glass-header flex items-center gap-2 px-4 py-3">
          <button onClick={onBack} className="glass-btn-icon text-slate-600 hover:text-slate-800">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-slate-800">Resume Imported</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center px-4 gap-4">
          <div className="glass-card w-full px-6 py-8 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-100/80 flex items-center justify-center mb-3">
              <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-2xl font-bold text-emerald-600">{importCount}</p>
            <p className="text-sm text-slate-600 mt-0.5">profile entries created</p>
          </div>
          <button
            onClick={onBack}
            className="w-full py-2.5 text-sm font-semibold text-white bg-sky-500 hover:bg-sky-600 rounded-xl transition-colors shadow-sm shadow-sky-200"
          >
            View Profile
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass-header flex items-center gap-2 px-4 py-3">
        <button onClick={onBack} className="glass-btn-icon text-slate-600 hover:text-slate-800">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-800">Import Resume</p>
          <p className="text-xs text-slate-400">AI extracts your data automatically.</p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Mode tabs */}
        <div className="glass-card flex gap-1 p-1">
          {(['text', 'pdf'] as Mode[]).map(m => (
            <button key={m}
              onClick={() => { setMode(m); setError(''); }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                mode === m
                  ? 'bg-sky-500 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'
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
            className="w-full px-3 py-2 text-xs bg-white/60 border border-white/70 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-400 resize-none font-mono placeholder-slate-400"
          />
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-amber-700 bg-amber-50/80 border border-amber-100 rounded-lg px-3 py-2">
              PDF parsing requires <strong>Gemini</strong> as your AI provider.
            </p>
            <div
              onClick={() => fileRef.current?.click()}
              className="glass-card border-2 border-dashed border-sky-200/60 hover:border-sky-300 px-4 py-6 text-center cursor-pointer transition-colors hover:bg-white/50"
            >
              <svg className="w-8 h-8 text-slate-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-sm font-medium text-slate-600">
                {fileName || 'Click to select a PDF'}
              </p>
              {fileName && <p className="text-xs text-emerald-600 mt-1">Ready to import</p>}
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

        {error && (
          <div className="flex items-start gap-2 bg-red-50/80 border border-red-200/60 rounded-lg px-3 py-2">
            <svg className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd" />
            </svg>
            <p className="text-xs text-red-600">{error}</p>
          </div>
        )}

        <button
          onClick={handleImport}
          disabled={status === 'parsing'}
          className="w-full py-2.5 text-sm font-semibold text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-50 rounded-xl transition-colors shadow-sm shadow-sky-200"
        >
          {status === 'parsing' ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Parsing resume…
            </span>
          ) : 'Import Resume'}
        </button>
      </div>
    </div>
  );
}
