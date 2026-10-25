/**
 * Photos from Wikimedia Commons, found through the place's OSM tags:
 * `image` (only Commons links: other URLs are usually the business's own,
 * copyrighted, photos), `wikimedia_commons` (a file or a category) and
 * `wikidata` (P18 image, P373 Commons category).
 *
 * Wikimedia API etiquette: identifying User-Agent (Api-User-Agent in
 * browsers), serial requests, `origin=*` for anonymous CORS, few requests
 * (one per kind, titles batched).
 */
import { BadResponseError } from '../errors.ts';
import type { HttpClient } from '../http/client.ts';
import type { OsmTags, RequestOptions } from '../types.ts';
import { type Photo, type PhotoLicense, attributionLine, htmlToText } from './types.ts';

export interface CommonsRefs {
  /** File titles, normalized ("File:Name with spaces.jpg"), in tag order. */
  files: string[];
  /** Category titles ("Category:…"). */
  categories: string[];
  wikidata?: string;
}

/** Normalizes a Commons title: decoding, underscores, "File:" namespace, first letter uppercase. */
export function normalizeCommonsTitle(name: string, ns: 'File' | 'Category'): string | null {
  let s = name.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep as is
  }
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(File|Image|Category)\s*:\s*/i, '');
  if (!s || /[#<>[\]|{}]/.test(s)) return null;
  return `${ns}:${s[0]!.toUpperCase()}${s.slice(1)}`;
}

/** Extracts a Commons file title from an `image` value, or null if it is not a Commons file. */
export function commonsFileFromImageTag(value: string): string | null {
  const v = value.trim();
  if (/^(File|Image):/i.test(v)) return normalizeCommonsTitle(v, 'File');
  const page = /^https?:\/\/commons\.(?:m\.)?wikimedia\.org\/wiki\/((?:File|Image):[^?#]+)/i.exec(v);
  if (page?.[1]) return normalizeCommonsTitle(page[1], 'File');
  // upload.wikimedia.org/wikipedia/commons/a/ab/Name.jpg and …/thumb/a/ab/Name.jpg/800px-Name.jpg
  const upload = /^https?:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i.exec(v);
  if (upload?.[1]) return normalizeCommonsTitle(upload[1], 'File');
  return null;
}

export function parseCommonsRefs(tags: OsmTags): CommonsRefs {
  const files: string[] = [];
  const categories: string[] = [];
  const add = (list: string[], t: string | null) => {
    if (t && !list.includes(t)) list.push(t);
  };
  for (const v of (tags.image ?? '').split(';')) if (v.trim()) add(files, commonsFileFromImageTag(v));
  for (const v of (tags.wikimedia_commons ?? '').split(';')) {
    const s = v.trim();
    if (/^Category:/i.test(s)) add(categories, normalizeCommonsTitle(s, 'Category'));
    else if (/^(File|Image):/i.test(s)) add(files, normalizeCommonsTitle(s, 'File'));
  }
  const refs: CommonsRefs = { files, categories };
  const qid = tags.wikidata?.trim();
  if (qid && /^Q\d+$/.test(qid)) refs.wikidata = qid;
  return refs;
}

// ---------------------------------------------------------------------------

interface ExtMeta {
  [k: string]: { value?: string } | undefined;
}

interface ImageInfo {
  url?: string;
  descriptionurl?: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  width?: number;
  height?: number;
  mime?: string;
  extmetadata?: ExtMeta;
}

interface QueryPage {
  title: string;
  missing?: boolean;
  invalid?: boolean;
  imageinfo?: ImageInfo[];
}

interface QueryResponse {
  query?: { pages?: QueryPage[]; normalized?: { from: string; to: string }[] };
  error?: { code: string; info: string };
  continue?: Record<string, string>;
}

interface WbEntities {
  entities?: Record<
    string,
    {
      missing?: string;
      claims?: Record<string, Array<{ rank?: string; mainsnak?: { snaktype?: string; datavalue?: { value?: unknown } } }>>;
    }
  >;
}

const IMAGE_MIME = /^image\/(jpeg|png|webp|gif|tiff|svg\+xml)$/;
const EXT_FILTER = 'Artist|LicenseShortName|LicenseUrl|AttributionRequired|DateTimeOriginal|Copyrighted|UsageTerms';

export function commonsLicense(meta: ExtMeta | undefined): PhotoLicense | null {
  const name = htmlToText(meta?.LicenseShortName?.value) ?? htmlToText(meta?.UsageTerms?.value);
  if (!name) return null;
  const url = meta?.LicenseUrl?.value?.trim();
  const attr = meta?.AttributionRequired?.value;
  const pd = /public domain|^pd\b|cc0/i.test(name);
  const lic: PhotoLicense = { name, attributionRequired: attr === undefined ? !pd : attr !== 'false' };
  if (url) lic.url = url.startsWith('//') ? `https:${url}` : url;
  return lic;
}

function isoDate(v: string | undefined): string | undefined {
  const t = htmlToText(v);
  if (!t) return undefined;
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** Converts an imageinfo page into a Photo (null without image, mime or license). */
export function photoFromCommonsPage(page: QueryPage): Photo | null {
  const info = page.imageinfo?.[0];
  if (page.missing || page.invalid || !info?.url || !info.descriptionurl) return null;
  if (info.mime && !IMAGE_MIME.test(info.mime)) return null;
  const license = commonsLicense(info.extmetadata);
  if (!license) return null;
  const author = htmlToText(info.extmetadata?.Artist?.value);
  const photo: Photo = {
    source: 'wikimedia_commons',
    id: page.title,
    url: info.thumburl ?? info.url,
    fullUrl: info.url,
    thumbnailUrl: info.thumburl ?? info.url,
    pageUrl: info.descriptionurl,
    license,
    attribution: attributionLine({ ...(author ? { author } : {}), license }, 'Wikimedia Commons'),
    streetLevel: false,
  };
  const w = info.thumbwidth ?? info.width;
  const h = info.thumbheight ?? info.height;
  if (w) photo.width = w;
  if (h) photo.height = h;
  if (author) photo.author = author;
  const date = isoDate(info.extmetadata?.DateTimeOriginal?.value);
  if (date) photo.capturedAt = date;
  return photo;
}

export interface CommonsClientOptions {
  http: HttpClient;
  commonsApi: string;
  wikidataApi: string;
  /** Default 30 days: file metadata rarely changes. */
  ttlMs?: number;
}

export interface CommonsPhotoOptions extends RequestOptions {
  /** Maximum photos. Default 5. */
  limit?: number;
  /** Width of the display image. Default 800. */
  width?: number;
}

export class CommonsClient {
  private readonly ttlMs: number;
  constructor(private readonly o: CommonsClientOptions) {
    this.ttlMs = o.ttlMs ?? 30 * 24 * 3600_000;
  }

  private params(extra: Record<string, string>, width: number): URLSearchParams {
    return new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      origin: '*',
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: String(width),
      iiextmetadatafilter: EXT_FILTER,
      ...extra,
    });
  }

  private async query(params: URLSearchParams, opts: RequestOptions): Promise<QueryResponse> {
    const r = await this.o.http.getJson<QueryResponse>(
      { service: 'commons', url: `${this.o.commonsApi}?${params}`, ttlMs: this.ttlMs },
      opts,
    );
    if (r.error) throw new BadResponseError(`Commons API error ${r.error.code}: ${r.error.info}`);
    return r;
  }

  /** Photos for file titles, in the given order (max 50 titles per call, as the API allows). */
  async files(titles: string[], opts: CommonsPhotoOptions = {}): Promise<Photo[]> {
    const list = titles.slice(0, 50);
    if (list.length === 0) return [];
    const r = await this.query(this.params({ titles: list.join('|') }, opts.width ?? 800), opts);
    const byTitle = new Map((r.query?.pages ?? []).map((p) => [p.title, p]));
    const renamed = new Map((r.query?.normalized ?? []).map((n) => [n.from, n.to]));
    const out: Photo[] = [];
    for (const t of list) {
      const page = byTitle.get(renamed.get(t) ?? t);
      const photo = page ? photoFromCommonsPage(page) : null;
      if (photo) out.push(photo);
    }
    return out;
  }

  /** Files of a category (first `limit`, in the category's sort order). */
  async category(title: string, opts: CommonsPhotoOptions = {}): Promise<Photo[]> {
    const r = await this.query(
      this.params(
        { generator: 'categorymembers', gcmtitle: title, gcmtype: 'file', gcmlimit: String(Math.min(opts.limit ?? 5, 50)) },
        opts.width ?? 800,
      ),
      opts,
    );
    // Generator results come unordered (by page id); sort by title for a stable order.
    return (r.query?.pages ?? [])
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(photoFromCommonsPage)
      .filter((p): p is Photo => !!p);
  }

  /** P18 image(s) and P373 category of a Wikidata item. */
  async wikidataMedia(qid: string, opts: RequestOptions = {}): Promise<{ files: string[]; categories: string[] }> {
    const params = new URLSearchParams({ action: 'wbgetentities', ids: qid, props: 'claims', format: 'json', origin: '*' });
    const r = await this.o.http.getJson<WbEntities>(
      { service: 'wikidata', url: `${this.o.wikidataApi}?${params}`, ttlMs: this.ttlMs },
      opts,
    );
    const claims = r.entities?.[qid]?.claims ?? {};
    const values = (prop: string) => {
      const list = (claims[prop] ?? []).filter((c) => c.rank !== 'deprecated' && c.mainsnak?.snaktype === 'value');
      const preferred = list.filter((c) => c.rank === 'preferred');
      return (preferred.length ? preferred : list)
        .map((c) => c.mainsnak?.datavalue?.value)
        .filter((v): v is string => typeof v === 'string');
    };
    return {
      files: values('P18')
        .map((f) => normalizeCommonsTitle(f, 'File'))
        .filter((t): t is string => !!t),
      categories: values('P373')
        .map((c) => normalizeCommonsTitle(c, 'Category'))
        .filter((t): t is string => !!t),
    };
  }

  /**
   * Photos of a place from its tags: explicit files first (image,
   * wikimedia_commons, Wikidata P18), then category files to fill up.
   */
  async photosFor(tags: OsmTags, opts: CommonsPhotoOptions = {}): Promise<Photo[]> {
    const limit = opts.limit ?? 5;
    const refs = parseCommonsRefs(tags);
    const files = [...refs.files];
    const categories = [...refs.categories];
    if (refs.wikidata && files.length < limit) {
      const wd = await this.wikidataMedia(refs.wikidata, opts);
      for (const f of wd.files) if (!files.includes(f)) files.push(f);
      for (const c of wd.categories) if (!categories.includes(c)) categories.push(c);
    }
    const photos = await this.files(files.slice(0, limit), opts);
    for (const cat of categories) {
      if (photos.length >= limit) break;
      const more = await this.category(cat, { ...opts, limit: limit - photos.length + files.length });
      for (const p of more) {
        if (photos.length >= limit) break;
        if (!photos.some((x) => x.id === p.id)) photos.push(p);
      }
    }
    return photos;
  }
}
