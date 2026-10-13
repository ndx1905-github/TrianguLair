/**
 * Theme preference: follow the system ("auto") or force light / dark.
 * Pure logic, unit-tested.
 */
export type ThemeMode = 'auto' | 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['auto', 'light', 'dark'];

/** Resolve the effective scheme from the user preference and the system scheme. */
export function resolveDark(mode: ThemeMode, system: string | null | undefined): boolean {
  if (mode === 'auto') return system === 'dark';
  return mode === 'dark';
}

/** Next mode when cycling with a single button: auto -> light -> dark -> auto. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const i = THEME_MODES.indexOf(mode);
  return THEME_MODES[(i + 1) % THEME_MODES.length]!;
}

export const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
};
