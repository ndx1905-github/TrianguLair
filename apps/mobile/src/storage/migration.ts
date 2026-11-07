/**
 * Moving to another storage (spec "Adding a device": changing storage; "Error cases": a friend
 * changes storage; crypto README "Change storage"). Only `@triangulair/storage` adapters here.
 *
 *   plan → copy (cancellable, resumable) → verify (every byte, by content hash)
 *        → certify the new read address (master key; see certify.ts)
 *        → publish at the new address, leave the newest index at the old one as the signed
 *          redirect (sync engine, `StorageMoveHooks`) → keep the old storage for a few months.
 *
 * Copy rules, so that the move is lossless and the old storage stays valid throughout:
 * - The source is never written. The destination gets the source's files at the same paths.
 * - Packs and photos first, in parallel; `index.json` / `index.v<N>.json` last (an index always
 *   points to complete packs, spec "Interrupted write").
 * - A file is written with `If-None-Match: *`. When it is already there, the bytes are compared:
 *   identical (an earlier interrupted run) → skipped; different → conflict, nothing overwritten.
 *   A file this run copied earlier may be replaced by a newer source version (the index).
 * - After copying, the source is listed again: anything another device published meanwhile is
 *   copied in another round (at most `MAX_ROUNDS` rounds that copy something).
 * - Verify reads every destination file back and compares its BLAKE2b hash with the source's.
 * - Cancel stops between files; what was copied stays (content-addressed packs are harmless) and
 *   a later run resumes. The current storage is untouched until the switch.
 */
import { packHash } from '@triangulair/crypto';
import { PreconditionFailed, type ListEntry, type StorageAdapter } from '@triangulair/storage';

import { isScratchPath } from './connectionTest';

export const MAX_ROUNDS = 3;
/** How long the old storage keeps the redirect (spec: "a few months"). */
export const REDIRECT_KEEP_MS = 180 * 24 * 3600 * 1000;

export class MigrationConflict extends Error {
  constructor(readonly paths: string[]) {
    super(`destination already holds other content at: ${paths.slice(0, 5).join(', ')}`);
    this.name = 'MigrationConflict';
  }
}

export class MigrationCancelled extends Error {
  constructor() {
    super('migration cancelled');
    this.name = 'MigrationCancelled';
  }
}

export class SourceChanged extends Error {
  constructor(readonly path: string) {
    super(`source changed during the copy: ${path}`);
    this.name = 'SourceChanged';
  }
}

export type PlanKind =
  /** Copy the files with the app. */
  | 'copy'
  /** Nothing to copy: no storage yet (the sync engine publishes everything after connecting). */
  | 'connect'
  /** The source cannot be listed (HTTPS-only): the owner published by other means. */
  | 'source-read-only'
  /** The destination is HTTPS-only: the owner copies the folder; the app verifies it. */
  | 'target-read-only';

export interface MigrationPlan {
  kind: PlanKind;
  /** Files to copy, sorted: data first, index files last. */
  files: ListEntry[];
  totalBytes: number;
  /** Paths already at the destination with another size: certain conflicts. */
  conflicts: string[];
  /** Files at the destination that the source does not have (left alone). */
  extraAtDestination: number;
  /** The source has an index: a redirect must be left there after the switch. */
  hasIndex: boolean;
}

export interface Progress {
  phase: 'copy' | 'verify';
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  /** Current round of the copy (1, then more if the source changed). */
  round: number;
}

export interface CopyResult {
  copied: number;
  skipped: number;
  /** BLAKE2b hash ("b2b256:…") of every file at the destination, by path. */
  hashes: Map<string, string>;
  rounds: number;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  missing: string[];
  mismatched: string[];
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  concurrency?: number;
  /** Content hash (default: the crypto package's BLAKE2b `packHash`; call `ready()` first). */
  hash?: (bytes: Uint8Array) => string;
}

/** `index.json`, `index.v2.json`…: written last. */
export function isIndexPath(path: string): boolean {
  return /^index(\.v\d+)?\.json$/.test(path);
}

function order(files: ListEntry[]): ListEntry[] {
  return [...files].sort((a, b) => Number(isIndexPath(a.path)) - Number(isIndexPath(b.path)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function listFiles(a: StorageAdapter): Promise<ListEntry[]> {
  return (await a.list('')).filter((e) => !isScratchPath(e.path));
}

/** What a move from `from` (null: local only) to `to` will do. */
export async function planMigration(from: StorageAdapter | null, to: StorageAdapter): Promise<MigrationPlan> {
  const empty = (kind: PlanKind, hasIndex = false): MigrationPlan => ({ kind, files: [], totalBytes: 0, conflicts: [], extraAtDestination: 0, hasIndex });
  if (!from) return empty('connect');
  if (!from.capabilities.list) return empty('source-read-only', (await from.head('index.json')) !== null);
  const files = order(await listFiles(from));
  const hasIndex = files.some((f) => f.path === 'index.json');
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (to.capabilities.readOnly) return { kind: 'target-read-only', files, totalBytes, conflicts: [], extraAtDestination: 0, hasIndex };
  const there = new Map((await listFiles(to)).map((e) => [e.path, e]));
  const conflicts = files.filter((f) => there.has(f.path) && there.get(f.path)!.size !== f.size).map((f) => f.path);
  const mine = new Set(files.map((f) => f.path));
  const extraAtDestination = [...there.keys()].filter((p) => !mine.has(p)).length;
  return { kind: 'copy', files, totalBytes, conflicts, extraAtDestination, hasIndex };
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null && next < items.length) {
      if (signal?.aborted) throw new MigrationCancelled();
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failed !== null) throw failed;
  for (const r of results) if (r.status === 'rejected') throw r.reason;
}

/**
 * Copies the plan's files. Throws `MigrationConflict` (nothing overwritten), `MigrationCancelled`
 * or `SourceChanged` (a file vanished: run again). Runs again over a source that changed meanwhile.
 */
export async function copyAll(plan: MigrationPlan, from: StorageAdapter, to: StorageAdapter, opts: RunOptions = {}): Promise<CopyResult> {
  if (plan.kind !== 'copy') return { copied: 0, skipped: 0, hashes: new Map(), rounds: 0 };
  if (plan.conflicts.length) throw new MigrationConflict(plan.conflicts);
  const hash = opts.hash ?? packHash;
  const n = opts.concurrency ?? 4;
  const hashes = new Map<string, string>();
  let copied = 0;
  let skipped = 0;
  let files = plan.files;
  let seen = new Map(plan.files.map((f) => [f.path, f.etag]));
  let round = 0;
  let busyRounds = 0; // rounds that copied something

  while (files.length) {
    round++;
    if (busyRounds >= MAX_ROUNDS || round > MAX_ROUNDS * 3) throw new SourceChanged(files[0]!.path);
    const copiedBefore = copied + skipped;
    const total = files.length;
    const bytesTotal = files.reduce((s, f) => s + f.size, 0);
    let done = 0;
    let bytesDone = 0;
    const tick = (f: ListEntry) => {
      done++;
      bytesDone += f.size;
      opts.onProgress?.({ phase: 'copy', done, total, bytesDone, bytesTotal, round });
    };
    opts.onProgress?.({ phase: 'copy', done, total, bytesDone, bytesTotal, round });

    const copyOne = async (f: ListEntry) => {
      const src = await from.get(f.path);
      if (!src) throw new SourceChanged(f.path);
      const h = hash(src.data);
      const index = isIndexPath(f.path);
      const ours = hashes.get(f.path);
      const contentType = index ? { contentType: 'application/json' } : {};
      if (ours === h) {
        // Listed again only because its ETag changed (weak or coarse ETags settling): same bytes.
        tick(f);
        return;
      }
      try {
        if (ours !== undefined) {
          // We copied an older version earlier in this run (a newer index): replace our own copy only.
          const cur = await to.get(f.path);
          if (cur && hash(cur.data) !== ours && hash(cur.data) !== h) throw new MigrationConflict([f.path]);
          await to.put(f.path, src.data, cur ? { ifMatch: cur.etag, ...contentType } : { ifNoneMatch: '*', ...contentType });
        } else {
          await to.put(f.path, src.data, { ifNoneMatch: '*', ...contentType });
        }
        copied++;
      } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e;
        const there = await to.get(f.path);
        if (!there || hash(there.data) !== h) throw new MigrationConflict([f.path]);
        skipped++;
      }
      hashes.set(f.path, h);
      tick(f);
    };

    const data = files.filter((f) => !isIndexPath(f.path));
    const indexes = files.filter((f) => isIndexPath(f.path));
    await pool(data, n, copyOne, opts.signal);
    for (const f of indexes) {
      if (opts.signal?.aborted) throw new MigrationCancelled();
      await copyOne(f);
    }

    if (copied + skipped > copiedBefore) busyRounds++;
    // Anything published meanwhile (another of my devices)?
    const now = await listFiles(from);
    const changed = order(now.filter((e) => seen.get(e.path) !== e.etag));
    seen = new Map(now.map((e) => [e.path, e.etag]));
    // Changed ETags are re-read and compared by content: weak or coarse ETags (Apache, Nextcloud) can
    // change without the bytes changing; a really newer file (the index) replaces our own copy.
    files = changed;
  }
  return { copied, skipped, hashes, rounds: round };
}

/** Reads every file back from the destination and compares its hash with the source's. */
export async function verifyCopy(expected: Map<string, string>, to: StorageAdapter, opts: RunOptions = {}): Promise<VerifyResult> {
  const hash = opts.hash ?? packHash;
  const missing: string[] = [];
  const mismatched: string[] = [];
  const entries = [...expected.entries()];
  let done = 0;
  opts.onProgress?.({ phase: 'verify', done, total: entries.length, bytesDone: 0, bytesTotal: 0, round: 1 });
  await pool(
    entries,
    opts.concurrency ?? 4,
    async ([path, h]) => {
      const got = await to.get(path);
      if (!got) missing.push(path);
      else if (hash(got.data) !== h) mismatched.push(path);
      done++;
      opts.onProgress?.({ phase: 'verify', done, total: entries.length, bytesDone: 0, bytesTotal: 0, round: 1 });
    },
    opts.signal,
  );
  missing.sort();
  mismatched.sort();
  return { ok: !missing.length && !mismatched.length, checked: entries.length, missing, mismatched };
}

/**
 * HTTPS-only destination: the owner copied the folder by other means; check every source file is
 * served at the new read address with the same bytes.
 */
export async function verifyPublished(plan: MigrationPlan, from: StorageAdapter, to: StorageAdapter, opts: RunOptions = {}): Promise<VerifyResult> {
  const hash = opts.hash ?? packHash;
  const expected = new Map<string, string>();
  for (const f of plan.files) {
    const src = await from.get(f.path);
    if (src) expected.set(f.path, hash(src.data));
  }
  return verifyCopy(expected, to, opts);
}
