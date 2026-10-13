/**
 * Window-size classes, loosely following Material 3 breakpoints
 * (compact < 600 dp <= medium < 840 dp <= expanded). Pure logic, unit-tested.
 *
 * - compact: phones in portrait, outer screens of foldables, narrow split views.
 *   Filter chips scroll sideways, the place card is a bottom sheet.
 * - medium / expanded ("wide"): tablets, unfolded foldables, phones in
 *   landscape. The filter bar is a floating panel and the place card opens as
 *   a side panel next to the map (spec "Screen adaptation").
 */
export type SizeClass = 'compact' | 'medium' | 'expanded';

export interface Layout {
  width: number;
  height: number;
  sizeClass: SizeClass;
  /** Side panel instead of bottom sheet. */
  wide: boolean;
  /** Side gutter in points. */
  gutter: number;
  /** Width of the place card (full width on compact screens). */
  sheetWidth: number;
  /** Max width of the floating filter panel on wide screens. */
  filterMaxWidth: number;
}

export function sizeClassOf(width: number): SizeClass {
  if (width >= 840) return 'expanded';
  if (width >= 600) return 'medium';
  return 'compact';
}

export function computeLayout(width: number, height: number): Layout {
  const sizeClass = sizeClassOf(width);
  // A medium-width but very tall window (e.g. tall split view) still gets a
  // bottom sheet: a side panel would leave too little map.
  const wide = sizeClass === 'expanded' || (sizeClass === 'medium' && width >= height * 0.7);
  const gutter = Math.round(Math.min(24, Math.max(10, width * 0.03)));
  const sheetWidth = wide ? Math.round(Math.max(300, Math.min(width * 0.38, 440))) : width;
  // Leave room for the side panel so the filter panel never sits under it.
  const filterMaxWidth = wide
    ? Math.max(260, Math.min(Math.round(width * 0.6), width - sheetWidth - gutter * 3))
    : width;
  return { width, height, sizeClass, wide, gutter, sheetWidth, filterMaxWidth };
}
