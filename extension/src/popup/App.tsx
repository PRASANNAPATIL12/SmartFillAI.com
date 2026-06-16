import React, { useEffect, useState } from 'react';
import type { AIProviderName } from '@/ai-providers';
import { getProviderConfig, getAPIKey } from '@/ai-providers';
import { sendToBackground } from './utils/messages';
import SetupScreen    from './components/SetupScreen';
import LoginScreen    from './components/LoginScreen';
import HomeScreen     from './components/HomeScreen';
import ProfileScreen  from './components/ProfileScreen';
import SettingsScreen from './components/SettingsScreen';
import ResumeScreen    from './components/ResumeScreen';
import DocumentsScreen from './components/DocumentsScreen';

type Screen = 'loading' | 'setup' | 'login' | 'home' | 'profile' | 'settings' | 'resume' | 'documents';

interface SessionInfo {
  userId:    string;
  email:     string;
  expiresAt: number;
}

export default function App(): React.ReactElement {
  const [screen,   setScreen]   = useState<Screen>('loading');
  const [provider, setProvider] = useState<AIProviderName>('groq');
  const [session,  setSession]  = useState<SessionInfo | null>(null);

  useEffect(() => {
    async function bootstrap(): Promise<void> {
      try {
        const cfg = await getProviderConfig();
        setProvider(cfg.provider);
        const key = await getAPIKey(cfg.provider);
        if (!key) { setScreen('setup'); return; }

        // Check cloud session (optional — app works without it)
        const s = await sendToBackground<SessionInfo | null>('GET_SESSION');
        setSession(s);
        setScreen('home');
      } catch {
        setScreen('setup');
      }
    }
    bootstrap();
  }, []);

  function handleSetupDone(p: AIProviderName): void {
    setProvider(p);
    setScreen('home');
  }

  function handleLoginSuccess(email: string): void {
    sendToBackground<SessionInfo | null>('GET_SESSION').then(s => setSession(s)).catch(() => {});
    // Suppress unused-var warning for email — it's used to keep the callback signature clear
    void email;
    setScreen('home');
  }

  function handleSignOut(): void {
    sendToBackground('SIGN_OUT').catch(() => {});
    setSession(null);
  }

  if (screen === 'loading') {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (screen === 'setup') {
    return <SetupScreen initialProvider={provider} onDone={handleSetupDone} />;
  }

  if (screen === 'login') {
    return (
      <LoginScreen
        onSuccess={handleLoginSuccess}
        onSkip={() => setScreen('home')}
      />
    );
  }

  if (screen === 'profile') {
    return (
      <ProfileScreen
        onBack={() => setScreen('home')}
        onGoResume={() => setScreen('resume')}
      />
    );
  }

  if (screen === 'resume') {
    return (
      <ResumeScreen
        onBack={() => setScreen('profile')}
        onImport={() => setScreen('profile')}
      />
    );
  }

  if (screen === 'documents') {
    return <DocumentsScreen onBack={() => setScreen('home')} />;
  }

  if (screen === 'settings') {
    return (
      <SettingsScreen
        provider={provider}
        onBack={() => setScreen('home')}
        onProviderChange={p => setProvider(p)}
      />
    );
  }

  return (
    <HomeScreen
      provider={provider}
      session={session}
      onGoProfile={() => setScreen('profile')}
      onGoSettings={() => setScreen('settings')}
      onGoDocuments={() => setScreen('documents')}
      onGoLogin={() => setScreen('login')}
      onSignOut={handleSignOut}
    />
  );
}
