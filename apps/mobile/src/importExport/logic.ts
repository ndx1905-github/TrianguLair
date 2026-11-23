/**
 * Import screen logic (pure, unit-tested): what each preview row says, the
 * order of the preview sections, the "undo the last import" record.
 */
import { groupOf, type ImportPlan, type ImportReport, type ItemGroup, type PlanItem } from '@triangulair/import';

/** How long the last import can be undone in one gesture (spec: "for a few days"). */
export const UNDO_DAYS = 7;
export const LAST_IMPORT_KEY = 'last-import';

export type RowOutcome = 'link' | 'merge' | 'existing' | 'duplicate' | 'manual' | 'skip';

/** `mergeExisting`: the preview's choice for places already in my saves (merged, or left as they are). */
export function rowOutcome(item: PlanItem, mergeExisting = false): RowOutcome {
  if (item.resolution.kind === 'skip') return 'skip';
  if (item.duplicateOf) return 'duplicate';
  if (item.existing) return mergeExisting ? 'merge' : 'existing';
  if (item.resolution.kind === 'manual') return 'manual';
  return 'link';
}

export const GROUP_ORDER: readonly ItemGroup[] = ['ambiguous', 'matched', 'manual', 'unlocated'];

export function itemsByGroup(plan: ImportPlan): Record<ItemGroup, PlanItem[]> {
  const out: Record<ItemGroup, PlanItem[]> = { ambiguous: [], matched: [], manual: [], unlocated: [] };
  for (const it of plan.items) out[groupOf(it)].push(it);
  return out;
}

/** The section shown first: the places to check if any, else the first non-empty one. */
export function firstGroup(plan: ImportPlan): ItemGroup {
  const g = itemsByGroup(plan);
  return GROUP_ORDER.find((k) => g[k].length > 0) ?? 'matched';
}

/** Number of places that will be written (new, or merged when the user chose to). */
export function toWrite(plan: ImportPlan): number {
  return plan.items.filter(
    (it) => it.resolution.kind !== 'skip' && !it.duplicateOf && (plan.mergeExisting || !it.existing) && (it.resolution.kind === 'osm' || it.position || it.place.shape),
  ).length;
}

/** Parse warnings the preview shows, with their count (warnings about single places are summed). */
export const SHOWN_WARNINGS = ['invalid-geojson', 'positions-from-address', 'row-not-joined', 'remote-photos'] as const;
export type ShownWarning = (typeof SHOWN_WARNINGS)[number];

export function previewWarnings(plan: ImportPlan): { code: ShownWarning; count: number }[] {
  const out: { code: ShownWarning; count: number }[] = [];
  for (const code of SHOWN_WARNINGS) {
    const ws = plan.warnings.filter((w) => w.code === code);
    if (ws.length === 0) continue;
    const count = ws.reduce((n, w) => n + (w.detail && /^\d+$/.test(w.detail) ? Number(w.detail) : 1), 0);
    out.push({ code, count });
  }
  return out;
}

export function serializeReport(r: ImportReport): string {
  return JSON.stringify(r);
}

/** The stored report, if it can still be undone. */
export function undoableReport(json: string | null, now: number): ImportReport | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as ImportReport;
    if (typeof r.at !== 'number' || !Array.isArray(r.createdPlaceIds)) return null;
    if (now - r.at > UNDO_DAYS * 86_400_000) return null;
    if (r.createdPlaceIds.length === 0 && r.merged.length === 0) return null;
    return r;
  } catch {
    return null;
  }
}

export function formatDistanceM(m: number | null): string | null {
  if (m === null) return null;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
