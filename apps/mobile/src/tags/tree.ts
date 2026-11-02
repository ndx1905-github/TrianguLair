/**
 * Tag tree logic for tag management (T-108): sub-tags ("Restaurant › Pizza"),
 * ordering, paths, valid parents, name checks, place counts. Pure,
 * unit-tested. The data package refuses a cycle on edit and breaks
 * concurrent ones in its projection; this module keeps the UI from offering
 * one and survives one anyway.
 */
import type { AppTag } from '../places/model';
import { foldText } from './text';

export const PATH_SEPARATOR = ' › ';

export interface TagNode {
  tag: AppTag;
  depth: number;
  /** Names from the root, e.g. ["Restaurant", "Pizza"]. */
  path: string[];
  childCount: number;
}

function byName(a: AppTag, b: AppTag): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

/**
 * Depth-first order (parents before children, siblings by name). A tag whose
 * parent is unknown (in the trash, or a cycle) is shown at the root.
 */
export function buildTagTree(tags: readonly AppTag[]): TagNode[] {
  const ids = new Set(tags.map((t) => t.id));
  const children = new Map<string | null, AppTag[]>();
  // Roots: no parent, unknown parent, or part of a parent cycle (the smallest id of the cycle).
  const parentOf = new Map(tags.map((t) => [t.id, t.parentId && ids.has(t.parentId) ? t.parentId : null]));
  for (const t of tags) {
    const chain: string[] = [t.id];
    let cur = parentOf.get(t.id) ?? null;
    while (cur) {
      const at = chain.indexOf(cur);
      if (at >= 0) {
        // Cycle: detach its smallest id (deterministic, like the data projection).
        const smallest = chain.slice(at).sort()[0]!;
        parentOf.set(smallest, null);
        break;
      }
      chain.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  for (const t of tags) {
    const p = parentOf.get(t.id) ?? null;
    const list = children.get(p) ?? [];
    list.push(t);
    children.set(p, list);
  }
  for (const list of children.values()) list.sort(byName);
  const out: TagNode[] = [];
  const visit = (t: AppTag, depth: number, path: string[]) => {
    const kids = children.get(t.id) ?? [];
    const p = [...path, t.name];
    out.push({ tag: t, depth, path: p, childCount: kids.length });
    for (const k of kids) visit(k, depth + 1, p);
  };
  for (const r of children.get(null) ?? []) visit(r, 0, []);
  return out;
}

/** "Restaurant › Pizza" (cycle-safe; unknown parents are skipped). */
export function tagPath(id: string, byId: ReadonlyMap<string, AppTag>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t = byId.get(cur);
    if (!t) break;
    names.unshift(t.name);
    cur = t.parentId;
  }
  return names.join(PATH_SEPARATOR);
}

/** All descendants of a tag (not the tag itself). */
export function descendantIds(id: string, tags: readonly AppTag[]): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const t of tags) {
      if (t.parentId === cur && !out.has(t.id) && t.id !== id) {
        out.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return out;
}

/** Whether `parentId` can become the parent of `id` (no self, no descendant). */
export function canReparent(id: string, parentId: string | null, tags: readonly AppTag[]): boolean {
  if (parentId === null) return true;
  if (parentId === id) return false;
  return !descendantIds(id, tags).has(parentId);
}

/** Tags that may be chosen as the parent of `id` (all tags for a new tag), in tree order. */
export function parentOptions(id: string | null, tags: readonly AppTag[]): TagNode[] {
  const nodes = buildTagTree(tags);
  if (!id) return nodes;
  const banned = descendantIds(id, tags);
  banned.add(id);
  return nodes.filter((n) => !banned.has(n.tag.id));
}

export type TagNameProblem = 'empty' | 'tooLong' | 'duplicate';
export const MAX_TAG_NAME = 40;

/** Name check: not empty, not too long, unique among its siblings (accents and case ignored). */
export function validateTagName(name: string, parentId: string | null, tags: readonly AppTag[], selfId?: string): TagNameProblem | null {
  const n = name.trim();
  if (!n) return 'empty';
  if (n.length > MAX_TAG_NAME) return 'tooLong';
  const key = foldText(n);
  const clash = tags.some((t) => t.id !== selfId && (t.parentId ?? null) === (parentId ?? null) && foldText(t.name) === key);
  return clash ? 'duplicate' : null;
}

/** Places per tag, a tag counting the places of its sub-tags (each place once). */
export function placeCounts(tags: readonly AppTag[], placesTagIds: readonly (readonly string[])[]): Map<string, number> {
  const ancestors = new Map<string, string[]>();
  const byId = new Map(tags.map((t) => [t.id, t]));
  for (const t of tags) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = t.id;
    while (cur && !seen.has(cur) && byId.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = byId.get(cur)!.parentId;
    }
    ancestors.set(t.id, chain);
  }
  const counts = new Map<string, number>();
  for (const ids of placesTagIds) {
    const hit = new Set<string>();
    for (const id of ids) for (const a of ancestors.get(id) ?? []) hit.add(a);
    for (const a of hit) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return counts;
}
