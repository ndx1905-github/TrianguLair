import type { CategoryId } from '@triangulair/osm';

/** Categories present among the candidates, most frequent first. */
export function categoryCounts(list: readonly { category?: CategoryId | null }[]): { key: CategoryId; count: number }[] {
  const m = new Map<CategoryId, number>();
  for (const x of list) if (x.category) m.set(x.category, (m.get(x.category) ?? 0) + 1);
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
