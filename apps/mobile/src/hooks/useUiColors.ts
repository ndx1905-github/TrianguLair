import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { DARK, LIGHT, type UiColors } from '../theme/colors';
import { resolveDark, type ThemeMode } from '../theme/themeMode';

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  dark: boolean;
}

const ThemeContext = createContext<ThemeState | null>(null);

/**
 * Holds the theme preference (auto / light / dark). Phase 0: in memory only;
 * persistence comes with the settings screen (T-118).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>('auto');
  const value = useMemo(
    () => ({ mode, setMode, dark: resolveDark(mode, system) }),
    [mode, system],
  );
  return createElement(ThemeContext.Provider, { value }, children);
}

export function useThemeMode(): ThemeState {
  const ctx = useContext(ThemeContext);
  const system = useColorScheme();
  // Outside a provider: follow the system, preference cannot be changed.
  return ctx ?? { mode: 'auto', setMode: () => {}, dark: system === 'dark' };
}

export function useIsDark(): boolean {
  return useThemeMode().dark;
}

export function useUiColors(): UiColors {
  return useIsDark() ? DARK : LIGHT;
}
