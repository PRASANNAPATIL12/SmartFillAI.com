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
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <button onClick={onBack}
          className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors">
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
        <div className="mx-4 mt-3 px-3 py-2 bg-sky-50 text-sky-700 text-xs rounded-lg flex items-center gap-2">
          <span className="w-3 h-3 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
          Uploading & parsing...
        </div>
      )}
      {status === 'done' && (
        <div className="mx-4 mt-3 px-3 py-2 bg-emerald-50 text-emerald-700 text-xs rounded-lg">
          Document uploaded successfully.
        </div>
      )}
      {status === 'error' && error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-50 text-red-700 text-xs rounded-lg">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Resume section */}
        <DocTypeSection
          label={DOC_TYPE_LABELS.resume}
          docs={resumes}
          onUpload={() => handleUpload('resume')}
          onDelete={handleDelete}
          onSetDefault={handleSetDefault}
        />

        {/* Cover Letter section */}
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
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
        <button onClick={onUpload}
          className="text-xs text-sky-500 hover:underline font-medium">
          {docs.length === 0 ? 'Upload' : 'Add'}
        </button>
      </div>

      {docs.length === 0 ? (
        <div className="bg-slate-50 rounded-xl p-3 text-center">
          <p className="text-xs text-slate-400">
            No {label.toLowerCase()} uploaded yet.
          </p>
          <button onClick={onUpload}
            className="mt-1.5 text-xs text-sky-500 font-medium hover:underline">
            Upload {label.split(' ')[0]}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map(doc => (
            <div key={doc.id}
              className="bg-slate-50 rounded-xl px-3 py-2 flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-medium text-slate-700 truncate">{doc.fileName}</p>
                  {doc.isDefault && (
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                      default
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  {humanSize(doc.fileSize)} &middot; {timeAgo(doc.updatedAt)}
                </p>
              </div>
              <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                {!doc.isDefault && (
                  <button onClick={() => onSetDefault(doc.id)} title="Set as default"
                    className="p-1 rounded-md hover:bg-slate-200 text-slate-400 hover:text-emerald-600 transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                )}
                <button onClick={() => onDelete(doc.id)} title="Delete"
                  className="p-1 rounded-md hover:bg-slate-200 text-slate-400 hover:text-red-500 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
