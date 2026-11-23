import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { getSetting, setSetting } from '../data/deviceSettings';
import { DARK, LIGHT, type UiColors } from '../theme/colors';
import { resolveDark, type ThemeMode } from '../theme/themeMode';

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  dark: boolean;
}

const ThemeContext = createContext<ThemeState | null>(null);

function savedMode(): ThemeMode {
  const v = getSetting('theme');
  return v === 'light' || v === 'dark' ? v : 'auto';
}

/** Holds the theme preference (auto / light / dark), kept per device. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(savedMode);
  const value = useMemo(
    () => ({
      mode,
      setMode: (m: ThemeMode) => {
        setSetting('theme', m);
        setModeState(m);
      },
      dark: resolveDark(mode, system),
    }),
    [mode, system],
  );
  const dark = value.dark;
  // Web app: the browser's bars (the iPhone status bar of a Home Screen app, Android's address bar)
  // take the app's theme, also when it differs from the system's (the page's meta follow the system).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const color = (dark ? DARK : LIGHT).background;
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (metas.length === 0) {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      document.head.appendChild(m);
      m.content = color;
      return;
    }
    metas.forEach((m) => {
      m.removeAttribute('media');
      m.content = color;
    });
  }, [dark]);
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
