import { beforeAll, describe, expect, it } from 'vitest';
import { ready, verifySharingCert, openSharingKey, fromB64Url } from '@triangulair/crypto';
import { AuthError, MemoryAdapter, NetworkError, type FetchLike, type StorageAdapter } from '@triangulair/storage';

import { createIdentity, parseDeviceKeys } from '../identity/create';
import { rotateStoredSharingKey } from './certify';
import {
  EMPTY_DRAFT,
  buildConfig,
  draftFromConfig,
  nextcloudBase,
  nextcloudDavUrl,
  nextcloudShareReadUrl,
  normalizePrefix,
  parseConfig,
  readUrlProblem,
  s3PublicUrl,
  type StorageConfig,
  type StorageDraft,
} from './config';
import { isScratchPath, runConnectionTest } from './connectionTest';
import { s3CorsRules, s3PublicReadPolicy, webDavCorsApache } from './fixes';
import { MigrationCancelled, MigrationConflict, copyAll, planMigration, verifyCopy, verifyPublished } from './migration';
import { LOCAL_ONLY, afterMove, parseStorageState, recoverPendingMove, serializeStorageState } from './state';

beforeAll(async () => {
  await ready();
});

const bytes = (s: string) => new TextEncoder().encode(s);
const draft = (o: Partial<StorageDraft>): StorageDraft => ({ ...EMPTY_DRAFT, ...o });

describe('URL builders', () => {
  it('Nextcloud server and WebDAV folder', () => {
    expect(nextcloudBase('cloud.example.org')).toBe('https://cloud.example.org');
    expect(nextcloudBase('https://x.org/nextcloud/index.php/apps/files/?dir=/')).toBe('https://x.org/nextcloud');
    expect(nextcloudBase('https://x.org/nextcloud/')).toBe('https://x.org/nextcloud');
    expect(nextcloudBase('http://192.168.1.4:8080/login')).toBe('http://192.168.1.4:8080');
    expect(nextcloudBase('')).toBeNull();
    expect(nextcloudDavUrl('cloud.example.org', 'marie')).toBe('https://cloud.example.org/remote.php/dav/files/marie/TrianguLair/');
    expect(nextcloudDavUrl('https://x.org/nc', 'Marie Curie')).toBe('https://x.org/nc/remote.php/dav/files/Marie%20Curie/TrianguLair/');
    expect(nextcloudDavUrl('x.org', ' ')).toBeNull();
  });

  it('Nextcloud share link to public WebDAV folder', () => {
    expect(nextcloudShareReadUrl('https://cloud.example.org/s/AbC123xyz')).toBe('https://cloud.example.org/public.php/dav/files/AbC123xyz/');
    expect(nextcloudShareReadUrl('https://x.org/nc/index.php/s/Tok3n/')).toBe('https://x.org/nc/public.php/dav/files/Tok3n/');
    expect(nextcloudShareReadUrl('https://x.org/public.php/dav/files/Tok3n')).toBe('https://x.org/public.php/dav/files/Tok3n/');
    expect(nextcloudShareReadUrl('https://x.org/apps/files')).toBeNull();
  });

  it('S3 prefix and public URL', () => {
    expect(normalizePrefix('/a//b')).toBe('a/b/');
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix('a/../b')).toBeNull();
    expect(s3PublicUrl('https://s3.fr-par.scw.cloud', 'my-places', 'triangulair/', true)).toBe('https://s3.fr-par.scw.cloud/my-places/triangulair/');
    expect(s3PublicUrl('https://s3.fr-par.scw.cloud/', 'my-places', 'tl', false)).toBe('https://my-places.s3.fr-par.scw.cloud/tl/');
    expect(s3PublicUrl('https://s3.example', 'Bad_Bucket', '', true)).toBeNull();
  });

  it('read address must be certifiable', () => {
    expect(readUrlProblem('https://cloud.example.org/public.php/dav/files/x/')).toBeNull();
    expect(readUrlProblem('http://cloud.example.org/x/')).toBe('readUrlHttp');
    expect(readUrlProblem('https://192.168.1.2/x/')).toBe('readUrlPrivate');
    expect(readUrlProblem('https://nas.local/x/')).toBe('readUrlPrivate');
    expect(readUrlProblem('https://x.org/a?token=1')).toBe('readUrlQuery');
    expect(readUrlProblem('https://u:p@x.org/a/')).toBe('readUrlCredentials');
    expect(readUrlProblem('not a url at all')).toBe('readUrlInvalid');
  });
});

describe('validation', () => {
  it('Nextcloud: builds the config, read address from the share link', () => {
    const { config, problems } = buildConfig(draft({ choice: 'nextcloud', ncServer: 'cloud.example.org', ncUser: 'marie', ncPassword: 'abcde-fghij', ncShareLink: 'https://cloud.example.org/s/Tok' }));
    expect(problems).toEqual([]);
    expect(config).toMatchObject({ kind: 'webdav', flavor: 'nextcloud', url: 'https://cloud.example.org/remote.php/dav/files/marie/TrianguLair/', readUrl: 'https://cloud.example.org/public.php/dav/files/Tok/' });
    expect(draftFromConfig(config!)).toMatchObject({ choice: 'nextcloud', ncServer: 'https://cloud.example.org', ncUser: 'marie', ncShareLink: 'https://cloud.example.org/s/Tok' });
  });

  it('Nextcloud: required fields and a missing share link', () => {
    const { config, problems } = buildConfig(draft({ choice: 'nextcloud' }));
    expect(config).toBeNull();
    expect(problems.map((p) => `${p.field}:${p.code}`)).toEqual(['ncShareLink:readUrlRequired', 'ncServer:required', 'ncUser:required', 'ncPassword:required']);
    const email = buildConfig(draft({ choice: 'nextcloud', ncServer: 'x.org', ncUser: 'm@x.org', ncPassword: 'p', ncShareLink: 'https://x.org/s/T' }));
    expect(email.config).not.toBeNull();
    expect(email.problems).toEqual([{ field: 'ncUser', code: 'ncUserEmail', level: 'warning' }]);
  });

  it('generic WebDAV over http on a LAN: warning only; read address still https', () => {
    const { config, problems } = buildConfig(draft({ choice: 'webdav', davUrl: 'http://192.168.1.10/dav/places', davUser: 'me', davPassword: 'pw', readUrl: 'https://places.example.org/' }));
    expect(problems).toEqual([{ field: 'davUrl', code: 'httpLocal', level: 'warning' }]);
    expect(config).toMatchObject({ kind: 'webdav', flavor: 'generic', url: 'http://192.168.1.10/dav/places/' });
    expect(buildConfig(draft({ choice: 'webdav', davUrl: 'https://u:p@x.org/', davUser: 'a', davPassword: 'b', readUrl: 'https://x.org/p/' })).problems[0]?.code).toBe('urlCredentials');
    expect(buildConfig(draft({ choice: 'webdav', davUrl: 'https://x.org/', davUser: 'a', davPassword: 'b', readUrl: 'http://x.org/p/' })).problems).toEqual([{ field: 'readUrl', code: 'readUrlHttp', level: 'error' }]);
  });

  it('S3: bucket rules, prefix, suggested public URL, defaults', () => {
    const ok = buildConfig(draft({ choice: 's3', s3Endpoint: 's3.fr-par.scw.cloud', s3Bucket: 'my-places', s3Region: 'fr-par', s3AccessKey: 'AK', s3SecretKey: 'SK', s3Prefix: '/triangulair' }));
    expect(ok.problems).toEqual([]);
    expect(ok.config).toMatchObject({ kind: 's3', endpoint: 'https://s3.fr-par.scw.cloud', prefix: 'triangulair/', readUrl: 'https://s3.fr-par.scw.cloud/my-places/triangulair/' });
    const bad = buildConfig(draft({ choice: 's3', s3Endpoint: 'https://s3.x.org', s3Bucket: 'No_Caps', s3AccessKey: 'a', s3SecretKey: 'b', s3Prefix: '', readUrl: 'https://cdn.x.org/' }));
    expect(bad.problems.map((p) => p.code)).toEqual(['bucketInvalid', 'prefixEmpty']);
    const region = buildConfig(draft({ choice: 's3', s3Endpoint: 'https://s3.x.org', s3Bucket: 'bkt', s3AccessKey: 'a', s3SecretKey: 'b' }));
    expect(region.config).toMatchObject({ region: 'us-east-1' });
  });

  it('HTTPS only', () => {
    expect(buildConfig(draft({ choice: 'https', readUrl: 'https://me.codeberg.page/places' })).config).toEqual({ kind: 'https', readUrl: 'https://me.codeberg.page/places/' });
  });

  it('stored configs parse back, unknown ones are refused', () => {
    const c = buildConfig(draft({ choice: 's3', s3Endpoint: 'https://s3.x.org', s3Bucket: 'bkt', s3AccessKey: 'a', s3SecretKey: 'b' })).config!;
    expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(() => parseConfig({ kind: 'ftp', readUrl: 'x' })).toThrow();
    expect(() => parseConfig({ kind: 'webdav', readUrl: 'https://x/' })).toThrow();
  });
});

describe('fixes', () => {
  it('S3 policy grants anonymous GetObject on the prefix only', () => {
    const p = JSON.parse(s3PublicReadPolicy('bkt', 'tl/')) as { Statement: { Action: string[]; Resource: string[] }[] };
    expect(p.Statement[0]).toMatchObject({ Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::bkt/tl/*'] });
    expect(JSON.stringify(p)).not.toContain('ListBucket');
  });
  it('CORS snippets carry the origin and expose ETag', () => {
    const rules = JSON.parse(s3CorsRules('http://127.0.0.1:4319')) as { AllowedOrigins: string[]; ExposeHeaders: string[] }[];
    expect(rules[0]!.AllowedOrigins).toEqual(['http://127.0.0.1:4319']);
    expect(rules.every((r) => r.ExposeHeaders.includes('ETag'))).toBe(true);
    expect(webDavCorsApache('https://app.example')).toContain('Access-Control-Expose-Headers "ETag');
  });
});

/** A storage that is served publicly at `https://pub.example/` through a fake fetch. */
function publicStorage(opts: { status?: number; etag?: boolean; cors?: boolean; serve?: MemoryAdapter } = {}) {
  const mem = new MemoryAdapter();
  const served = opts.serve ?? mem;
  const fetch: FetchLike = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (opts.cors === false && init?.mode !== 'no-cors') throw new TypeError('Failed to fetch');
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
    if (opts.status) return new Response('nope', { status: opts.status });
    const path = decodeURIComponent(url.replace('https://pub.example/', ''));
    const got = await served.get(path);
    if (!got) return new Response('missing', { status: 404 });
    return new Response(got.data as Uint8Array<ArrayBuffer>, { status: 200, headers: opts.etag === false ? {} : { etag: got.etag } });
  };
  return { mem, fetch };
}

const DAV: StorageConfig = { kind: 'webdav', flavor: 'nextcloud', url: 'https://w.example/dav/', username: 'u', password: 'p', readUrl: 'https://pub.example/', conditionalWrites: true };

describe('connection test', () => {
  it('all green on a public, enforcing storage', async () => {
    const { mem, fetch } = publicStorage();
    const seen: string[] = [];
    const r = await runConnectionTest(DAV, { platform: 'web', origin: 'http://127.0.0.1:4319', fetch, makeWriteAdapter: () => mem, onStep: (s) => seen.push(s.map((x) => x.status).join(',')) });
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['reach:ok', 'write:ok', 'conditional:ok', 'publicRead:ok', 'etag:ok', 'certifiable:ok', 'existing:ok']);
    expect(r.ok).toBe(true);
    expect(r.conditionalWrites).toBe(true);
    expect(seen.length).toBeGreaterThan(7);
    // Every test file was cleaned up.
    expect([...mem.store.keys()].filter(isScratchPath)).toEqual([]);
  });

  it('read address not public: Nextcloud share fix; S3: bucket policy to copy', async () => {
    const { mem, fetch } = publicStorage({ status: 401 });
    const r = await runConnectionTest(DAV, { platform: 'native', fetch, makeWriteAdapter: () => mem });
    const pub = r.steps.find((s) => s.id === 'publicRead')!;
    expect(pub).toMatchObject({ status: 'fail', outcome: 'notPublic', detail: 'HTTP 401' });
    expect(pub.fixes.map((f) => f.id)).toEqual(['nextcloudShare']);
    expect(r.ok).toBe(false);
    const s3: StorageConfig = { kind: 's3', endpoint: 'https://s3.x', bucket: 'bkt', region: 'r', accessKeyId: 'a', secretAccessKey: 'b', prefix: 'tl/', pathStyle: true, readUrl: 'https://pub.example/', conditionalWrites: true };
    const r2 = await runConnectionTest(s3, { platform: 'native', fetch, makeWriteAdapter: () => mem });
    const f = r2.steps.find((s) => s.id === 'publicRead')!.fixes[0]!;
    expect(f.id).toBe('s3Policy');
    expect(f.copy).toContain('arn:aws:s3:::bkt/tl/*');
  });

  it('read address showing another folder', async () => {
    const { mem, fetch } = publicStorage({ serve: new MemoryAdapter() });
    const r = await runConnectionTest(DAV, { platform: 'native', fetch, makeWriteAdapter: () => mem });
    expect(r.steps.find((s) => s.id === 'publicRead')).toMatchObject({ status: 'fail', outcome: 'otherFolder' });
  });

  it('web: CORS on the read address, hidden ETag', async () => {
    const cors = publicStorage({ cors: false });
    const r = await runConnectionTest(DAV, { platform: 'web', origin: 'http://a', fetch: cors.fetch, makeWriteAdapter: () => cors.mem });
    expect(r.steps.find((s) => s.id === 'publicRead')).toMatchObject({ status: 'fail', outcome: 'cors' });
    const noEtag = publicStorage({ etag: false });
    const r2 = await runConnectionTest(DAV, { platform: 'web', origin: 'http://a', fetch: noEtag.fetch, makeWriteAdapter: () => noEtag.mem });
    expect(r2.steps.find((s) => s.id === 'etag')).toMatchObject({ status: 'warn', outcome: 'hidden' });
    expect(r2.ok).toBe(true);
  });

  it('credentials rejected; web CORS on the write side; lax conditionals', async () => {
    const failing = (e: Error): StorageAdapter => {
      const m = new MemoryAdapter();
      return Object.assign(Object.create(m) as StorageAdapter, { capabilities: m.capabilities, head: async () => { throw e; } });
    };
    const { fetch } = publicStorage();
    const auth = await runConnectionTest(DAV, { platform: 'native', fetch, makeWriteAdapter: () => failing(new AuthError('no', { status: 401 })) });
    expect(auth.steps[0]).toMatchObject({ id: 'reach', status: 'fail', outcome: 'auth' });
    expect(auth.steps[0]!.fixes[0]!.id).toBe('nextcloudAppPassword');
    const cors = await runConnectionTest(DAV, { platform: 'web', origin: 'http://127.0.0.1:4319', fetch, makeWriteAdapter: () => failing(new NetworkError('fetch failed')) });
    expect(cors.steps[0]).toMatchObject({ outcome: 'cors' });
    expect(cors.steps[0]!.fixes.map((f) => f.id)).toEqual(['nextcloudCors', 'webdavCorsApache', 'webdavCorsNginx']);
    const down = await runConnectionTest(DAV, { platform: 'native', fetch, makeWriteAdapter: () => failing(new NetworkError('fetch failed')) });
    expect(down.steps[0]).toMatchObject({ outcome: 'unreachable' });

    // A server that ignores If-None-Match / If-Match.
    const lax = new MemoryAdapter();
    const put = lax.put.bind(lax);
    lax.put = (p, d) => put(p, d);
    const pub = publicStorage({ serve: lax });
    const r = await runConnectionTest(DAV, { platform: 'native', fetch: pub.fetch, makeWriteAdapter: () => lax });
    expect(r.steps.find((s) => s.id === 'conditional')).toMatchObject({ status: 'warn', outcome: 'emulated' });
    expect(r.conditionalWrites).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('an existing index is reported; HTTPS-only mode', async () => {
    const { mem, fetch } = publicStorage();
    mem.putUnchecked('index.json', bytes('{}'));
    const r = await runConnectionTest(DAV, { platform: 'native', fetch, makeWriteAdapter: () => mem });
    expect(r.hasIndex).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ id: 'existing', status: 'warn', outcome: 'found' });
    const https = await runConnectionTest({ kind: 'https', readUrl: 'https://pub.example/' }, { platform: 'native', fetch });
    expect(https.steps.map((s) => `${s.id}:${s.outcome}`)).toEqual(['reach:indexFound', 'certifiable:ok']);
    const empty = publicStorage();
    const none = await runConnectionTest({ kind: 'https', readUrl: 'https://pub.example/' }, { platform: 'native', fetch: empty.fetch });
    expect(none.steps[0]).toMatchObject({ status: 'warn', outcome: 'nothingPublished' });
  });

  it('a read address that cannot be certified fails', async () => {
    const { mem, fetch } = publicStorage();
    const r = await runConnectionTest({ ...DAV, readUrl: 'https://192.168.1.2/pub/' }, { platform: 'native', fetch, makeWriteAdapter: () => mem });
    expect(r.steps.find((s) => s.id === 'certifiable')).toMatchObject({ status: 'fail', outcome: 'readUrlPrivate' });
  });
});

/** A storage with packs, photos, an index, odd names and an empty file. */
function seeded(): MemoryAdapter {
  const m = new MemoryAdapter();
  for (let i = 0; i < 25; i++) m.putUnchecked(`packs/b2b256-${i}.bin`, bytes(`pack ${i} `.repeat(i + 1)));
  m.putUnchecked('media/photo-1.bin', new Uint8Array(50_000).map((_, i) => i % 251));
  m.putUnchecked('media/thumb é ü.bin', bytes('unicode name'));
  m.putUnchecked('public/lists.geojson', bytes('{"type":"FeatureCollection","features":[]}'));
  m.putUnchecked('empty.bin', new Uint8Array(0));
  m.putUnchecked('index.json', bytes('{"seq":1}'));
  m.putUnchecked('index.v5.json', bytes('{"seq":1,"v":5}'));
  m.putUnchecked('.triangulair-probe-abc', bytes('x'));
  return m;
}

async function sameContent(a: MemoryAdapter, b: MemoryAdapter): Promise<void> {
  const la = (await a.list('')).filter((e) => !isScratchPath(e.path));
  const lb = await b.list('');
  expect(lb.map((e) => e.path)).toEqual(la.map((e) => e.path));
  for (const e of la) expect(Array.from((await b.get(e.path))!.data)).toEqual(Array.from((await a.get(e.path))!.data));
}

describe('migration', () => {
  it('lossless: every file copied byte for byte, index last, verified', async () => {
    const from = seeded();
    const to = new MemoryAdapter();
    const order: string[] = [];
    const put = to.put.bind(to);
    to.put = (p, d, o) => (order.push(p), put(p, d, o));
    const plan = await planMigration(from, to);
    expect(plan.kind).toBe('copy');
    expect(plan.files.map((f) => f.path)).not.toContain('.triangulair-probe-abc');
    expect(plan.files.slice(-2).map((f) => f.path)).toEqual(['index.json', 'index.v5.json']);
    expect(plan.hasIndex).toBe(true);
    const progress: number[] = [];
    const res = await copyAll(plan, from, to, { onProgress: (p) => progress.push(p.done) });
    expect(res).toMatchObject({ copied: plan.files.length, skipped: 0, rounds: 1 });
    expect(order.slice(-2)).toEqual(['index.json', 'index.v5.json']);
    expect(progress.at(-1)).toBe(plan.files.length);
    await sameContent(from, to);
    const v = await verifyCopy(res.hashes, to);
    expect(v).toEqual({ ok: true, checked: plan.files.length, missing: [], mismatched: [] });
    // The source was not touched.
    expect((await from.list('')).length).toBe(plan.files.length + 1);
  });

  it('cancel then resume: nothing lost, already copied files skipped', async () => {
    const from = seeded();
    const to = new MemoryAdapter();
    const ctl = new AbortController();
    const plan = await planMigration(from, to);
    await expect(
      copyAll(plan, from, to, { concurrency: 1, signal: ctl.signal, onProgress: (p) => p.done === 5 && ctl.abort() }),
    ).rejects.toBeInstanceOf(MigrationCancelled);
    expect(await to.head('index.json')).toBeNull(); // the index is never written before the data
    const n = (await to.list('')).length;
    expect(n).toBeGreaterThanOrEqual(5);
    const again = await planMigration(from, to);
    const res = await copyAll(again, from, to);
    expect(res.skipped).toBe(n);
    expect(res.copied).toBe(again.files.length - n);
    await sameContent(from, to);
    expect((await verifyCopy(res.hashes, to)).ok).toBe(true);
  });

  it('refuses to overwrite other content at the destination', async () => {
    const from = seeded();
    const to = new MemoryAdapter();
    to.putUnchecked('index.json', bytes('{"someone":"else","seq":99}'));
    const plan = await planMigration(from, to);
    expect(plan.conflicts).toEqual(['index.json']);
    await expect(copyAll(plan, from, to)).rejects.toBeInstanceOf(MigrationConflict);
    // Same size, other bytes: found while copying.
    const to2 = new MemoryAdapter();
    to2.putUnchecked('packs/b2b256-0.bin', bytes('PACK 0 '));
    const p2 = await planMigration(from, to2);
    expect(p2.conflicts).toEqual([]);
    await expect(copyAll(p2, from, to2)).rejects.toBeInstanceOf(MigrationConflict);
    expect(new TextDecoder().decode((await to2.get('packs/b2b256-0.bin'))!.data)).toBe('PACK 0 ');
    expect(await to2.head('index.json')).toBeNull();
  });

  it('copies what another device publishes during the copy', async () => {
    const from = seeded();
    const to = new MemoryAdapter();
    const plan = await planMigration(from, to);
    let once = false;
    const res = await copyAll(plan, from, to, {
      concurrency: 1,
      onProgress: (p) => {
        if (!once && p.done === 3) {
          once = true;
          from.putUnchecked('packs/b2b256-new.bin', bytes('published meanwhile'));
          from.putUnchecked('index.json', bytes('{"seq":2}'));
        }
      },
    });
    expect(res.rounds).toBe(2);
    await sameContent(from, to);
    expect(new TextDecoder().decode((await to.get('index.json'))!.data)).toBe('{"seq":2}');
    expect((await verifyCopy(res.hashes, to)).ok).toBe(true);
  });

  it('an ETag that changes without new content (weak or coarse ETags settling) is not a change', async () => {
    const from = seeded();
    const to = new MemoryAdapter();
    const plan = await planMigration(from, to);
    let once = false;
    const res = await copyAll(plan, from, to, {
      concurrency: 1,
      onProgress: (p) => {
        if (!once && p.done === 4) {
          once = true;
          // Same bytes, new ETag (the memory adapter gives every write a new one).
          for (const f of plan.files.slice(0, 3)) from.putUnchecked(f.path, from.store.get(f.path)!.data);
        }
      },
    });
    expect(res.copied).toBe(plan.files.length);
    await sameContent(from, to);
  });

  it('verify finds missing and altered files', async () => {
    const from = seeded();
    const to = new MemoryAdapter();
    const res = await copyAll(await planMigration(from, to), from, to);
    await to.delete('media/photo-1.bin');
    to.putUnchecked('packs/b2b256-3.bin', bytes('tampered'));
    const v = await verifyCopy(res.hashes, to);
    expect(v).toMatchObject({ ok: false, missing: ['media/photo-1.bin'], mismatched: ['packs/b2b256-3.bin'] });
  });

  it('plans for local only, HTTPS-only source and destination', async () => {
    expect((await planMigration(null, new MemoryAdapter())).kind).toBe('connect');
    const ro = new MemoryAdapter({ readOnly: true });
    ro.putUnchecked('index.json', bytes('{}'));
    const fromRo = Object.assign(Object.create(ro) as StorageAdapter, { capabilities: { ...ro.capabilities, list: false } });
    expect(await planMigration(fromRo, new MemoryAdapter())).toMatchObject({ kind: 'source-read-only', hasIndex: true });
    const from = seeded();
    const published = new MemoryAdapter({ readOnly: true });
    const plan = await planMigration(from, published);
    expect(plan.kind).toBe('target-read-only');
    expect((await verifyPublished(plan, from, published)).ok).toBe(false);
    for (const f of plan.files) published.putUnchecked(f.path, (await from.get(f.path))!.data);
    expect((await verifyPublished(plan, from, published)).ok).toBe(true);
  });
});

describe('certify the read address', () => {
  it('rotation + 1 with the new location, same key, primary device or phrase', () => {
    const created = createIdentity({ primary: true, now: 1 });
    const r = rotateStoredSharingKey(created.record, created.secrets, { location: 'https://pub.example/a/' }, { kind: 'primary' });
    expect(r.previous.rotation).toBe(0);
    expect(r.cert).toMatchObject({ rotation: 1, location: 'https://pub.example/a/', key: r.previous.key });
    verifySharingCert(r.cert, { expectedOwner: created.record.owner, lastSeen: r.previous });
    const opened = openSharingKey(fromB64Url(r.sealedForThisDevice, 's'), parseDeviceKeys(created.secrets.deviceKeys), { expectedOwner: created.record.owner, lastSeen: r.previous });
    expect(opened.cert.location).toBe('https://pub.example/a/');

    // Move: rotation 2, from the typed phrase (not a primary device).
    const secrets2 = { ...created.secrets, sharingKey: r.sealedForThisDevice, primaryIdentity: null };
    expect(() => rotateStoredSharingKey(created.record, secrets2, { location: 'https://pub.example/b/' }, { kind: 'primary' })).toThrow('master-key-needed');
    const other = createIdentity({ primary: false });
    expect(() => rotateStoredSharingKey(created.record, secrets2, { location: 'https://pub.example/b/' }, { kind: 'phrase', phrase: other.phrase })).toThrow('phrase-mismatch');
    const r2 = rotateStoredSharingKey(created.record, secrets2, { location: 'https://pub.example/b/' }, { kind: 'phrase', phrase: `  ${created.phrase.toUpperCase()} ` });
    expect(r2.cert).toMatchObject({ rotation: 2, location: 'https://pub.example/b/' });
    expect(() => rotateStoredSharingKey(created.record, secrets2, { location: 'http://pub.example/b/' }, { kind: 'phrase', phrase: created.phrase })).toThrow();
  });

  it('declaration of loss: new key, revoked device kept', () => {
    const created = createIdentity({ primary: true });
    const lost = createIdentity({ primary: false }).record.deviceId;
    const r = rotateStoredSharingKey(created.record, created.secrets, { revokeDevices: [lost], newKey: true }, { kind: 'primary' });
    expect(r.cert.key).not.toBe(r.previous.key);
    expect(r.cert.revoked_devices).toEqual([lost]);
    expect(r.cert.location).toBeUndefined();
  });
});

describe('storage state', () => {
  const A: StorageConfig = { kind: 'https', readUrl: 'https://a.example/' };
  const B: StorageConfig = { ...DAV, readUrl: 'https://b.example/' };

  it('round-trips and survives garbage', () => {
    const s = afterMove({ ...LOCAL_ONLY, current: A }, B, 1000, 50);
    expect(parseStorageState(serializeStorageState(s))).toEqual(s);
    expect(s).toMatchObject({ current: B, previous: [{ config: A, movedAt: 1000, keepUntil: 1050 }], republishPending: true });
    expect(parseStorageState('{oops')).toEqual(LOCAL_ONLY);
    expect(parseStorageState(JSON.stringify({ version: 9 }))).toEqual(LOCAL_ONLY);
    expect(parseStorageState(null)).toEqual(LOCAL_ONLY);
  });

  it('moving back to an old storage removes its redirect entry', () => {
    const s = afterMove(afterMove({ ...LOCAL_ONLY, current: A }, B, 1, 10), A, 2, 10);
    expect(s.current).toEqual(A);
    expect(s.previous.map((p) => p.config.readUrl)).toEqual(['https://b.example/']);
  });

  it('an interrupted move is finished only if the certificate was issued', () => {
    const pending = { ...LOCAL_ONLY, current: A, pendingMove: { to: B, startedAt: 5 } };
    expect(recoverPendingMove(pending, 'https://b.example/', 9, 10)).toMatchObject({ current: B, pendingMove: null });
    expect(recoverPendingMove(pending, 'https://a.example/', 9, 10)).toMatchObject({ current: A, pendingMove: null, previous: [] });
  });
});
