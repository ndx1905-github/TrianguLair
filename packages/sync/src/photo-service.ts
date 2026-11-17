// SPDX-License-Identifier: MPL-2.0
/**
 * Photos for the app (T-111b): adding and removing my photos, the gallery of a place (mine and my
 * friends', with their author), and the images themselves:
 *
 * - my photos come from this device's copy; another device of mine fetches them from my storage
 *   (once, at the pull that meets them, or here on demand) and keeps them;
 * - a friend's thumbnail is fetched with their places for new photos (bounded per pass) or when the
 *   card shows it; their full photo only when it is opened (spec "friends download the full photo
 *   only when opening it"). Both go to the friends' cache, which is capped: photos are evicted first
 *   (full photos, least recently used, then thumbnails); their places stay.
 *
 * What a friend's photo needs is in their places pack (key and file hashes); the file is opened
 * only if their verified index lists it (`openPhoto`), so a removed reader, whose old files are
 * deleted and whose new key they never get, fetches nothing.
 */
import type { DataStore, MediaRecord } from '@triangulair/data';
import type { StorageAdapter } from '@triangulair/storage';
import { ImageFormatError, imageMetadata, sniffImage, stripImageMetadata } from './image-meta.ts';
import type { SyncLimits } from './limits.ts';
import { listsReady } from './lists.ts';
import type { MediaCache } from './media-cache.ts';
import type { OwnSync } from './own.ts';
import { MAX_PHOTO_SIDE, imageHash, mediaPath, openPhoto, photoKeyPair } from './photos.ts';
import type { FriendReader } from './reader.ts';

export const DEFAULT_FRIENDS_CACHE_BYTES = 500 * 1024 * 1024;

export interface PhotoInput {
  /** The recompressed photo (about 1,600 px; WebP, AVIF or JPEG). Metadata is removed again here. */
  full: Uint8Array;
  /** Its thumbnail, same format. */
  thumb: Uint8Array;
  width: number;
  height: number;
}

export interface PhotoImage {
  bytes: Uint8Array;
  mime: string | null;
}

export type PhotoState =
  /** Mine, on my storage. */
  | 'uploaded'
  /** Mine, not on my storage yet (no storage, storage full, or not synced yet). */
  | 'waiting'
  /** A friend's. */
  | 'friend';

export interface PhotoItem extends MediaRecord {
  ownerId: string;
  mine: boolean;
  state: PhotoState;
  /** Its thumbnail is on this device (no download needed to show it). */
  thumbLocal: boolean;
  /** The full photo is on this device. */
  fullLocal: boolean;
}

export class PhotoError extends Error {
  constructor(
    readonly code: 'format' | 'metadata' | 'too-large' | 'no-save',
    msg: string,
  ) {
    super(msg);
    this.name = 'PhotoError';
  }
}

export interface PhotosOptions {
  store: DataStore;
  cache: MediaCache;
  reader: FriendReader;
  own: () => OwnSync | null;
  readAdapter: (location: string) => StorageAdapter;
  limits: SyncLimits;
  /** Cap of the friends' photos in the cache (default 500 MiB). */
  friendsCacheBytes?: number;
}

export class Photos {
  private cap: number;
  private readonly inflight = new Map<string, Promise<PhotoImage | null>>();
  constructor(private readonly o: PhotosOptions) {
    this.cap = o.friendsCacheBytes ?? DEFAULT_FRIENDS_CACHE_BYTES;
  }

  get cache(): MediaCache {
    return this.o.cache;
  }
  private get me(): string {
    return this.o.store.repo.meId;
  }

  /** Changes the friends' cache cap (setting) and evicts at once. */
  setFriendsCacheBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('friends cache size must be a non-negative integer');
    this.cap = bytes;
    this.evict();
  }
  get friendsCacheBytes(): number {
    return this.cap;
  }

  /** Space taken on this device: my photos, the friends' cache and its cap. */
  usage(): { mine: number; friends: number; cap: number } {
    const u = this.o.cache.usage();
    return { mine: u.mine, friends: u.friends, cap: this.cap };
  }

  /**
   * Adds a photo to my save on `placeId` (already recompressed by the app). Metadata (EXIF, GPS,
   * XMP…) is removed again and the result checked; both images are stored on this device, the
   * document records the photo, and the next publication uploads it. Returns the photo id.
   */
  add(placeId: string, input: PhotoInput): string {
    if (!this.o.store.repo.getMySaveForPlace(placeId)) throw new PhotoError('no-save', 'save the place first');
    const L = this.o.limits;
    const full = clean(input.full);
    const thumb = clean(input.thumb);
    const mime = sniffImage(full);
    if (!mime || sniffImage(thumb) !== mime) throw new PhotoError('format', 'photo and thumbnail must be WebP, AVIF or JPEG, in the same format');
    if (full.length > L.photoBytes || thumb.length > L.thumbBytes) throw new PhotoError('too-large', 'photo too large');
    for (const d of [input.width, input.height]) {
      if (!Number.isSafeInteger(d) || d < 1 || d > MAX_PHOTO_SIDE) throw new PhotoError('format', 'bad photo size');
    }
    const file = imageHash(full);
    const th = imageHash(thumb);
    this.o.cache.put(file, full, { owner: this.me, kind: 'full', mine: true, mime });
    this.o.cache.put(th, thumb, { owner: this.me, kind: 'thumb', mine: true, mime });
    return this.o.store.addMedia(placeId, { file, thumb: th, mime, bytes: full.length, width: input.width, height: input.height });
  }

  /** Removes one of my photos (everywhere: my devices, then friends at their next read; its files are deleted at the next publication). */
  remove(placeId: string, mediaId: string): void {
    const m = this.o.store.repo.mediaById(mediaId);
    this.o.store.removeMedia(placeId, mediaId);
    if (m?.mine) this.dropOwnCopies([m.file, m.thumb ?? '']);
  }

  /** The photos of a place I can see: mine first, then my friends' (with their author). */
  list(placeId: string): PhotoItem[] {
    return this.o.store.repo.mediaForPlace(placeId).map((m) => ({
      ...m,
      state: m.mine ? (m.upload ? 'uploaded' : 'waiting') : 'friend',
      thumbLocal: !!m.thumb && this.o.cache.has(m.thumb),
      fullLocal: this.o.cache.has(m.file),
    }));
  }

  /** A photo's thumbnail (fetched when needed). Null: not available (not uploaded yet, gone, or no address). */
  thumbnail(mediaId: string): Promise<PhotoImage | null> {
    return this.image(mediaId, 'thumb');
  }

  /** The full photo (a friend's is downloaded now: "only when opening it"). */
  full(mediaId: string): Promise<PhotoImage | null> {
    return this.image(mediaId, 'full');
  }

  private image(mediaId: string, which: 'full' | 'thumb'): Promise<PhotoImage | null> {
    const k = `${mediaId}:${which}`;
    let p = this.inflight.get(k);
    if (!p) {
      p = this.load(mediaId, which).finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }

  private async load(mediaId: string, which: 'full' | 'thumb'): Promise<PhotoImage | null> {
    const m = this.o.store.repo.mediaById(mediaId);
    if (!m) return null;
    const id = which === 'full' ? m.file : m.thumb;
    if (!id) return null;
    const hit = this.o.cache.get(id);
    if (hit) return { bytes: hit.bytes, mime: hit.mime ?? m.mime ?? null };
    const u = m.upload;
    if (!u) return null;
    await listsReady();
    if (m.mine) {
      const own = this.o.own();
      const index = own?.index;
      if (!own || !index) return null;
      const img = await own.fetchOwnImage(index, u, which, id);
      if (!img) return null;
      this.o.cache.put(id, img, { owner: this.me, kind: which, mine: true, mime: m.mime ?? null });
      return { bytes: img, mime: m.mime ?? null };
    }
    const index = this.o.reader.indexFor(m.ownerId);
    const location = this.o.reader.locationOf(m.ownerId);
    if (!index || !location) return null;
    const h = which === 'full' ? u.full : u.thumb;
    const path = mediaPath(h);
    const L = this.o.limits;
    const max = which === 'full' ? L.photoBytes : L.thumbBytes;
    const g = await this.o.readAdapter(location).get(path, { maxBytes: max + 65_536 });
    if (!g) return null; // deleted: access removed, or replaced since my last read of their places
    const img = openPhoto(g.data, index, photoKeyPair(u.key), path, { maxBytes: max });
    if (!sniffImage(img)) throw new ImageFormatError('not an image');
    // Still theirs and still shared with me (a read may have removed it meanwhile)?
    if (this.o.store.repo.mediaById(mediaId)) {
      this.o.cache.put(id, img, { owner: m.ownerId, kind: which, mine: false, mime: m.mime ?? null });
      this.evict();
    }
    return { bytes: img, mime: m.mime ?? null };
  }

  /** Fetches the thumbnails of these photos that are not on this device, within `budget` bytes. Returns how many. */
  async prefetchThumbnails(mediaIds: readonly string[], budget: number): Promise<number> {
    let n = 0;
    let used = 0;
    for (const id of mediaIds) {
      if (used >= budget) break;
      const m = this.o.store.repo.mediaById(id);
      if (!m?.thumb || this.o.cache.has(m.thumb)) continue;
      try {
        const img = await this.thumbnail(id);
        if (img) {
          n++;
          used += img.bytes.length;
        }
      } catch {
        // shown as unavailable on the card; tried again when it is opened
      }
    }
    return n;
  }

  /**
   * My devices sync my photos: fetches the images of my uploaded photos that this device does not
   * have yet (thumbnails first), within `budget` bytes per call. Returns how many images.
   */
  async syncOwn(budget: number): Promise<number> {
    const own = this.o.own();
    if (!own?.index) return 0;
    const rows = this.o.store.repo.db
      .all<{ id: string; file: string; thumb: string | null }>(
        `SELECT m.id, m.file, m.thumb FROM media m JOIN saves s ON s.id = m.save_id WHERE s.owner_id = ? AND m.upload IS NOT NULL ORDER BY m.created_at DESC`,
        [this.me],
      );
    let n = 0;
    let used = 0;
    for (const which of ['thumb', 'full'] as const) {
      for (const r of rows) {
        if (used >= budget) return n;
        const id = which === 'full' ? r.file : r.thumb;
        if (!id || this.o.cache.has(id)) continue;
        try {
          const img = await this.image(r.id, which);
          if (img) {
            n++;
            used += img.bytes.length;
          }
        } catch {
          // next pass
        }
      }
    }
    return n;
  }

  /**
   * Forgets local copies no photo uses any more: friends' photos whose save left my cache (access
   * removed, deleted, friend removed) and my removed photos. Then applies the cap.
   */
  prune(): void {
    const repo = this.o.store.repo;
    const used = new Set<string>();
    for (const r of repo.db.all<{ file: string; thumb: string | null }>(`SELECT file, thumb FROM media`)) {
      used.add(r.file);
      if (r.thumb) used.add(r.thumb);
    }
    for (const id of this.o.cache.ids({ mine: false })) if (!used.has(id)) this.o.cache.delete(id);
    for (const kind of ['full', 'thumb'] as const) {
      for (const id of this.o.cache.ids({ mine: true, kind })) if (!used.has(id)) this.o.cache.delete(id);
    }
    this.evict();
  }

  evict(): string[] {
    return this.o.cache.evict(this.cap);
  }

  private dropOwnCopies(ids: string[]): void {
    const repo = this.o.store.repo;
    for (const id of ids) {
      if (!id) continue;
      const still = repo.db.get(`SELECT 1 AS x FROM media WHERE file = ? OR thumb = ?`, [id, id]);
      if (!still) this.o.cache.delete(id);
    }
  }
}

function clean(b: Uint8Array): Uint8Array {
  let out: Uint8Array;
  try {
    out = stripImageMetadata(b);
    if (imageMetadata(out).length) throw new PhotoError('metadata', 'the image still carries metadata (EXIF, XMP)');
  } catch (e) {
    if (e instanceof PhotoError) throw e;
    if (e instanceof ImageFormatError) throw new PhotoError('format', e.message);
    throw e;
  }
  return out;
}
