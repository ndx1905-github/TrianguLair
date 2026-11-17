/**
 * Base map fallback (spec "Error cases", map tiles unavailable: "cache of viewed areas, then
 * fallback address"; "Base map": the tile address is never hardcoded).
 *
 * A map tries, in order: the configured style address, each fallback address of the config, and
 * last a built-in blank style (a plain background), so that pins, zones and long press keep
 * working when no base map can be loaded at all. The areas already viewed come from MapLibre's
 * own cache (the browser's HTTP cache on web, the ambient cache on native): a load error only
 * reaches this code when the cache cannot answer, which is when the next address is tried.
 *
 * Pure logic, shared by Map.web.tsx and Map.native.tsx; the address reached is remembered for
 * the session, so the other maps (lists, zone editor) start from it instead of failing again.
 */
import {
  MAP_STYLE_FALLBACK_URLS,
  MAP_STYLE_FALLBACK_URLS_DARK,
  MAP_STYLE_URL,
  MAP_STYLE_URL_DARK,
} from '../../config';

/** The minimal subset of a MapLibre style the built-in fallback uses. */
export interface BlankStyle {
  version: 8;
  name: string;
  sources: Record<string, never>;
  layers: { id: string; type: 'background'; paint: { 'background-color': string } }[];
}

export type BaseMapStyle = string | BlankStyle;

/** What the map shows: the configured address, a fallback address, or no base map at all. */
export type BaseMapStatus = 'primary' | 'fallback' | 'unavailable';

/** The addresses to try for one theme (the built-in style is added by `styleChain`). */
export interface BaseMapSpec {
  urls: readonly string[];
  dark: boolean;
}

/** Consecutive tile failures (nothing loaded in between) that mean the tile host is down. */
export const TILE_FAILURES_BEFORE_FALLBACK = 4;

export function blankStyle(dark: boolean): BlankStyle {
  return {
    version: 8,
    name: 'triangulair-blank',
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': dark ? '#1D232B' : '#ECEBE6' } }],
  };
}

/** The configured addresses for the light or dark theme: primary first, duplicates removed. */
export function baseMapFor(
  dark: boolean,
  config = {
    primary: dark ? MAP_STYLE_URL_DARK : MAP_STYLE_URL,
    fallbacks: dark ? MAP_STYLE_FALLBACK_URLS_DARK : MAP_STYLE_FALLBACK_URLS,
  },
): BaseMapSpec {
  const urls = [config.primary, ...config.fallbacks].map((u) => u.trim()).filter(Boolean);
  return { urls: [...new Set(urls)], dark };
}

export function specKey(spec: BaseMapSpec): string {
  return `${spec.dark ? 'dark' : 'light'}|${spec.urls.join('|')}`;
}

/** Every style to try, in order: the addresses, then the built-in blank style. */
export function styleChain(spec: BaseMapSpec): BaseMapStyle[] {
  return [...spec.urls, blankStyle(spec.dark)];
}

export function statusAt(index: number, chainLength: number): BaseMapStatus {
  if (index <= 0) return 'primary';
  return index >= chainLength - 1 ? 'unavailable' : 'fallback';
}

/** The note shown for a status (none while the configured address or the cache answers). */
export function baseMapNoteKey(s: BaseMapStatus): 'map.tiles.fallback' | 'map.tiles.unavailable' | null {
  return s === 'fallback' ? 'map.tiles.fallback' : s === 'unavailable' ? 'map.tiles.unavailable' : null;
}

// ---- Session memory and status (read by the home screen's note) ----

const reached = new Map<string, number>();
let status: BaseMapStatus = 'primary';
const listeners = new Set<(s: BaseMapStatus) => void>();

export function baseMapStatus(): BaseMapStatus {
  return status;
}

export function subscribeBaseMapStatus(fn: (s: BaseMapStatus) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function publish(s: BaseMapStatus): void {
  if (s === status) return;
  status = s;
  for (const fn of listeners) fn(s);
}

/** For tests: forget the addresses reached and the status. */
export function resetBaseMapSession(): void {
  reached.clear();
  publish('primary');
}

/**
 * The fallback state of one map for one theme. The map reports load events; when one of them
 * returns true, the map must load `current()` (a full style reload).
 */
export class BaseMapFallback {
  readonly key: string;
  readonly chain: BaseMapStyle[];
  private i: number;
  private tileFailures = 0;
  private styleLoaded = false;

  constructor(spec: BaseMapSpec, private readonly tileThreshold = TILE_FAILURES_BEFORE_FALLBACK) {
    this.key = specKey(spec);
    this.chain = styleChain(spec);
    this.i = Math.min(reached.get(this.key) ?? 0, this.chain.length - 1);
    publish(this.status());
  }

  get index(): number {
    return this.i;
  }

  current(): BaseMapStyle {
    return this.chain[this.i]!;
  }

  status(): BaseMapStatus {
    return statusAt(this.i, this.chain.length);
  }

  /** The current style was loaded (its own JSON; its tiles may still fail). */
  styleLoad(): void {
    this.styleLoaded = true;
  }

  /** The style itself could not be loaded (network, 404, invalid JSON). */
  styleError(): boolean {
    return this.advance();
  }

  /**
   * An error event of the map. Without a source: the style JSON failed if it was not loaded yet
   * (a sprite or glyph error after the style loaded does not switch). With a source of the base
   * map: its TileJSON failed (switch now) or one tile failed (switch after a run of failures with
   * no tile loaded in between). Errors of the app's own sources are ignored.
   */
  error(e: { sourceId?: string; tile?: unknown }, ownSources: readonly string[] = []): boolean {
    if (!e.sourceId) return this.styleLoaded ? false : this.styleError();
    // Before the style loaded, a source error is a late one of the previous style.
    if (!this.styleLoaded || ownSources.includes(e.sourceId)) return false;
    if (!e.tile) return this.advance();
    return this.tileError();
  }

  tileError(): boolean {
    this.tileFailures += 1;
    if (this.tileFailures < this.tileThreshold) return false;
    return this.advance();
  }

  /** A tile of the base map loaded (from the network or the cache): the address works. */
  tileLoad(): void {
    this.tileFailures = 0;
  }

  private advance(): boolean {
    if (this.i >= this.chain.length - 1) return false;
    this.i += 1;
    this.tileFailures = 0;
    this.styleLoaded = false;
    reached.set(this.key, Math.max(reached.get(this.key) ?? 0, this.i));
    publish(this.status());
    return true;
  }
}
