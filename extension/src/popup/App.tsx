import React, { useEffect, useState } from 'react';
import { sendToBackground } from './utils/messages';
import LoginScreen    from './components/LoginScreen';
import HomeScreen     from './components/HomeScreen';
import ProfileScreen  from './components/ProfileScreen';
import SettingsScreen from './components/SettingsScreen';
import ResumeScreen    from './components/ResumeScreen';
import DocumentsScreen from './components/DocumentsScreen';
import AnswersScreen   from './components/AnswersScreen';

type Screen = 'loading' | 'login' | 'home' | 'profile' | 'settings' | 'resume' | 'documents' | 'answers';

interface SessionInfo {
  userId:    string;
  email:     string;
  expiresAt: number;
}

/**
 * Subpages (profile, settings, etc.) need a definite parent height so
 * their internal `flex-1 overflow-y-auto` scroll containers work correctly.
 * We match the home screen's natural content height (~520px) so the popup
 * size stays consistent when switching screens.
 */
function SubpageFrame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ height: '520px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {children}
    </div>
  );
}

export default function App(): React.ReactElement {
  const [screen,  setScreen]  = useState<Screen>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);

  useEffect(() => {
    async function bootstrap(): Promise<void> {
      let hasSession = false;
      try {
        const s = await sendToBackground<SessionInfo | null>('GET_SESSION');
        setSession(s);
        hasSession = !!s;
      } catch { /* app works without a session */ }

      // On first install (no session + empty profile), show login to encourage sign-in.
      // If the user has local data but no session, respect local-only mode — go to home.
      if (!hasSession) {
        try {
          const profile = await sendToBackground<{ id: string }[]>('GET_PROFILE');
          if (profile.length === 0) {
            setScreen('login');
            return;
          }
        } catch { /* fall through to home */ }
      }

      setScreen('home');
    }
    bootstrap();
  }, []);

  function handleLoginSuccess(email: string): void {
    sendToBackground<SessionInfo | null>('GET_SESSION').then(s => setSession(s)).catch(() => {});
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
      <SubpageFrame>
        <LoginScreen
          onSuccess={handleLoginSuccess}
          onSkip={() => setScreen('home')}
        />
      </SubpageFrame>
    );
  }

  if (screen === 'profile') {
    return (
      <SubpageFrame>
        <ProfileScreen
          onBack={() => setScreen('home')}
          onGoResume={() => setScreen('resume')}
        />
      </SubpageFrame>
    );
  }

  if (screen === 'resume') {
    return (
      <SubpageFrame>
        <ResumeScreen
          onBack={() => setScreen('profile')}
          onImport={() => setScreen('profile')}
        />
      </SubpageFrame>
    );
  }

  if (screen === 'documents') {
    return (
      <SubpageFrame>
        <DocumentsScreen onBack={() => setScreen('home')} />
      </SubpageFrame>
    );
  }

  if (screen === 'answers') {
    return (
      <SubpageFrame>
        <AnswersScreen onBack={() => setScreen('home')} />
      </SubpageFrame>
    );
  }

  if (screen === 'settings') {
    return (
      <SubpageFrame>
        <SettingsScreen onBack={() => setScreen('home')} />
      </SubpageFrame>
    );
  }

  // Home screen — no wrapper, auto-sizes to its natural content height
  return (
    <HomeScreen
      session={session}
      onGoProfile={() => setScreen('profile')}
      onGoSettings={() => setScreen('settings')}
      onGoDocuments={() => setScreen('documents')}
      onGoAnswers={() => setScreen('answers')}
      onGoLogin={() => setScreen('login')}
      onSignOut={handleSignOut}
    />
  );
}
