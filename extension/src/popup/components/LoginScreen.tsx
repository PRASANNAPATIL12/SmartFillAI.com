import React, { useState } from 'react';
import { sendToBackground } from '../utils/messages';

interface Props {
  onSuccess: (email: string) => void;
  onSkip:    () => void;
}

export default function LoginScreen({ onSuccess, onSkip }: Props): React.ReactElement {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');

  async function handleSignIn(): Promise<void> {
    if (!email.trim() || !password) { setError('Email and password are required.'); return; }
    setBusy(true); setError('');
    try {
      const result = await sendToBackground<{ email: string }>('SIGN_IN', {
        email: email.trim(),
        password,
      });
      onSuccess(result.email);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed. Check your credentials.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-base font-semibold text-slate-800">Sign in to SmartFillAI</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Sync your profile across devices. Your data is encrypted end-to-end.
        </p>
      </div>

      <div className="space-y-2">
        <input
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={e => { setEmail(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSignIn()}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400"
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={e => { setPassword(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSignIn()}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <button
        onClick={handleSignIn}
        disabled={busy}
        className="w-full py-2 text-sm font-medium text-white bg-sky-500 hover:bg-sky-600 disabled:opacity-50 rounded-lg transition-colors"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>

      <button
        onClick={onSkip}
        className="w-full py-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
      >
        Continue without signing in (local only)
      </button>
    </div>
  );
}
