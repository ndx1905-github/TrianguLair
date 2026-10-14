import { useWindowDimensions } from 'react-native';

import { computeLayout } from '../theme/layout';

/**
 * Responsive layout derived from the window size (phones, tablets, foldables,
 * split screen, Display Zoom). Recomputed on every window change, so folding
 * or resizing only changes the layout, never the state.
 */
export function useLayout() {
  const { width, height, fontScale } = useWindowDimensions();
  return { ...computeLayout(width, height), fontScale };
}
