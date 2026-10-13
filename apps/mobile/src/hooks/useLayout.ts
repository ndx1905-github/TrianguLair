import { useWindowDimensions } from 'react-native';

/**
 * Responsive layout derived from the window size (phones, tablets, foldables,
 * split screen). No fixed widths: everything is a fraction of the window.
 */
export function useLayout() {
  const { width, height, fontScale } = useWindowDimensions();
  // "Wide" = tablet, unfolded foldable, landscape phone with room for a side panel.
  const wide = width >= 700 && width > height * 0.9;
  return {
    width,
    height,
    fontScale,
    wide,
    /** Side gutter: 3% of width, clamped. */
    gutter: Math.round(Math.min(24, Math.max(10, width * 0.03))),
    /** Place sheet: full width on phones, side card on wide screens. */
    sheetWidth: wide ? Math.round(Math.min(width * 0.42, 520)) : width,
  };
}
