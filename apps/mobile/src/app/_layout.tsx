import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DataProvider } from '../data/DataProvider';
import { ThemeProvider, useIsDark, useUiColors } from '../hooks/useUiColors';
import { I18nProvider } from '../i18n';
import { AppStateProvider } from '../state/AppState';

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
          <DataProvider>
            <AppStateProvider>
              <ThemedStack />
            </AppStateProvider>
          </DataProvider>
        </ThemeProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
