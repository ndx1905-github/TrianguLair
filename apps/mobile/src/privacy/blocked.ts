/**
 * Blocking a person and reporting a public list (gap #6, spec "Store rules": "the app lets users block a person and
 * report a public list to its author and to the host"; "Moderation": "Blocking a person deletes their key and places
 * from the app, and removes all their accesses"; no central moderation, so a report goes to the author and to the
 * host of the author's storage, and the list is hidden here).
 *
 * The blocked people are a vault value (`blocked`, signed, so all my devices block them) mirrored in the local sync
 * state for local-only mode. The contacts service asks `isBlocked` before opening an invitation or an answer.
 */
import { publicListsUrl } from '@triangulair/sync';

export const BLOCKED_VALUE = 'blocked';
export const BLOCKED_STATE = 'app.blocked';
export const REPORTED_STATE = 'app.reported-lists';

export interface BlockedPerson {
  owner: string;
  /** The name I gave them, if any (petname: names are never sent). */
  name: string;
  at: number;
}

export interface ReportedList {
  /** The followed-list id (`followIdOf`). */
  id: string;
  name: string;
  owner: string;
  location: string;
  at: number;
}

const OWNER = /^ed25519:[A-Za-z0-9_-]{20,100}$/;

/** Defensive parse of the stored list (a newer version may add fields; damaged entries are dropped). */
export function parseBlocked(v: unknown): BlockedPerson[] {
  if (!Array.isArray(v)) return [];
  const out = new Map<string, BlockedPerson>();
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const { owner, name, at } = e as Record<string, unknown>;
    if (typeof owner !== 'string' || !OWNER.test(owner)) continue;
    out.set(owner, { owner, name: typeof name === 'string' ? name.slice(0, 80) : '', at: typeof at === 'number' && Number.isFinite(at) ? at : 0 });
  }
  return [...out.values()].sort((a, b) => b.at - a.at || (a.owner < b.owner ? -1 : 1));
}

export function withBlocked(list: readonly BlockedPerson[], p: BlockedPerson): BlockedPerson[] {
  return parseBlocked([p, ...list.filter((x) => x.owner !== p.owner)]);
}

export function withoutBlocked(list: readonly BlockedPerson[], owner: string): BlockedPerson[] {
  return list.filter((x) => x.owner !== owner);
}

export function parseReported(v: unknown): ReportedList[] {
  if (!Array.isArray(v)) return [];
  const out: ReportedList[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.owner !== 'string' || typeof r.location !== 'string') continue;
    out.push({ id: r.id, owner: r.owner, location: r.location, name: typeof r.name === 'string' ? r.name : '', at: typeof r.at === 'number' ? r.at : 0 });
  }
  return out;
}

// ------------------------------------------------------------------ registry (contacts service, list screens)

let source: () => readonly BlockedPerson[] = () => [];

/** The SyncProvider registers where the blocked list comes from (the controller). */
export function registerBlockedSource(fn: (() => readonly BlockedPerson[]) | null): void {
  source = fn ?? (() => []);
}

export function isBlocked(owner: string): boolean {
  return source().some((p) => p.owner === owner);
}

// ------------------------------------------------------------------ report

/** The host that serves a storage address (who to report a public list to). */
export function hostOf(location: string): string {
  try {
    return new URL(location).hostname;
  } catch {
    return '';
  }
}

/** The address of the public list file (what the host needs to find it). */
export function reportTarget(location: string): string {
  return publicListsUrl(location);
}
