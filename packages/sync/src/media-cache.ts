// SPDX-License-Identifier: MPL-2.0
/**
 * Local copies of photos (T-111b): my photos (recompressed, without metadata; never evicted: they may
 * exist nowhere else until uploaded) and the friends' photos I have opened (a cache: spec "the
 * friends' cache has an adjustable maximum size: their data stays in cache, their photos are evicted
 * first when the limit is reached").
 *
 * Kept in the app's SQLite database (table `media_cache`), so they share its protection (spec
 * "Protections on the device": the local database is encrypted with a key in the system vault, and a
 * remote wipe erases every table). Ids: the content hash of my image (`b2b256:` of the plaintext), the
 * hash of one of my encrypted files (`enc`, kept by a pull), or, for a friend's image, their owner id
 * and the hash of their encrypted file (`friendCacheId`): a friend's ids never meet mine (review photos
 * F-08). A friend's entry never replaces one of mine either (`put`).
 */
import type { SqlDriver } from '@triangulair/data';

/**
 * Cache id of a friend's image: `<owner>|<hash of their encrypted file>`. My ids are bare hashes
 * (`b2b256:…`, no `|`), so a friend naming one of my file hashes in their places pack gets another id.
 */
export function friendCacheId(owner: string, hash: string): string {
  return `${owner}|${hash}`;
}

export type BlobKind = 'full' | 'thumb' | 'enc';

export interface BlobMeta {
  /** Owner id of the photo (mine or a friend's). */
  owner: string;
  /** `full`, `thumb`, or `enc`: one of my encrypted files fetched before my document said what it was. */
  kind: BlobKind;
  /** Mine: never evicted. */
  mine: boolean;
  mime?: string | null;
}

export interface CacheUsage {
  /** My photos and thumbnails on this device. */
  mine: number;
  /** Friends' photos and thumbnails in the cache. */
  friends: number;
  files: number;
}

export interface MediaCache {
  /** The bytes (and marks them as used now). */
  get(id: string): { bytes: Uint8Array; mime: string | null } | undefined;
  has(id: string): boolean;
  /** Stores an entry; a friend's (`mine: false`) never replaces one of mine (it is ignored). */
  put(id: string, bytes: Uint8Array, meta: BlobMeta): void;
  delete(id: string): void;
  /** Ids of entries (all, or of one owner, or of one kind). */
  ids(filter?: { owner?: string; kind?: BlobKind; mine?: boolean }): string[];
  usage(): CacheUsage;
  /**
   * Removes friends' entries until they take at most `capBytes`: full photos first, least recently
   * used first, then thumbnails. Returns the ids removed.
   */
  evict(capBytes: number): string[];
}

interface Entry extends BlobMeta {
  bytes: Uint8Array;
  usedAt: number;
}

export class MemoryMediaCache implements MediaCache {
  private readonly m = new Map<string, Entry>();
  private tick = 0;
  constructor(private readonly clock: () => number = () => Date.now()) {}
  private now(): number {
    return Math.max(this.clock(), ++this.tick);
  }
  get(id: string) {
    const e = this.m.get(id);
    if (!e) return undefined;
    e.usedAt = this.now();
    return { bytes: e.bytes.slice(), mime: e.mime ?? null };
  }
  has(id: string): boolean {
    return this.m.has(id);
  }
  put(id: string, bytes: Uint8Array, meta: BlobMeta): void {
    const prev = this.m.get(id);
    if (prev?.mine && !meta.mine) return;
    this.m.set(id, { ...meta, mine: meta.mine || !!prev?.mine, bytes: bytes.slice(), usedAt: this.now() });
  }
  delete(id: string): void {
    this.m.delete(id);
  }
  ids(f: { owner?: string; kind?: BlobKind; mine?: boolean } = {}): string[] {
    return [...this.m.entries()]
      .filter(([, e]) => (f.owner === undefined || e.owner === f.owner) && (f.kind === undefined || e.kind === f.kind) && (f.mine === undefined || e.mine === f.mine))
      .map(([id]) => id)
      .sort();
  }
  usage(): CacheUsage {
    const u: CacheUsage = { mine: 0, friends: 0, files: 0 };
    for (const e of this.m.values()) {
      u.files++;
      if (e.mine) u.mine += e.bytes.length;
      else u.friends += e.bytes.length;
    }
    return u;
  }
  evict(capBytes: number): string[] {
    let total = this.usage().friends;
    const out: string[] = [];
    const order = [...this.m.entries()]
      .filter(([, e]) => !e.mine)
      .sort(([, a], [, b]) => Number(b.kind === 'full') - Number(a.kind === 'full') || a.usedAt - b.usedAt);
    for (const [id, e] of order) {
      if (total <= capBytes) break;
      this.m.delete(id);
      total -= e.bytes.length;
      out.push(id);
    }
    return out;
  }
}

/** The cache in the app's SQLite database (table `media_cache`, created if missing). */
export class SqliteMediaCache implements MediaCache {
  private tick = 0;
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: () => number = () => Date.now(),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS media_cache (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, mine INTEGER NOT NULL, mime TEXT,
      size INTEGER NOT NULL, used_at INTEGER NOT NULL, bytes BLOB NOT NULL) WITHOUT ROWID`);
    db.exec(`CREATE INDEX IF NOT EXISTS media_cache_lru ON media_cache (mine, used_at)`);
  }
  private now(): number {
    return Math.max(this.clock(), ++this.tick);
  }
  get(id: string) {
    const r = this.db.get<{ bytes: Uint8Array; mime: string | null }>(`SELECT bytes, mime FROM media_cache WHERE id = ?`, [id]);
    if (!r) return undefined;
    this.db.run(`UPDATE media_cache SET used_at = ? WHERE id = ?`, [this.now(), id]);
    return { bytes: new Uint8Array(r.bytes), mime: r.mime };
  }
  has(id: string): boolean {
    return !!this.db.get(`SELECT 1 AS x FROM media_cache WHERE id = ?`, [id]);
  }
  put(id: string, bytes: Uint8Array, meta: BlobMeta): void {
    this.db.run(
      `INSERT INTO media_cache (id, owner, kind, mine, mime, size, used_at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, kind = excluded.kind, mine = max(media_cache.mine, excluded.mine),
         mime = excluded.mime, size = excluded.size, used_at = excluded.used_at, bytes = excluded.bytes
       WHERE media_cache.mine = 0 OR excluded.mine = 1`,
      [id, meta.owner, meta.kind, meta.mine ? 1 : 0, meta.mime ?? null, bytes.length, this.now(), bytes],
    );
  }
  delete(id: string): void {
    this.db.run(`DELETE FROM media_cache WHERE id = ?`, [id]);
  }
  ids(f: { owner?: string; kind?: BlobKind; mine?: boolean } = {}): string[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.owner !== undefined) (where.push('owner = ?'), args.push(f.owner));
    if (f.kind !== undefined) (where.push('kind = ?'), args.push(f.kind));
    if (f.mine !== undefined) (where.push('mine = ?'), args.push(f.mine ? 1 : 0));
    return this.db
      .all<{ id: string }>(`SELECT id FROM media_cache ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`, args)
      .map((r) => r.id);
  }
  usage(): CacheUsage {
    const r = this.db.get<{ mine: number | null; friends: number | null; files: number }>(
      `SELECT sum(CASE WHEN mine = 1 THEN size END) AS mine, sum(CASE WHEN mine = 0 THEN size END) AS friends, count(*) AS files FROM media_cache`,
    );
    return { mine: r?.mine ?? 0, friends: r?.friends ?? 0, files: r?.files ?? 0 };
  }
  evict(capBytes: number): string[] {
    let total = this.usage().friends;
    if (total <= capBytes) return [];
    const out: string[] = [];
    const rows = this.db.all<{ id: string; size: number }>(
      `SELECT id, size FROM media_cache WHERE mine = 0 ORDER BY (kind = 'full') DESC, used_at ASC, id`,
    );
    for (const r of rows) {
      if (total <= capBytes) break;
      this.db.run(`DELETE FROM media_cache WHERE id = ?`, [r.id]);
      total -= r.size;
      out.push(r.id);
    }
    return out;
  }
}
