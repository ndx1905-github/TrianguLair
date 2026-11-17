// SPDX-License-Identifier: MPL-2.0
/**
 * Simulated storage failures at the wire level (T-202), with real sync engines and real HTTP
 * adapters: the storage package's fault proxy sits between Alice's WebDAV adapter and an
 * in-process WebDAV server (Nephele, which streams uploads straight into the target file, so a
 * cut upload leaves a truncated file, as WsgiDAV does). Checks the typed problem the engine
 * reports, that friends never see a partial publication, and that the next pass recovers.
 * (error-cases.test.ts covers the same rows with faults injected above the adapter.)
 */
import { WebDavAdapter } from '@triangulair/storage';
import { startFaultProxy, type FaultProxy } from '@triangulair/storage/testing/faults';
import { afterEach, describe, expect, it } from 'vitest';
import { startDav } from '../../storage/test/support/dav-server.ts';
import { SyncScheduler, type Timers } from '../src/scheduler.ts';
import type { SyncEngine } from '../src/engine.ts';
import { addDevice, befriend, friendSaves, makeUser, point, World } from './helpers.ts';

const ownProblem = (r: Awaited<ReturnType<SyncEngine['sync']>>) => r.problems.find((p) => p.about === 'own')?.problem;

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

/** Alice writes to WebDAV through the fault proxy; Bob follows her (reading through the same proxy). */
async function pair(): Promise<{
  proxy: FaultProxy;
  raw: WebDavAdapter;
  alice: ReturnType<typeof addDevice>;
  bob: ReturnType<typeof addDevice>;
  owner: string;
}> {
  const srv = await startDav();
  const proxy = await startFaultProxy(`${srv.url}/dav/`);
  closers.push(async () => (await proxy.close(), await srv.close()));
  const auth = { username: 'alice', password: 's3cret' };
  const storage = new WebDavAdapter({ baseUrl: proxy.url, auth, timeoutMs: 500 });
  const raw = new WebDavAdapter({ baseUrl: `${srv.url}/dav/`, auth });
  const w = new World();
  const user = makeUser(w, 'alice', { storage });
  const alice = addDevice(w, user, { concurrency: 4 });
  const bob = addDevice(w, makeUser(w, 'bob'));
  alice.store.putSave({ place: point(1, 'Le Comptoir'), comment: 'v1' });
  expect((await alice.engine.sync()).ok).toBe(true);
  await bob.engine.sync();
  await befriend(w, alice, bob);
  expect((await alice.engine.sync()).ok).toBe(true);
  await bob.engine.sync();
  expect(friendSaves(bob, user.owner).get('osm:node/1')?.comment).toBe('v1');
  return { proxy, raw, alice, bob, owner: user.owner };
}

function clock(): Timers {
  return { setTimeout: () => 0, clearTimeout: () => {}, now: () => 0 };
}

describe('sync with wire-level storage faults (WebDAV through the fault proxy)', () => {
  it('connection lost in the middle of the index upload: the server keeps a TRUNCATED index; the next pass repairs it', async () => {
    const { proxy, raw, alice, bob, owner } = await pair();
    const before = (await raw.get('index.json'))!;
    alice.store.updateSave('osm:node/1', { comment: 'v2' });
    alice.store.putSave({ place: point(2, 'Café Pendule') });
    proxy.inject({ method: 'PUT', path: /\/index\.json$/, times: 1, action: { kind: 'drop-upload', afterBytes: 200 } });
    const r = await alice.engine.sync();
    expect(r.ok).toBe(false);
    expect(ownProblem(r)).toMatchObject({ kind: 'unreachable', retryable: true, blocksWrites: false });
    await new Promise((res) => setTimeout(res, 100));
    // What the server really holds now: the first bytes of the new index (Nephele, WsgiDAV).
    const damaged = (await raw.get('index.json'))!;
    expect(damaged.data.byteLength).toBeLessThan(before.data.byteLength + 1000);
    expect(new TextDecoder().decode(damaged.data)).not.toBe(new TextDecoder().decode(before.data));
    // Bob: the damaged index does not verify; his cache stays as it was (no partial state).
    const rb = await bob.engine.sync();
    expect(rb.problems.find((p) => p.about === owner)?.problem.kind).toBe('tampered');
    expect(friendSaves(bob, owner).get('osm:node/1')?.comment).toBe('v1');
    expect(friendSaves(bob, owner).has('osm:node/2')).toBe(false);
    // Alice's next pass: her own damaged index is republished above the anchor.
    const r2 = await alice.engine.sync();
    expect(r2.problems).toEqual([]);
    expect(r2.ok).toBe(true);
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')?.comment).toBe('v2');
    expect(friendSaves(bob, owner).has('osm:node/2')).toBe(true);
  });

  it('connection lost in the middle of a pack upload: the index is untouched, the pass is retried', async () => {
    const { proxy, raw, alice, bob, owner } = await pair();
    const before = (await raw.head('index.json'))!.etag;
    const from = proxy.log.length;
    alice.store.updateSave('osm:node/1', { comment: 'v2' });
    proxy.inject({ method: 'PUT', path: /\/(packs|media)\//, times: 1, action: { kind: 'drop-upload', afterBytes: 50 } });
    const r = await alice.engine.sync();
    expect(r.ok).toBe(false);
    expect(proxy.log.slice(from).some((l) => l.fault === 'drop-upload')).toBe(true);
    expect(proxy.log.slice(from).filter((l) => l.method === 'PUT' && l.path.endsWith('/index.json'))).toEqual([]);
    expect((await raw.head('index.json'))!.etag).toBe(before);
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')?.comment).toBe('v1');
    expect((await alice.engine.sync()).ok).toBe(true);
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')?.comment).toBe('v2');
  });

  it('timeout: a storage that does not answer is "unreachable" (retryable) within the adapter timeout, then retried by the scheduler', async () => {
    const { proxy, alice, bob, owner } = await pair();
    alice.store.updateSave('osm:node/1', { comment: 'after the timeout' });
    proxy.inject({ action: { kind: 'hang' } });
    const runs: string[] = [];
    const s = new SyncScheduler({ run: (reason, o) => (runs.push(reason), alice.engine.sync(o)), timers: clock(), backoffMs: [30_000] });
    s.localChange();
    const t0 = Date.now();
    await s.pullToRefresh();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(s.getStatus().problem).toMatchObject({ kind: 'unreachable', situation: 'My storage unreachable', retryable: true });
    expect(s.getStatus().problem!.detail).toMatch(/TimeoutError|no response/);
    expect(s.getStatus().pending).toBe(1);
    proxy.clear();
    await s.pullToRefresh();
    expect(s.getStatus()).toMatchObject({ problem: null, pending: 0 });
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')?.comment).toBe('after the timeout');
  });

  it('quota full (507 on uploads): "Quota full", retryable, nothing published; sent once space is back', async () => {
    const { proxy, raw, alice, bob, owner } = await pair();
    const before = (await raw.head('index.json'))!.etag;
    alice.store.updateSave('osm:node/1', { comment: 'when space is back' });
    proxy.inject({ method: 'PUT', action: { kind: 'status', status: 507, body: 'Insufficient Storage' } });
    const r = await alice.engine.sync();
    expect(ownProblem(r)).toMatchObject({ kind: 'quota', situation: 'Quota full', retryable: true, blocksWrites: false });
    expect((await raw.head('index.json'))!.etag).toBe(before);
    proxy.clear();
    expect((await alice.engine.sync()).ok).toBe(true);
    await bob.engine.sync();
    expect(friendSaves(bob, owner).get('osm:node/1')?.comment).toBe('when space is back');
  });

  it('credentials refused (401 from the server): writes stop until the user reconnects', async () => {
    const { proxy, alice } = await pair();
    alice.store.updateSave('osm:node/1', { comment: 'queued' });
    proxy.inject({ action: { kind: 'status', status: 401, headers: { 'www-authenticate': 'Basic realm="dav"' } } });
    const s = new SyncScheduler({ run: (_r, o) => alice.engine.sync(o), timers: clock() });
    s.localChange();
    await s.appForeground('launch');
    expect(s.getStatus()).toMatchObject({ state: 'blocked', pending: 1 });
    expect(s.getStatus().problem).toMatchObject({ kind: 'auth', blocksWrites: true, message: 'Reconnect your storage' });
    proxy.clear();
    await s.resume();
    expect(s.getStatus()).toMatchObject({ state: 'idle', pending: 0, problem: null });
  });
});
