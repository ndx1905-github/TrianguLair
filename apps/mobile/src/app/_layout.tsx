import '../polyfills';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ContactsProvider } from '../contacts/ContactsProvider';
import { PendingInvitation } from '../contacts/PendingInvitation';
import { DataProvider } from '../data/DataProvider';
import { ThemeProvider, useIsDark, useUiColors } from '../hooks/useUiColors';
import { I18nProvider } from '../i18n';
import { IdentityProvider } from '../identity/IdentityProvider';
import { LockProvider } from '../identity/LockGate';
import { PwaUpdatePrompt } from '../pwa/UpdatePrompt';
import { AppStateProvider } from '../state/AppState';
import { StorageProvider } from '../storage/StorageProvider';
import { SyncProvider } from '../sync/SyncProvider';

function ThemedStack() {
  const c = useUiColors();
  const dark = useIsDark();
  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: c.background },
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <ThemeProvider>
          <IdentityProvider>
            <StorageProvider>
            <DataProvider>
              <SyncProvider>
              <AppStateProvider>
                <ContactsProvider>
                  <LockProvider>
                    <ThemedStack />
                    <PendingInvitation />
                    <PwaUpdatePrompt />
                  </LockProvider>
                </ContactsProvider>
              </AppStateProvider>
              </SyncProvider>
            </DataProvider>
            </StorageProvider>
          </IdentityProvider>
        </ThemeProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
