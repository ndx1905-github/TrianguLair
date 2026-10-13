/** UI colors for light and dark mode (system setting). */
export interface UiColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  scrim: string;
  shadow: string;
}

export const LIGHT: UiColors = {
  background: '#F5F5F4',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F5F9',
  text: '#0F172A',
  textMuted: '#64748B',
  border: '#E2E8F0',
  accent: '#2563EB',
  scrim: 'rgba(15,23,42,0.25)',
  shadow: '#000000',
};

export const DARK: UiColors = {
  background: '#0B0F14',
  surface: '#161B22',
  surfaceAlt: '#1F2630',
  text: '#F1F5F9',
  textMuted: '#94A3B8',
  border: '#2D3748',
  accent: '#60A5FA',
  scrim: 'rgba(0,0,0,0.45)',
  shadow: '#000000',
};
