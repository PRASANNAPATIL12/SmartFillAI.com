import React, { useState } from 'react';
import { sendToBackground } from '../utils/messages';

interface Props {
  onSuccess: (email: string) => void;
  onSkip:    () => void;
}

type Mode = 'signin' | 'signup';

export default function LoginScreen({ onSuccess, onSkip }: Props): React.ReactElement {
  const [mode,      setMode]     = useState<Mode>('signin');
  const [email,     setEmail]    = useState('');
  const [password,  setPassword] = useState('');
  const [showPass,  setShowPass] = useState(false);
  const [busy,      setBusy]     = useState(false);
  const [error,     setError]    = useState('');

  function switchMode(next: Mode): void {
    setMode(next);
    setError('');
    setPassword('');
    setShowPass(false);
  }

  async function handleSubmit(): Promise<void> {
    if (!email.trim()) { setError('Please enter your email.'); return; }
    if (!password)     { setError('Please enter your password.'); return; }
    if (mode === 'signup' && password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const msgType = mode === 'signup' ? 'SIGN_UP' : 'SIGN_IN';
      const result = await sendToBackground<{ email: string }>(msgType, {
        email: email.trim(),
        password,
      });
      onSuccess(result.email);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Invalid login credentials')) {
        setError('Incorrect email or password.');
      } else if (msg.includes('already registered') || msg.includes('already been registered')) {
        setError('Account already exists — sign in instead.');
      } else if (msg.includes('check your email')) {
        setError('Account created! Check your email to confirm, then sign in.');
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  const isSignUp = mode === 'signup';

  return (
    <div className="flex flex-col h-full">
      {/* Branding header */}
      <div className="glass-header px-5 pt-5 pb-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg font-bold text-slate-800 tracking-tight">SmartFillAI</span>
          <span className="text-xs bg-sky-100/80 text-sky-700 px-2 py-0.5 rounded-full font-medium">Cloud Sync</span>
        </div>
        <h2 className="text-sm font-semibold text-slate-700">
          {isSignUp ? 'Create your account' : 'Welcome back'}
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {isSignUp
            ? 'Save your profile and sync it across all your devices.'
            : 'Sign in to access your profile from any device.'}
        </p>
      </div>

      {/* Form */}
      <div className="flex-1 px-4 py-4 space-y-3">
        <div className="glass-card p-4 space-y-3">
          {/* Email */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Email</label>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              disabled={busy}
              className="w-full px-3 py-2 text-sm bg-white/60 border border-white/70 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 disabled:opacity-60 placeholder-slate-400"
            />
          </div>

          {/* Password with show/hide */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Password</label>
            <div className="relative">
              <input
                type={showPass ? 'text' : 'password'}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                placeholder={isSignUp ? 'Min 6 characters' : 'Your password'}
                value={password}
                onChange={e => { setPassword(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                disabled={busy}
                className="w-full px-3 py-2 pr-10 text-sm bg-white/60 border border-white/70 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 disabled:opacity-60 placeholder-slate-400"
              />
              <button
                type="button"
                onClick={() => setShowPass(v => !v)}
                tabIndex={-1}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                {showPass ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
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
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={busy}
          className="w-full py-2.5 text-sm font-semibold text-white bg-sky-500 hover:bg-sky-600 active:bg-sky-700 disabled:opacity-50 rounded-xl transition-colors shadow-sm shadow-sky-200 flex items-center justify-center gap-2"
        >
          {busy && <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {busy
            ? (isSignUp ? 'Creating account…' : 'Signing in…')
            : (isSignUp ? 'Create account' : 'Sign in')}
        </button>

        {/* Mode switch */}
        <div className="text-center">
          {isSignUp ? (
            <button onClick={() => switchMode('signin')}
              className="text-xs text-sky-600 hover:underline transition-colors">
              Already have an account? <span className="font-medium">Sign in</span>
            </button>
          ) : (
            <button onClick={() => switchMode('signup')}
              className="text-xs text-sky-600 hover:underline transition-colors">
              New here? <span className="font-medium">Create a free account</span>
            </button>
          )}
        </div>
      </div>

      {/* Local-only escape */}
      <div className="glass-header px-5 pb-4 pt-3">
        <button
          onClick={onSkip}
          className="w-full py-2 text-xs text-slate-400 hover:text-slate-600 hover:bg-white/40 rounded-lg transition-colors"
        >
          Continue without an account (local only)
        </button>
      </div>
    </div>
  );
}
