// SPDX-License-Identifier: MPL-2.0
/**
 * Lists beyond the public file (T-211, T-212; spec "Creating a sharing list", "Following a list
 * without following the person", "Encrypted sharing").
 *
 * Three ways a list leaves my devices:
 *
 * 1. **To friends with access** (a contact whose "they see my places" is restricted to some
 *    lists, or a contact who sees everything and was picked for this list): a *lists pack* with
 *    the list definitions (id, name, description, date, membership as place ids) sealed to me and
 *    to exactly the contacts who may see them. The places themselves travel in the ordinary
 *    places packs (the audiences of `computeAudiences` already include those contacts).
 * 2. **Link-only**: the list has its own random X25519 key pair. Its secret key (32 bytes) is
 *    stored in my Yjs document (`ListRecord.linkKey`, base64url, so every device of mine has it),
 *    and travels in the list link after the `#`. A lists pack holding the definition AND the places
 *    (public comments only, like a public list: the link can be forwarded) is sealed to me and to
 *    the list's public key, so whoever holds the link opens it with the frozen crypto structures
 *    (`openPack` with that key pair, against my verified index), with no key exchange and no
 *    consent: the list key is a plain direct recipient, never a group member. "New link" draws
 *    another key pair: the next publication seals new packs (new batch keys) to the new key only
 *    and deletes the old files, so an old link opens nothing any more ("This link no longer
 *    works"). Deleting the list leaves a small *tombstone* sealed to its last key for 180 days
 *    ("This list no longer exists").
 * 3. **Public**: the plaintext `public/lists.geojson` (public-lists.ts).
 *
 * Why the key in the fragment never reaches a server: the part of a URL after `#` is not part of
 * the HTTP request target (RFC 3986 §3.5, RFC 9110 §7.1), so neither the `triangulair.app` web
 * server (when the app is not installed, the browser asks for `/l` only) nor any proxy sees it; on
 * a phone with the app, the system hands the whole URL to the app without any request (universal
 * links / app links). The app then reads only the author's storage (index and packs), whose host
 * never sees the link either. What must hold on our side: the `triangulair.app` page must not
 * read `location.hash` (no script that sends it anywhere), the app removes the fragment from the
 * address bar on the web, and never logs links.
 *
 * Link bytes (version 1), then base64url after `https://triangulair.app/l#`:
 *
 *   0   1   version = 1
 *   1   1   kind: 1 = link-only, 2 = public
 *   2   32  author's master public key (Ed25519, the owner id)
 *   34  …   link-only: the list's X25519 secret key (32 bytes)
 *           public: list id length (u8, 1..64) + list id (UTF-8)
 *   …   …   the author's certified read address (UTF-8, the rest: an https:// URL, crypto
 *           `checkLocation`; the reader still accepts the index only if its master-signed
 *           certificate names this address, or follows its signed redirect)
 */
import _sodium from 'libsodium-wrappers-sumo';
import {
  checkLocation,
  formatKey,
  fromB64Url,
  generateX25519KeyPair,
  packHash,
  parseKey,
  toB64Url,
  type KeyPair,
} from '@triangulair/crypto';
import { isLocalPlaceId, parseOsmPlaceId } from '@triangulair/data';
import { PayloadError } from './errors.ts';
import { parseFeatureArray, type ParsedFeature, type PlaceFeature } from './features.ts';
import { parseJsonBody, utf8 } from './payload.ts';

export const LIST_LINK_VERSION = 1;
export const LISTS_VERSION = 1;
export const LISTS_MINOR = 0;
/** Tombstones of deleted link-only lists stay this long (spec: deletion markers are kept six months). */
export const LIST_TOMBSTONE_MS = 180 * 24 * 3600 * 1000;
/** Places per link-only list pack (a bigger list is cut in several packs). */
export const LIST_PACK_CAPACITY = 500;
export const MAX_LISTS_PER_PACK = 256;
export const MAX_ITEMS_PER_LIST = 20_000;
const LIST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LOCATION_BYTES = 512;

export type ListLink =
  | { kind: 'link'; owner: string; location: string; secret: Uint8Array }
  | { kind: 'public'; owner: string; location: string; listId: string };

export class ListLinkError extends Error {
  constructor(msg: string) {
    super(`list link: ${msg}`);
    this.name = 'ListLinkError';
  }
}

export function isListId(v: unknown): v is string {
  return typeof v === 'string' && LIST_ID_RE.test(v);
}

/** The bytes of a list link (see the module comment). */
export function encodeListLink(l: ListLink): Uint8Array {
  const owner = parseKey('ed25519', l.owner, 'list link owner');
  try {
    checkLocation(l.location);
  } catch {
    throw new ListLinkError('the read address must be a canonical https:// URL');
  }
  const loc = utf8(l.location);
  if (loc.length > MAX_LOCATION_BYTES) throw new ListLinkError('read address too long');
  let mid: Uint8Array;
  if (l.kind === 'link') {
    if (!(l.secret instanceof Uint8Array) || l.secret.length !== 32) throw new ListLinkError('the list key must be 32 bytes');
    mid = l.secret;
  } else {
    if (!isListId(l.listId)) throw new ListLinkError('bad list id');
    const id = utf8(l.listId);
    mid = new Uint8Array(1 + id.length);
    mid[0] = id.length;
    mid.set(id, 1);
  }
  const out = new Uint8Array(2 + 32 + mid.length + loc.length);
  out[0] = LIST_LINK_VERSION;
  out[1] = l.kind === 'link' ? 1 : 2;
  out.set(owner, 2);
  out.set(mid, 34);
  out.set(loc, 34 + mid.length);
  return out;
}

const dec = new TextDecoder('utf-8', { fatal: true });

/** Parses list link bytes (strict: version, kind, key, id, canonical https:// address). */
export function decodeListLink(b: Uint8Array): ListLink {
  if (!(b instanceof Uint8Array) || b.length < 2 + 32 + 2 + 9) throw new ListLinkError('too short');
  if (b[0] !== LIST_LINK_VERSION) throw new ListLinkError('unsupported version');
  if (b[1] !== 1 && b[1] !== 2) throw new ListLinkError('unknown kind');
  const owner = formatKey('ed25519', b.slice(2, 34));
  let off = 34;
  let secret: Uint8Array | null = null;
  let listId: string | null = null;
  if (b[1] === 1) {
    secret = b.slice(34, 66);
    off = 66;
  } else {
    const n = b[34]!;
    if (n < 1 || n > 64 || b.length < 35 + n) throw new ListLinkError('bad list id');
    try {
      listId = dec.decode(b.subarray(35, 35 + n));
    } catch {
      throw new ListLinkError('bad list id');
    }
    if (!isListId(listId)) throw new ListLinkError('bad list id');
    off = 35 + n;
  }
  const rest = b.subarray(off);
  if (rest.length === 0 || rest.length > MAX_LOCATION_BYTES) throw new ListLinkError('bad read address');
  let location: string;
  try {
    location = dec.decode(rest);
    checkLocation(location);
  } catch {
    throw new ListLinkError('bad read address');
  }
  return secret ? { kind: 'link', owner, location, secret } : { kind: 'public', owner, location, listId: listId! };
}

/** The base64url fragment of a list link (what follows `https://triangulair.app/l#`). */
export function listLinkFragment(l: ListLink): string {
  return toB64Url(encodeListLink(l));
}

export function parseListLinkFragment(fragment: string): ListLink {
  if (typeof fragment !== 'string' || fragment.length === 0 || fragment.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(fragment)) {
    throw new ListLinkError('bad fragment');
  }
  let bytes: Uint8Array;
  try {
    bytes = fromB64Url(fragment, 'list link');
  } catch {
    throw new ListLinkError('bad fragment');
  }
  return decodeListLink(bytes);
}

/**
 * The local id of a followed list: `list:` + 22 characters of BLAKE2b over the author, the kind
 * and the key (or list id). It is also the "owner" of the list's places in my cache, so a
 * followed list never mixes with the author's own cache when I also follow them. A new link
 * (rotation) is another followed list.
 */
export function followIdOf(l: ListLink): string {
  const k = l.kind === 'link' ? `link\n${toB64Url(l.secret)}` : `public\n${l.listId}`;
  return `list:${packHash(utf8(`${l.owner}\n${l.location}\n${k}`)).slice(7, 29)}`;
}

export const isFollowId = (s: string): boolean => /^list:[A-Za-z0-9_-]{22}$/.test(s);

let sodiumOk = false;
/** libsodium of this package (the app bundles one copy, shared with @triangulair/crypto). */
export async function listsReady(): Promise<void> {
  if (sodiumOk) return;
  await _sodium.ready;
  sodiumOk = true;
}

/** The list's key pair from its 32-byte secret key (call `listsReady()` first). */
export function listKeyPair(secret: Uint8Array): KeyPair {
  if (!sodiumOk) throw new Error('lists: call `await listsReady()` first');
  if (secret.length !== 32) throw new ListLinkError('the list key must be 32 bytes');
  return { publicKey: _sodium.crypto_scalarmult_base(secret), secretKey: secret.slice() };
}

/** A new list key, as stored in `ListRecord.linkKey` (base64url of the X25519 secret key). */
export function newListKey(): string {
  return toB64Url(generateX25519KeyPair().secretKey);
}

/** The secret key of a stored `linkKey`, or null when it is absent or malformed. */
export function listSecretOf(linkKey: string | null | undefined): Uint8Array | null {
  if (!linkKey) return null;
  try {
    return fromB64Url(linkKey, 'list key', 32);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the lists payload (kind 4)

/** A list as its readers see it. `items`: place ids (for friends: only places they can read). */
export interface ListDef {
  id: string;
  name: string;
  description?: string;
  updated: string;
  items: string[];
}

/** A deleted link-only list (sealed to its last key; "This list no longer exists"). */
export interface ListTombstone {
  id: string;
  deleted: true;
  updated: string;
  until: string;
}

export type ListEntry = ListDef | ListTombstone;

export const isTombstone = (e: ListEntry): e is ListTombstone => (e as ListTombstone).deleted === true;

/**
 *   {"type":"FeatureCollection","triangulair":{"kind":"lists","version":1,"author"?:"Anna","lists":[
 *      {"id":"…","name":"Brunch","description"?:"…","updated":"…","items":["osm:node/1",…]},
 *      {"id":"…","deleted":true,"updated":"…","until":"…"}]},
 *    "features":[…places of a link-only list, as in a places payload…]}
 */
export function listsCollection(lists: readonly ListEntry[], features: readonly PlaceFeature[], opts: { author?: string } = {}): Uint8Array {
  const out = lists.map((l) => {
    if (isTombstone(l)) return { id: l.id, deleted: true, updated: l.updated, until: l.until };
    const o: Record<string, unknown> = { id: l.id, name: clean(l.name, 200) };
    if (l.description) o.description = clean(l.description, 4000, true);
    o.updated = l.updated;
    o.items = l.items;
    return o;
  });
  const meta: Record<string, unknown> = { kind: 'lists', version: LISTS_VERSION };
  if (opts.author) meta.author = clean(opts.author, 100);
  meta.lists = out;
  return utf8(JSON.stringify({ type: 'FeatureCollection', triangulair: meta, features }));
}

export interface ParsedLists {
  author?: string;
  lists: ListEntry[];
  features: ParsedFeature[];
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (m: string): never => {
  throw new PayloadError(`lists: ${m}`);
};
function clean(v: string, max: number, multiline = false): string {
  const out = v.replace(new RegExp(CONTROL_RE.source, 'g'), '').replace(multiline ? /(?!)/ : /[\t\n\r]/g, ' ');
  return out.length > max ? out.slice(0, max) : out;
}
function str(v: unknown, max: number, what: string, multiline = false): string {
  if (typeof v !== 'string' || v.length > max) fail(`${what} must be a string of at most ${max} characters`);
  if (CONTROL_RE.test(v as string) || (!multiline && /[\t\n\r]/.test(v as string))) fail(`${what} contains control characters`);
  return v as string;
}
function date(v: unknown, what: string): string {
  if (typeof v !== 'string' || !ISO_RE.test(v) || !Number.isFinite(Date.parse(v))) fail(`${what} must be an ISO-8601 UTC date`);
  return v as string;
}
const isPlaceId = (v: unknown): v is string => typeof v === 'string' && v.length <= 100 && (!!parseOsmPlaceId(v) || isLocalPlaceId(v));

/** Parses a lists payload body (strict like the places payload; unknown fields only under a higher minor). */
export function parseLists(body: Uint8Array): ParsedLists {
  const doc = parseJsonBody(body);
  if (!isObj(doc) || doc.type !== 'FeatureCollection' || !isObj(doc.triangulair)) fail('not a TrianguLair FeatureCollection');
  const meta = (doc as Record<string, unknown>).triangulair as Record<string, unknown>;
  if (meta.kind !== 'lists') fail('wrong kind');
  if (meta.version !== LISTS_VERSION) throw new PayloadError('lists: unsupported version', true);
  const minor = meta.minor === undefined ? 0 : meta.minor;
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || (minor < 1 && meta.minor !== undefined)) fail('bad minor');
  const lenient = (minor as number) > LISTS_MINOR;
  for (const k of Object.keys(doc as object)) if (!['type', 'triangulair', 'features'].includes(k) && !lenient) fail(`unknown field ${k}`);
  for (const k of Object.keys(meta)) if (!['kind', 'version', 'minor', 'author', 'lists'].includes(k) && !lenient) fail(`unknown field triangulair.${k}`);
  const author = meta.author === undefined ? undefined : str(meta.author, 100, 'author');
  if (!Array.isArray(meta.lists) || meta.lists.length > MAX_LISTS_PER_PACK) fail('lists must be an array (bounded)');
  const seen = new Set<string>();
  const lists = (meta.lists as unknown[]).map((l): ListEntry => {
    if (!isObj(l)) fail('list expected');
    const x = l as Record<string, unknown>;
    if (!isListId(x.id)) fail('bad list id');
    if (seen.has(x.id as string)) fail('duplicate list id');
    seen.add(x.id as string);
    if (x.deleted !== undefined) {
      if (x.deleted !== true) fail('bad deleted');
      for (const k of Object.keys(x)) if (!['id', 'deleted', 'updated', 'until'].includes(k) && !lenient) fail(`unknown list field ${k}`);
      return { id: x.id as string, deleted: true, updated: date(x.updated, 'updated'), until: date(x.until, 'until') };
    }
    for (const k of Object.keys(x)) if (!['id', 'name', 'description', 'updated', 'items'].includes(k) && !lenient) fail(`unknown list field ${k}`);
    const def: ListDef = { id: x.id as string, name: str(x.name, 200, 'name'), updated: date(x.updated, 'updated'), items: [] };
    if (x.description !== undefined) def.description = str(x.description, 4000, 'description', true);
    if (!Array.isArray(x.items) || x.items.length > MAX_ITEMS_PER_LIST) fail('items must be an array (bounded)');
    const items = new Set<string>();
    for (const it of x.items as unknown[]) {
      if (!isPlaceId(it)) fail('items must be place ids');
      items.add(it as string);
    }
    def.items = [...items];
    return def;
  });
  const features = parseFeatureArray((doc as Record<string, unknown>).features, lenient);
  return { ...(author !== undefined && { author }), lists, features };
}

// ------------------------------------------------------------------ public file, reader side

/** A public list read from someone's `public/lists.geojson` (verified through their index). */
export interface PublicListRead {
  def: ListDef | null;
  author?: string;
  features: ParsedFeature[];
}

const PUBLIC_EXTRA = new Set(['list', 'list_name', 'description', '_umap_options', 'url']);

/**
 * One list of a public lists file (built by `buildPublicLists`): its definition (null when the file
 * no longer has it) and its places, validated with the places payload's rules (the uMap-only
 * properties are set aside). `owner`: the verified index's owner, which the file must name.
 */
export function parsePublicList(bytes: Uint8Array, owner: string, listId: string): PublicListRead {
  let doc: unknown;
  try {
    doc = JSON.parse(dec.decode(bytes));
  } catch {
    fail('public file: invalid JSON');
  }
  if (!isObj(doc) || doc.type !== 'FeatureCollection' || !isObj(doc.triangulair)) fail('public file: not a TrianguLair FeatureCollection');
  const meta = (doc as Record<string, unknown>).triangulair as Record<string, unknown>;
  if (meta.kind !== 'public-lists') fail('public file: wrong kind');
  if (meta.version !== 1) throw new PayloadError('public file: unsupported version', true);
  if (meta.owner !== owner) fail('public file: another owner');
  const author = typeof meta.author === 'string' ? str(meta.author, 100, 'author') : undefined;
  if (!Array.isArray(meta.lists) || meta.lists.length > MAX_LISTS_PER_PACK * 4) fail('public file: bad lists');
  const m = (meta.lists as unknown[]).find((l) => isObj(l) && (l as Record<string, unknown>).id === listId) as Record<string, unknown> | undefined;
  if (!m) return { def: null, ...(author !== undefined && { author }), features: [] };
  const def: ListDef = { id: listId, name: str(m.name, 200, 'name'), updated: date(m.updated, 'updated'), items: [] };
  if (typeof m.description === 'string') def.description = str(m.description, 4000, 'description', true);
  const raw = (doc as Record<string, unknown>).features;
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS_PER_LIST * 4) fail('public file: bad features');
  const mine: unknown[] = [];
  for (const f of raw as unknown[]) {
    if (!isObj(f) || !isObj(f.properties) || (f.properties as Record<string, unknown>).list !== listId) continue;
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.properties as Record<string, unknown>)) if (!PUBLIC_EXTRA.has(k)) props[k] = v;
    const id = typeof f.id === 'string' && f.id.startsWith(`${listId}/`) ? f.id.slice(listId.length + 1) : null;
    mine.push({ type: 'Feature', id, geometry: f.geometry, properties: props });
  }
  const features: ParsedFeature[] = [];
  for (let i = 0; i < mine.length; i += 1000) features.push(...parseFeatureArray(mine.slice(i, i + 1000), false));
  def.items = features.map((f) => f.feature.id);
  return { def, ...(author !== undefined && { author }), features };
}

// ------------------------------------------------------------------ links for uMap

/** The public lists file of a read address (`<location>public/lists.geojson`). */
export function publicListsUrl(location: string): string {
  return new URL('public/lists.geojson', location.endsWith('/') ? location : `${location}/`).href;
}

/** Public uMap instance of OpenStreetMap France (spec "Viewing without the app"). */
export const UMAP_INSTANCE = 'https://umap.openstreetmap.fr';

/**
 * "View on uMap": a new uMap map that imports the file (uMap's `dataUrl` and `dataFormat` query
 * parameters, read by `loadDataFromQueryString`; the instance fetches it through its proxy, so the
 * storage needs no CORS rule for uMap).
 */
export function umapUrl(fileUrl: string, opts: { lang?: string; instance?: string } = {}): string {
  const u = new URL(fileUrl);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ListLinkError('uMap: the file must be on http(s)');
  const lang = opts.lang && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(opts.lang) ? opts.lang : 'en';
  const base = (opts.instance ?? UMAP_INSTANCE).replace(/\/+$/, '');
  const q = new URLSearchParams({ dataUrl: u.href, dataFormat: 'geojson' });
  return `${base}/${lang}/map/new/?${q.toString()}`;
}
