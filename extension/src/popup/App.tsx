import React, { useEffect, useState } from 'react';
import type { AIProviderName } from '@/ai-providers';
import { getProviderConfig } from '@/ai-providers';
import { sendToBackground } from './utils/messages';
import LoginScreen    from './components/LoginScreen';
import HomeScreen     from './components/HomeScreen';
import ProfileScreen  from './components/ProfileScreen';
import SettingsScreen from './components/SettingsScreen';
import ResumeScreen    from './components/ResumeScreen';
import DocumentsScreen from './components/DocumentsScreen';

type Screen = 'loading' | 'login' | 'home' | 'profile' | 'settings' | 'resume' | 'documents';

interface SessionInfo {
  userId:    string;
  email:     string;
  expiresAt: number;
}

export default function App(): React.ReactElement {
  const [screen,   setScreen]   = useState<Screen>('loading');
  const [provider, setProvider] = useState<AIProviderName>('gemini');
  const [session,  setSession]  = useState<SessionInfo | null>(null);

  useEffect(() => {
    async function bootstrap(): Promise<void> {
      // AI key is bundled at build time — there's no setup/key-entry step.
      // Go straight to home; just read the provider for the header badge and
      // check for an optional cloud session.
      try {
        const cfg = await getProviderConfig();
        setProvider(cfg.provider);
      } catch { /* fall back to default provider badge */ }

      try {
        const s = await sendToBackground<SessionInfo | null>('GET_SESSION');
        setSession(s);
      } catch { /* app works without a session */ }

      setScreen('home');
    }
    bootstrap();
  }, []);

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
    return <SettingsScreen onBack={() => setScreen('home')} />;
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
