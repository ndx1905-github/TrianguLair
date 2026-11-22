/**
 * Storage settings (T-203, spec "Storage protocols" and "Tech stack and
 * self-hosting"): what the owner fills in for each protocol, the URL builders
 * (Nextcloud, S3) and the validation. Pure and unit-tested; no network.
 *
 * A storage has two addresses:
 * - the **write** side, used by my devices with credentials (WebDAV URL + app
 *   password, S3 endpoint + bucket + keys);
 * - the **read address** (HTTPS, public, no credentials) that friends read and
 *   that the master key certifies in the sharing certificate (`location`). The
 *   index is the file `index.json` right under it, so it always ends with "/".
 *
 * SFTP is not configurable here (decided in T-202): `ssh2` needs Node and no native
 * SFTP module is shipped (storage README "SFTP on mobile"), so on a phone it is "desktop
 * only" and the HTTPS mode is offered instead (a sync tool or the desktop app writes the
 * folder, friends and the phone read it over HTTPS).
 */
import { checkLocation } from '@triangulair/crypto';

export const STORAGE_CONFIG_VERSION = 1;
/** Region used when none is typed (most S3-compatible providers accept it). */
export const DEFAULT_S3_REGION = 'us-east-1';

export type StorageKind = 'webdav' | 's3' | 'https';
/** What the wizard offers; `sftp` is shown as desktop only, `local` means no storage. */
export type StorageChoice = 'local' | 'nextcloud' | 'webdav' | 's3' | 'sftp' | 'https';

export interface WebDavConfig {
  kind: 'webdav';
  /** How it was set up (the form to show again); the adapter is the same. */
  flavor: 'nextcloud' | 'generic';
  /** Collection URL acting as root, ending with "/". */
  url: string;
  username: string;
  /** App password (Nextcloud: Settings › Security › Devices & sessions). */
  password: string;
  readUrl: string;
  /** Result of the conditional-write probe; false: the adapter emulates If-Match (racy). */
  conditionalWrites: boolean;
  /**
   * Nextcloud helper fields, to show the form again. `userId`: the account id of the WebDAV path
   * when it differs from the login name `user` (Login Flow v2 with an email login, LDAP).
   */
  nextcloud?: { server: string; user: string; shareLink: string; userId?: string };
}

export interface S3Config {
  kind: 's3';
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "" or "a/b/" (no leading slash, ends with "/"). */
  prefix: string;
  pathStyle: boolean;
  readUrl: string;
  conditionalWrites: boolean;
}

/** Publishing by other means (static pages, Git, a sync tool): the app only reads. */
export interface HttpsConfig {
  kind: 'https';
  readUrl: string;
}

export type StorageConfig = WebDavConfig | S3Config | HttpsConfig;

/** Form state: every field a string, as typed. */
export interface StorageDraft {
  choice: Exclude<StorageChoice, 'local' | 'sftp'>;
  // Nextcloud
  ncServer: string;
  ncUser: string;
  ncPassword: string;
  ncShareLink: string;
  /** Set by the Login Flow when the account id differs from the login name ("" otherwise). */
  ncUserId: string;
  // Generic WebDAV
  davUrl: string;
  davUser: string;
  davPassword: string;
  // S3
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Prefix: string;
  s3PathStyle: boolean;
  // Every protocol: the HTTPS read address for friends.
  readUrl: string;
}

export const EMPTY_DRAFT: StorageDraft = {
  choice: 'nextcloud',
  ncServer: '',
  ncUser: '',
  ncPassword: '',
  ncShareLink: '',
  ncUserId: '',
  davUrl: '',
  davUser: '',
  davPassword: '',
  s3Endpoint: '',
  s3Bucket: '',
  s3Region: '',
  s3AccessKey: '',
  s3SecretKey: '',
  s3Prefix: 'triangulair/',
  s3PathStyle: true,
  readUrl: '',
};

/** Field names of the draft that can carry a problem. */
export type DraftField = Exclude<keyof StorageDraft, 'choice' | 's3PathStyle' | 'ncUserId'>;

/** A validation problem: i18n key `storage.problem.<code>`. Warnings do not block. */
export interface DraftProblem {
  field: DraftField;
  code: string;
  level: 'error' | 'warning';
}

/** Folder the app uses on a Nextcloud account. */
export const NEXTCLOUD_FOLDER = 'TrianguLair';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|[^.]+$|.*\.(local|lan|home|internal|localhost)$)/i;

/** Lenient URL parse: adds https:// when no scheme is typed. Null when it is not an http(s) URL. */
export function parseUrl(input: string): URL | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

/** Same URL, without query or fragment, path ending with "/". */
export function folderUrl(u: URL): string {
  const v = new URL(u.href);
  v.search = '';
  v.hash = '';
  if (!v.pathname.endsWith('/')) v.pathname += '/';
  return v.href;
}

export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST.test(hostname);
}

/**
 * Nextcloud server address as typed ("cloud.example.org", "https://x.org/nextcloud/index.php/apps/files")
 * → base URL without trailing slash ("https://x.org/nextcloud"). Null if not a URL.
 */
export function nextcloudBase(server: string): string | null {
  const u = parseUrl(server);
  if (!u) return null;
  let path = u.pathname;
  const cut = path.search(/\/(index\.php|remote\.php|public\.php|apps|login|s)(\/|$)/);
  if (cut >= 0) path = path.slice(0, cut);
  path = path.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** WebDAV folder of the app on a Nextcloud account: `<base>/remote.php/dav/files/<user>/TrianguLair/`. */
export function nextcloudDavUrl(server: string, user: string): string | null {
  const base = nextcloudBase(server);
  const u = user.trim();
  if (!base || !u) return null;
  return `${base}/remote.php/dav/files/${encodeURIComponent(u)}/${NEXTCLOUD_FOLDER}/`;
}

/**
 * Nextcloud public share link of the TrianguLair folder ("https://x.org/s/AbC123",
 * "https://x.org/index.php/s/AbC123") → its public WebDAV folder
 * ("https://x.org/public.php/dav/files/AbC123/", Nextcloud 29 and later), which
 * serves files anonymously by path. A URL that is already a public DAV URL is kept.
 */
/** Only a share link ("…/s/<token>", "…/index.php/s/<token>") → its public WebDAV folder. */
export function nextcloudShareLinkReadUrl(link: string): string | null {
  const u = parseUrl(link);
  if (!u || !/\/s\/[A-Za-z0-9]+\/?$/.test(u.pathname)) return null;
  return nextcloudShareReadUrl(link);
}

export function nextcloudShareReadUrl(link: string): string | null {
  const u = parseUrl(link);
  if (!u) return null;
  const share = /^(.*?)\/(?:index\.php\/)?s\/([A-Za-z0-9]+)\/?$/.exec(u.pathname);
  if (share) return `${u.protocol}//${u.host}${share[1]}/public.php/dav/files/${share[2]}/`;
  if (/\/public\.php\/dav\/files\/[A-Za-z0-9]+\/?$/.test(u.pathname)) return folderUrl(u);
  return null;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** "a//b" "/a/b" "a/b" → "a/b/"; "" stays "". Null for "." / ".." segments. */
export function normalizePrefix(prefix: string): string | null {
  const parts = prefix.trim().split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return parts.length ? `${parts.join('/')}/` : '';
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Default public read address of an S3 prefix: path style `<endpoint>/<bucket>/<prefix>`,
 * virtual-hosted style `<scheme>://<bucket>.<host>/<prefix>`. Friends need a bucket policy
 * allowing anonymous GetObject on it (see fixes.ts).
 */
export function s3PublicUrl(endpoint: string, bucket: string, prefix: string, pathStyle: boolean): string | null {
  const ep = parseUrl(endpoint);
  const p = normalizePrefix(prefix);
  if (!ep || !BUCKET.test(bucket.trim()) || p === null) return null;
  const keyPath = p.split('/').filter(Boolean).map(rfc3986).join('/');
  const base = ep.pathname.replace(/\/+$/, '');
  const root = pathStyle ? `${ep.protocol}//${ep.host}${base}/${bucket.trim()}/` : `${ep.protocol}//${bucket.trim()}.${ep.host}${base}/`;
  return root + (keyPath ? `${keyPath}/` : '');
}

/** The read address the wizard suggests when the field is empty. */
export function suggestedReadUrl(d: StorageDraft): string | null {
  if (d.choice === 'nextcloud') return d.ncShareLink.trim() ? nextcloudShareReadUrl(d.ncShareLink) : null;
  if (d.choice === 's3') return s3PublicUrl(d.s3Endpoint, d.s3Bucket, d.s3Prefix, d.s3PathStyle);
  return null;
}

/**
 * Read address problems. It is certified by the master key, so it must pass the crypto
 * package's `checkLocation` (canonical https:// URL on a public host).
 */
export function readUrlProblem(url: string): string | null {
  const u = parseUrl(url);
  if (!u) return 'readUrlInvalid';
  if (u.protocol !== 'https:') return 'readUrlHttp';
  if (u.search || u.hash || url.includes('#')) return 'readUrlQuery';
  if (u.username || u.password) return 'readUrlCredentials';
  try {
    checkLocation(folderUrl(u));
  } catch {
    return 'readUrlPrivate';
  }
  return null;
}

function writeUrlProblems(field: DraftField, input: string, out: DraftProblem[]): URL | null {
  const u = parseUrl(input);
  if (!u) {
    out.push({ field, code: input.trim() ? 'urlInvalid' : 'required', level: 'error' });
    return null;
  }
  if (u.username || u.password) out.push({ field, code: 'urlCredentials', level: 'error' });
  // Content is encrypted, but the app password would travel in clear.
  else if (u.protocol === 'http:') out.push({ field, code: isPrivateHost(u.hostname) ? 'httpLocal' : 'httpPublic', level: 'warning' });
  return u;
}

function required(field: DraftField, value: string, out: DraftProblem[]): void {
  if (!value.trim()) out.push({ field, code: 'required', level: 'error' });
}

/** Validates a draft and builds the config (probe result unknown yet: conditional writes assumed). */
export function buildConfig(d: StorageDraft): { config: StorageConfig | null; problems: DraftProblem[] } {
  const problems: DraftProblem[] = [];
  const readInput = d.readUrl.trim() || suggestedReadUrl(d) || '';
  const readField: DraftField = !d.readUrl.trim() && d.choice === 'nextcloud' ? 'ncShareLink' : 'readUrl';
  if (!readInput) {
    problems.push({ field: readField, code: d.choice === 'nextcloud' && d.ncShareLink.trim() ? 'shareLinkInvalid' : 'readUrlRequired', level: 'error' });
  } else {
    const p = readUrlProblem(readInput);
    if (p) problems.push({ field: readField, code: p, level: 'error' });
  }
  // A Nextcloud share link ("…/s/<token>") only serves an HTML page: whatever the storage type
  // chosen (Nextcloud, or a Nextcloud folder set up as generic WebDAV), read through its public
  // WebDAV address instead.
  const readU = parseUrl((d.choice === 'nextcloud' || d.choice === 'webdav' ? nextcloudShareLinkReadUrl(readInput) : null) ?? readInput);
  const readUrl = readU ? folderUrl(readU) : '';
  let config: StorageConfig | null = null;

  if (d.choice === 'nextcloud') {
    if (!d.ncServer.trim()) required('ncServer', d.ncServer, problems);
    else {
      const u = writeUrlProblems('ncServer', d.ncServer, problems);
      if (u && /@/.test(d.ncUser) && !d.ncUser.includes('%')) problems.push({ field: 'ncUser', code: 'ncUserEmail', level: 'warning' });
    }
    required('ncUser', d.ncUser, problems);
    required('ncPassword', d.ncPassword, problems);
    const userId = d.ncUserId.trim();
    const url = nextcloudDavUrl(d.ncServer, userId || d.ncUser);
    if (url) {
      config = {
        kind: 'webdav',
        flavor: 'nextcloud',
        url,
        username: d.ncUser.trim(),
        password: d.ncPassword.trim(),
        readUrl,
        conditionalWrites: true,
        nextcloud: {
          server: nextcloudBase(d.ncServer) ?? d.ncServer.trim(),
          user: d.ncUser.trim(),
          shareLink: d.ncShareLink.trim(),
          ...(userId && userId !== d.ncUser.trim() ? { userId } : {}),
        },
      };
    }
  } else if (d.choice === 'webdav') {
    const u = writeUrlProblems('davUrl', d.davUrl, problems);
    required('davUser', d.davUser, problems);
    required('davPassword', d.davPassword, problems);
    if (u) config = { kind: 'webdav', flavor: 'generic', url: folderUrl(u), username: d.davUser.trim(), password: d.davPassword, readUrl, conditionalWrites: true };
  } else if (d.choice === 's3') {
    const ep = writeUrlProblems('s3Endpoint', d.s3Endpoint, problems);
    const bucket = d.s3Bucket.trim();
    if (!bucket) required('s3Bucket', bucket, problems);
    else if (!BUCKET.test(bucket) || bucket.includes('..')) problems.push({ field: 's3Bucket', code: 'bucketInvalid', level: 'error' });
    required('s3AccessKey', d.s3AccessKey, problems);
    required('s3SecretKey', d.s3SecretKey, problems);
    const prefix = normalizePrefix(d.s3Prefix);
    if (prefix === null) problems.push({ field: 's3Prefix', code: 'prefixInvalid', level: 'error' });
    else if (prefix === '') problems.push({ field: 's3Prefix', code: 'prefixEmpty', level: 'warning' });
    if (ep) {
      config = {
        kind: 's3',
        endpoint: `${ep.protocol}//${ep.host}${ep.pathname.replace(/\/+$/, '')}`,
        bucket,
        region: d.s3Region.trim() || DEFAULT_S3_REGION,
        accessKeyId: d.s3AccessKey.trim(),
        secretAccessKey: d.s3SecretKey.trim(),
        prefix: prefix ?? '',
        pathStyle: d.s3PathStyle,
        readUrl,
        conditionalWrites: true,
      };
    }
  } else {
    config = { kind: 'https', readUrl };
  }
  const blocking = problems.some((p) => p.level === 'error');
  return { config: blocking ? null : config, problems };
}

/** Back to a form (change the settings of the current storage). */
export function draftFromConfig(c: StorageConfig): StorageDraft {
  if (c.kind === 'https') return { ...EMPTY_DRAFT, choice: 'https', readUrl: c.readUrl };
  if (c.kind === 's3') {
    return {
      ...EMPTY_DRAFT,
      choice: 's3',
      s3Endpoint: c.endpoint,
      s3Bucket: c.bucket,
      s3Region: c.region,
      s3AccessKey: c.accessKeyId,
      s3SecretKey: c.secretAccessKey,
      s3Prefix: c.prefix,
      s3PathStyle: c.pathStyle,
      readUrl: c.readUrl,
    };
  }
  if (c.flavor === 'nextcloud' && c.nextcloud) {
    return { ...EMPTY_DRAFT, choice: 'nextcloud', ncServer: c.nextcloud.server, ncUser: c.nextcloud.user, ncPassword: c.password, ncShareLink: c.nextcloud.shareLink, ncUserId: c.nextcloud.userId ?? '', readUrl: c.readUrl };
  }
  return { ...EMPTY_DRAFT, choice: 'webdav', davUrl: c.url, davUser: c.username, davPassword: c.password, readUrl: c.readUrl };
}

/** The certified read address (`location` of the sharing certificate). */
export function readAddressOf(c: StorageConfig): string {
  return c.readUrl;
}

/** Short protocol name for the kit's notes and the settings ("WebDAV (Nextcloud)", "S3"…). */
export function protocolOf(c: StorageConfig): 'nextcloud' | 'webdav' | 's3' | 'https' {
  return c.kind === 'webdav' ? (c.flavor === 'nextcloud' ? 'nextcloud' : 'webdav') : c.kind;
}

/** Where the owner writes, without credentials (shown in the settings). */
export function writeAddressOf(c: StorageConfig): string | null {
  if (c.kind === 'webdav') return c.url;
  if (c.kind === 's3') return `${c.endpoint} · ${c.bucket}${c.prefix ? `/${c.prefix}` : ''}`;
  return null;
}

/** Two configs point at the same place (moving to it would copy a folder onto itself). */
export function sameStorage(a: StorageConfig, b: StorageConfig): boolean {
  if (a.kind !== b.kind) return a.readUrl === b.readUrl;
  if (a.kind === 'webdav' && b.kind === 'webdav') return a.url === b.url;
  if (a.kind === 's3' && b.kind === 's3') return a.endpoint === b.endpoint && a.bucket === b.bucket && a.prefix === b.prefix;
  return a.readUrl === b.readUrl;
}

/**
 * Same storage, same read address, same write endpoint: only the credentials may differ (devices
 * review F-01: settings from the vault are taken by a device only when this holds).
 */
export function sameWriteTarget(a: StorageConfig, b: StorageConfig): boolean {
  if (a.kind !== b.kind || a.readUrl !== b.readUrl) return false;
  if (a.kind === 'webdav' && b.kind === 'webdav') return a.url === b.url;
  if (a.kind === 's3' && b.kind === 's3') return a.endpoint === b.endpoint && a.bucket === b.bucket && a.prefix === b.prefix && a.region === b.region && a.pathStyle === b.pathStyle;
  return a.kind === 'https';
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`storage config: ${k}`);
  return v;
}

/** Defensive parse of a stored config (secret store). Throws on anything unexpected. */
export function parseConfig(v: unknown): StorageConfig {
  if (!v || typeof v !== 'object') throw new Error('storage config: not an object');
  const o = v as Record<string, unknown>;
  const readUrl = str(o, 'readUrl');
  if (o['kind'] === 'https') return { kind: 'https', readUrl };
  const conditionalWrites = o['conditionalWrites'] !== false;
  if (o['kind'] === 'webdav') {
    const nc = o['nextcloud'] as Record<string, unknown> | undefined;
    // 0.9.0-beta.1 kept a share link pasted as the read address of a generic WebDAV storage as is.
    const shareRead = nextcloudShareLinkReadUrl(readUrl);
    return {
      kind: 'webdav',
      flavor: o['flavor'] === 'nextcloud' ? 'nextcloud' : 'generic',
      url: str(o, 'url'),
      username: str(o, 'username'),
      password: str(o, 'password'),
      readUrl: shareRead ?? readUrl,
      conditionalWrites,
      ...(nc && typeof nc === 'object'
        ? { nextcloud: { server: str(nc, 'server'), user: str(nc, 'user'), shareLink: str(nc, 'shareLink'), ...(typeof nc['userId'] === 'string' && nc['userId'] ? { userId: nc['userId'] } : {}) } }
        : {}),
    };
  }
  if (o['kind'] === 's3') {
    return {
      kind: 's3',
      endpoint: str(o, 'endpoint'),
      bucket: str(o, 'bucket'),
      region: str(o, 'region'),
      accessKeyId: str(o, 'accessKeyId'),
      secretAccessKey: str(o, 'secretAccessKey'),
      prefix: str(o, 'prefix'),
      pathStyle: o['pathStyle'] !== false,
      readUrl,
      conditionalWrites,
    };
  }
  throw new Error('storage config: unknown kind');
}
