import React, { useEffect, useState } from 'react';
import type { AIProviderName } from '@/ai-providers';
import { getProviderConfig, getAPIKey } from '@/ai-providers';
import SetupScreen from './components/SetupScreen';
import HomeScreen from './components/HomeScreen';
import ProfileScreen from './components/ProfileScreen';
import SettingsScreen from './components/SettingsScreen';

type Screen = 'loading' | 'setup' | 'home' | 'profile' | 'settings';

export default function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>('loading');
  const [provider, setProvider] = useState<AIProviderName>('groq');

  useEffect(() => {
    async function bootstrap(): Promise<void> {
      try {
        const cfg = await getProviderConfig();
        setProvider(cfg.provider);
        const key = await getAPIKey(cfg.provider);
        setScreen(key ? 'home' : 'setup');
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

  function handleProviderChange(p: AIProviderName): void {
    setProvider(p);
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

  if (screen === 'profile') {
    return <ProfileScreen onBack={() => setScreen('home')} />;
  }

  if (screen === 'settings') {
    return (
      <SettingsScreen
        provider={provider}
        onBack={() => setScreen('home')}
        onProviderChange={handleProviderChange}
      />
    );
  }

  // home
  return (
    <HomeScreen
      provider={provider}
      onGoProfile={() => setScreen('profile')}
      onGoSettings={() => setScreen('settings')}
    />
  );
}
