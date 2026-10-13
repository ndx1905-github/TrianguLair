import { useColorScheme } from 'react-native';

import { DARK, LIGHT, type UiColors } from '../theme/colors';

export function useIsDark(): boolean {
  return useColorScheme() === 'dark';
}

export function useUiColors(): UiColors {
  return useIsDark() ? DARK : LIGHT;
}
