import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentMeta, DocumentType } from '@shared/types';
import { sendToBackground } from '../utils/messages';

interface Props {
  onBack: () => void;
}

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  resume: 'Resume / CV',
  cover_letter: 'Cover Letter',
};

const ACCEPT = '.pdf,.doc,.docx,.txt,.rtf';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function DocumentsScreen({ onBack }: Props): React.ReactElement {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [error, setError] = useState('');
  const [uploadType, setUploadType] = useState<DocumentType>('resume');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await sendToBackground<DocumentMeta[]>('GET_DOCUMENTS');
      setDocs(list);
    } catch {
      setDocs([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = useCallback(async (docType: DocumentType) => {
    setUploadType(docType);
    fileRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (file.size > 10 * 1024 * 1024) {
      setError('File exceeds 10 MB limit.');
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
      return;
    }

    setStatus('uploading');
    setError('');

    try {
      const buffer = await file.arrayBuffer();
      const binary = new Uint8Array(buffer);
      let str = '';
      for (let i = 0; i < binary.length; i++) str += String.fromCharCode(binary[i]);
      const fileDataBase64 = btoa(str);

      await sendToBackground('UPLOAD_DOCUMENT', {
        docType: uploadType,
        label: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileDataBase64,
      });

      setStatus('done');
      await refresh();
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  }, [uploadType, refresh]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await sendToBackground('DELETE_DOCUMENT', { id });
      await refresh();
    } catch { /* ignore */ }
  }, [refresh]);

  const handleSetDefault = useCallback(async (id: string) => {
    try {
      await sendToBackground('UPDATE_DOCUMENT_META', { id, patch: { isDefault: true } });
      await refresh();
    } catch { /* ignore */ }
  }, [refresh]);

  const resumes = docs.filter(d => d.docType === 'resume');
  const coverLetters = docs.filter(d => d.docType === 'cover_letter');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="glass-header flex items-center gap-2 px-4 py-3">
        <button
          onClick={onBack}
          className="glass-btn-icon text-slate-600 hover:text-slate-800"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-slate-800">Documents</span>
      </div>

      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={handleFileChange} />

      {/* Status banner */}
      {status === 'uploading' && (
        <div className="mx-3 mt-3 px-3 py-2 bg-sky-50/80 border border-sky-100 text-sky-700 text-xs rounded-xl flex items-center gap-2">
          <span className="w-3 h-3 border-2 border-sky-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          Uploading &amp; parsing…
        </div>
      )}
      {status === 'done' && (
        <div className="mx-3 mt-3 px-3 py-2 bg-emerald-50/80 border border-emerald-100 text-emerald-700 text-xs rounded-xl flex items-center gap-2">
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Uploaded successfully.
        </div>
      )}
      {status === 'error' && error && (
        <div className="mx-3 mt-3 px-3 py-2 bg-red-50/80 border border-red-100 text-red-700 text-xs rounded-xl">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        <DocTypeSection
          label={DOC_TYPE_LABELS.resume}
          docs={resumes}
          onUpload={() => handleUpload('resume')}
          onDelete={handleDelete}
          onSetDefault={handleSetDefault}
        />
        <DocTypeSection
          label={DOC_TYPE_LABELS.cover_letter}
          docs={coverLetters}
          onUpload={() => handleUpload('cover_letter')}
          onDelete={handleDelete}
          onSetDefault={handleSetDefault}
        />
      </div>
    </div>
  );
}

function DocTypeSection({ label, docs, onUpload, onDelete, onSetDefault }: {
  label: string;
  docs: DocumentMeta[];
  onUpload: () => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
}): React.ReactElement {
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
        <button
          onClick={onUpload}
          className="text-xs font-medium text-sky-600 hover:text-sky-700 transition-colors"
        >
          {docs.length === 0 ? 'Upload' : 'Add'}
        </button>
      </div>

      {docs.length === 0 ? (
        /* Empty state */
        <div className="glass-card px-4 py-5 flex flex-col items-center text-center">
          <div className="w-9 h-9 rounded-xl bg-slate-100/70 flex items-center justify-center mb-2">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-xs text-slate-400 mb-2">No {label.toLowerCase()} uploaded yet.</p>
          <button
            onClick={onUpload}
            className="text-xs font-semibold text-sky-600 hover:text-sky-700 bg-sky-50/80 hover:bg-sky-100/80 px-3 py-1.5 rounded-lg transition-colors border border-sky-100"
          >
            Upload {label.split(' ')[0]}
          </button>
        </div>
      ) : (
        /* Document list */
        <div className="glass-card overflow-hidden">
          {docs.map((doc, idx) => (
            <div
              key={doc.id}
              className={`flex items-center gap-3 px-4 py-3 hover:bg-white/50 transition-colors group ${
                idx < docs.length - 1 ? 'border-b border-white/40' : ''
              }`}
            >
              {/* File icon */}
              <div className="w-8 h-8 rounded-lg bg-sky-50/80 flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-sky-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>

              {/* File info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="text-sm font-medium text-slate-700 truncate">{doc.fileName}</p>
                  {doc.isDefault && (
                    <span className="text-[10px] font-semibold bg-emerald-100/80 text-emerald-700 px-1.5 py-0.5 rounded-full whitespace-nowrap border border-emerald-200/50">
                      default
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  {humanSize(doc.fileSize)} · {timeAgo(doc.updatedAt)}
                </p>
              </div>

              {/* Actions / inline confirmation */}
              {deletingId === doc.id ? (
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => setDeletingId(null)}
                    className="px-2 py-1 text-xs bg-white/60 border border-white/70 text-slate-600 rounded-lg hover:bg-white/80 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { onDelete(doc.id); setDeletingId(null); }}
                    className="px-2 py-1 text-xs bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  {!doc.isDefault && (
                    <button
                      onClick={() => onSetDefault(doc.id)}
                      title="Set as default"
                      className="p-1.5 rounded-lg hover:bg-emerald-50/80 text-slate-400 hover:text-emerald-600 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => setDeletingId(doc.id)}
                    title="Delete"
                    className="p-1.5 rounded-lg hover:bg-red-50/60 text-slate-400 hover:text-red-500 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
