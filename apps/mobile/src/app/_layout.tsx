import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useUiColors } from '../hooks/useUiColors';

export default function RootLayout() {
  const c = useUiColors();
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: c.background },
        }}
      />
    </SafeAreaProvider>
  );
}
