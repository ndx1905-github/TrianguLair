/*
 * Fuzz and property tests of every parser (T-201; fourth review "Before an external human audit"
 * item 4, fifth review item 4). Random and mutated inputs must only ever raise a TLCryptoError:
 * never another exception, never a hang, and never an acceptance of altered authenticated data.
 *
 * CI: fixed seed, bounded runs (FUZZ_RUNS, default 120 per property, a tenth for the expensive
 * ones). Long runs: `npm run fuzz:long` (FUZZ_RUNS=20000), and FUZZ_SEED=<n> or FUZZ_SEED=random;
 * FUZZ_STATS=<file> writes how often each outcome (ok, FORMAT, SIGNATURE...) occurred per property.
 * Fixtures come from the seeded vector world (test/vectors/), so a failing seed reproduces.
 */
import { writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalize,
  checkInvitationIndex,
  checkLocation,
  checkNoRollback,
  createGroup,
  decodeKeyExport,
  decodePrimaryIdentity,
  decryptTransfer,
  encodeKeyExport,
  encodePrimaryIdentity,
  encryptForTransfer,
  issueIdentityMove,
  issueSharingCert,
  openGroupKey,
  openInvitationResponse,
  openPack,
  openSharingKey,
  openVault,
  packEntry,
  parseInvitationLink,
  readPackHeader,
  safetyCode,
  sealGroupKey,
  sealSharingKey,
  sealVault,
  serialize,
  signIndex,
  TLCryptoError,
  toB64Url,
  verifyDeviceCert,
  verifyIdentityMove,
  verifyIndex,
  verifySharingCert,
  invitationFromRecord,
  type SignedIndex,
} from '../src/index';
import { concat, parseJsonObject, utf8 } from '../src/encoding';
import { openUnchecked } from '../src/pack';
import { signBody } from '../src/sign';
import { S } from '../src/sodium';
import { makeIndex, NOW, plain, T0, vaultBytes, world } from './vectors/fixtures';
import { seeded } from './vectors/seeded';
import { shared } from './vectors/shared';
import type { JsonObj } from './vectors/ops';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 120);
const SEED = process.env['FUZZ_SEED'] === 'random' ? Date.now() : Number(process.env['FUZZ_SEED'] ?? 20261025);
const FEW = Math.max(10, Math.floor(RUNS / 10));
const opts = (numRuns = RUNS) => ({ seed: SEED, numRuns, endOnFailure: true });
const TIMEOUT = 120_000 + RUNS * 50;
/** Largest time one parser call may take (a hang or super-linear blow-up shows up here). */
const MAX_CALL_MS = 5_000;
const fit = (name: string, fn: () => void) => it(name, fn, TIMEOUT);

const w = seeded('world', world);
const sh = seeded('shared', () => shared(w));
const { alice, bob } = w;
const td = new TextDecoder();

type Typed<T> = { ok: true; value: T } | { ok: false; code: string };

/** FUZZ_STATS=<file>: writes, per test, how often each outcome occurred (to see that inputs reach deep checks). */
const STATS = process.env['FUZZ_STATS'];
const stats = new Map<string, Map<string, number>>();
function count(outcome: string): void {
  if (!STATS) return;
  const name = expect.getState().currentTestName ?? '?';
  const m = stats.get(name) ?? new Map<string, number>();
  m.set(outcome, (m.get(outcome) ?? 0) + 1);
  stats.set(name, m);
}
afterAll(() => {
  if (!STATS) return;
  const lines = [...stats].map(([name, m]) => `${name}\n  ${[...m].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  writeFileSync(STATS, `seed ${SEED}, runs ${RUNS}\n${lines.join('\n')}\n`);
});

/** Runs `f`; a TLCryptoError is a typed refusal, anything else fails the property. */
function typed<T>(f: () => T): Typed<T> {
  const t = Date.now();
  try {
    const value = f();
    count('ok');
    return { ok: true, value };
  } catch (e) {
    if (e instanceof TLCryptoError) {
      count(e.code);
      return { ok: false, code: e.code };
    }
    throw new Error(`non-TLCryptoError escaped: ${String(e)}`);
  } finally {
    const ms = Date.now() - t;
    if (ms > MAX_CALL_MS) throw new Error(`parser call took ${ms} ms`);
  }
}

// ---------------------------------------------------------------------------------------------
// Mutation arbitraries
// ---------------------------------------------------------------------------------------------

type ByteMut =
  | { k: 'flip'; at: number; bit: number }
  | { k: 'set'; at: number; v: number }
  | { k: 'cut'; at: number }
  | { k: 'ins'; at: number; b: Uint8Array }
  | { k: 'del'; at: number; n: number }
  | { k: 'dup'; at: number; n: number };

const byteMut: fc.Arbitrary<ByteMut> = fc.oneof(
  fc.record({ k: fc.constant('flip' as const), at: fc.nat(), bit: fc.integer({ min: 0, max: 7 }) }),
  fc.record({ k: fc.constant('set' as const), at: fc.nat(), v: fc.constantFrom(0, 1, 0x7f, 0x80, 0xff, 0x22, 0x5c, 0x2c) }),
  fc.record({ k: fc.constant('cut' as const), at: fc.nat() }),
  fc.record({ k: fc.constant('ins' as const), at: fc.nat(), b: fc.uint8Array({ minLength: 1, maxLength: 8 }) }),
  fc.record({ k: fc.constant('del' as const), at: fc.nat(), n: fc.integer({ min: 1, max: 16 }) }),
  fc.record({ k: fc.constant('dup' as const), at: fc.nat(), n: fc.integer({ min: 1, max: 16 }) }),
);
const byteMuts = fc.array(byteMut, { minLength: 1, maxLength: 4 });

function mutateBytes(orig: Uint8Array, muts: ByteMut[]): Uint8Array {
  let b: Uint8Array = orig.slice();
  for (const m of muts) {
    const at = b.length === 0 ? 0 : m.at % (b.length + (m.k === 'ins' ? 1 : 0));
    switch (m.k) {
      case 'flip':
        if (b.length) b[at] = (b[at] as number) ^ (1 << m.bit);
        break;
      case 'set':
        if (b.length) b[at] = m.v;
        break;
      case 'cut':
        b = b.slice(0, at);
        break;
      case 'ins':
        b = concat(b.subarray(0, at), m.b, b.subarray(at));
        break;
      case 'del':
        b = concat(b.subarray(0, at), b.subarray(at + m.n));
        break;
      case 'dup':
        b = concat(b.subarray(0, at + m.n), b.subarray(at));
        break;
    }
  }
  return b;
}

/** Text mutations biased to JSON / base64url-significant characters. */
const charPool = fc.constantFrom(...'{}[]":,\\ \n0123456789-+.eEtfnAZaz_-=/é﻿\ud800'.split(''));
type StrMut = { k: 'set' | 'ins'; at: number; c: string } | { k: 'del'; at: number; n: number } | { k: 'swap'; at: number; to: number };
const strMut: fc.Arbitrary<StrMut> = fc.oneof(
  fc.record({ k: fc.constantFrom('set' as const, 'ins' as const), at: fc.nat(), c: charPool }),
  fc.record({ k: fc.constant('del' as const), at: fc.nat(), n: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ k: fc.constant('swap' as const), at: fc.nat(), to: fc.nat() }),
);
const strMuts = fc.array(strMut, { minLength: 1, maxLength: 4 });

function mutateString(s: string, muts: StrMut[]): string {
  let x = s;
  for (const m of muts) {
    const at = x.length === 0 ? 0 : m.at % x.length;
    if (m.k === 'set') x = x.slice(0, at) + m.c + x.slice(at + 1);
    else if (m.k === 'ins') x = x.slice(0, at) + m.c + x.slice(at);
    else if (m.k === 'del') x = x.slice(0, at) + x.slice(at + m.n);
    else if (m.k === 'swap' && x.length) {
      const to = m.to % x.length;
      const a = x[at] as string;
      const b = x[to] as string;
      x = x.split('').map((c, i) => (i === at ? b : i === to ? a : c)).join('');
    }
  }
  return x;
}

/** JSON values for structural mutations: integers only (canonical JSON), and format-relevant strings. */
const interesting = [
  alice.id.owner,
  bob.id.owner,
  alice.d2.id,
  'x25519:' + toB64Url(new Uint8Array(32)),
  'b2b256:' + toB64Url(new Uint8Array(32)),
  'https://storage.example.org/alice/',
  'https://localhost/',
  '2026-10-20T12:00:00.000Z',
  '',
  'sharing-cert',
  'pack',
];
const jsonLeaf = fc.oneof(
  fc.integer({ min: -(2 ** 53 - 1), max: 2 ** 53 - 1 }),
  fc.constantFrom(-1, 0, 1, 2 ** 32 - 1, 2 ** 32, 2 ** 20, 4, 5),
  fc.string({ maxLength: 12 }),
  fc.constantFrom(...interesting),
  fc.boolean(),
  fc.constant(null),
);
const jsonValue: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: jsonLeaf },
  { weight: 1, arbitrary: fc.array(jsonLeaf, { maxLength: 4 }) },
  { weight: 1, arbitrary: fc.dictionary(fc.constantFrom('a', 'file', 'hash', 'key', 'x', 'minor'), jsonLeaf, { maxKeys: 3 }) },
);
const fieldNames = fc.constantFrom('version', 'minor', 'crit', 'type', 'owner', 'seq', 'updated', 'key', 'rotation', 'location', 'revoked_devices', 'packs', 'file', 'hash', 'invitations', 'reads', 'device', 'box', 'sharing_cert', 'device_cert', 'move', 'public', 'x_new', 'contacts', 'answers', 'seed', 'id', 'created', 'expires', 'accepted', 'app');
type JsonMut = { path: number[]; op: 'delete' | 'set' | 'add'; key: string; value: unknown };
const jsonMut: fc.Arbitrary<JsonMut> = fc.record({
  path: fc.array(fc.nat(), { maxLength: 3 }),
  op: fc.constantFrom('delete' as const, 'set' as const, 'add' as const),
  key: fieldNames,
  value: jsonValue,
});
const jsonMuts = fc.array(jsonMut, { minLength: 1, maxLength: 3 });

/** Applies structural mutations to a deep copy of a JSON object (paths follow sorted keys / indexes). */
function mutateJson(doc: JsonObj, muts: JsonMut[]): JsonObj {
  const root = JSON.parse(JSON.stringify(doc)) as JsonObj;
  for (const m of muts) {
    let node: unknown = root;
    for (const p of m.path) {
      if (Array.isArray(node) && node.length) node = node[p % node.length];
      else if (typeof node === 'object' && node !== null) {
        const keys = Object.keys(node).sort();
        const next = keys.length ? (node as JsonObj)[keys[p % keys.length] as string] : undefined;
        if (typeof next === 'object' && next !== null) node = next;
      }
    }
    if (Array.isArray(node)) {
      const i = node.length ? m.path.length % node.length : 0;
      if (m.op === 'delete') node.splice(i, 1);
      else if (m.op === 'set' && node.length) node[i] = m.value;
      else node.push(m.value);
    } else if (typeof node === 'object' && node !== null) {
      const o = node as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      if (m.op === 'delete' && keys.length) delete o[keys[m.path.length % keys.length] as string];
      else if (m.op === 'set' && keys.length) o[keys[m.path.length % keys.length] as string] = m.value;
      else o[m.key] = m.value;
    }
  }
  return root;
}

/** Re-signs a mutated document (so the deeper checks run); null when it cannot be canonicalized. */
function resign(domain: Parameters<typeof signBody>[0], doc: JsonObj, sk: Uint8Array): string | null {
  try {
    const { signature: _s, ...rest } = doc;
    return canonicalize(signBody(domain, rest, sk));
  } catch (e) {
    if (e instanceof TLCryptoError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const i1Text = serialize(sh.i1);
const now = NOW;
const vOpts = { expectedOwner: alice.id.owner, location: alice.location as string, now };
const certText = serialize(alice.cert0);
const dcText = serialize(alice.dc1);
const move = seeded('fuzz-move', () => issueIdentityMove(alice.id, w.aliceNew.id, { now: T0 }));
const moveText = serialize(move);
const sharingKey = { keyPair: alice.sharing, cert: alice.cert0, vaultDataKey: alice.vdk };
const tlsk1 = seeded('fuzz-tlsk', () => sealSharingKey(sharingKey, alice.dc1));
const tlsk2 = seeded('fuzz-tlsk2', () => sealSharingKey(sharingKey, alice.id));
const keyExport = encodeKeyExport(sharingKey);
const CODE = 'abandon ability able about above absent';
const transfer = seeded('fuzz-transfer', () => encryptForTransfer(keyExport, CODE, { now: T0 }));
const tlpi = encodePrimaryIdentity(alice.id);
const group = seeded('fuzz-group', () => {
  const g = createGroup();
  return sealGroupKey(g, alice.id.owner, [bob.sharing.publicKey]);
});
const inv1 = sh.inv1;
const inner1 = S().crypto_box_seal_open(sh.r1.subarray(2), inv1.keyPair.publicKey, inv1.keyPair.secretKey);
const vaultRecords = seeded('fuzz-vault', () => sealVault({ type: 'vault-records', version: 3, owner: alice.id.owner, contacts: [], invitations: [JSON.parse(sh.rec1)], retired_owners: [] }, alice.vdk));
const recordsDoc = JSON.parse(canonicalize(openVault(vaultRecords, alice.id.owner, alice.vdk))) as JsonObj;
const bobKeys = [bob.sharing];

/** A verified index of Alice listing `files` (to reach the decryption of mutated packs). */
function listing(files: Uint8Array[]): SignedIndex {
  return signIndex(alice.s1, { seq: 1, sharingCert: alice.cert0, packs: files.map((f) => packEntry(f)), vaultDataKey: alice.vdk, now: T0 });
}

// ---------------------------------------------------------------------------------------------

describe('fuzz: canonical JSON and encodings', () => {
  fit('parseJsonObject: random JSON-ish text is accepted only when canonical', () => {
    fc.assert(
      fc.property(fc.oneof(fc.json({ maxDepth: 3 }), fc.string({ maxLength: 60, unit: 'binary' }), strMuts.map((m) => mutateString('{"a":[1,"x",{"b":null}],"c":true}', m))), (s) => {
        const r = typed(() => parseJsonObject(s, 'doc'));
        if (r.ok) expect(canonicalize(r.value)).toBe(s);
        else expect(r.code).toBe('FORMAT');
      }),
      opts(RUNS * 2),
    );
  });

  fit('canonicalize -> parseJsonObject round-trips every value of the domain', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 6, unit: 'binary' }), jsonValue, { maxKeys: 6 }), (o) => {
        const text = canonicalize(o);
        expect(canonicalize(parseJsonObject(text, 'doc'))).toBe(text);
      }),
      opts(),
    );
  });

  fit('checkLocation: only canonical public https addresses pass', () => {
    const urls = fc.oneof(
      fc.webUrl({ validSchemes: ['https', 'http'], withQueryParameters: true, withFragments: true }),
      fc.string({ maxLength: 80 }),
      strMuts.map((m) => mutateString('https://storage.example.org/alice/?x=1', m)),
      fc.ipV6().map((h) => `https://[${h}]/`),
      fc.ipV4Extended().map((h) => `https://${h}/`),
    );
    fc.assert(
      fc.property(urls, (u) => {
        const r = typed(() => checkLocation(u));
        if (r.ok) {
          expect(u.startsWith('https://')).toBe(true);
          expect(new URL(u).href).toBe(u);
          expect(u.includes('#')).toBe(false);
        } else expect(r.code).toBe('FORMAT');
      }),
      opts(RUNS * 2),
    );
  });

  fit('decodePrimaryIdentity: random and mutated blobs', () => {
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 100 }), byteMuts.map((m) => mutateBytes(tlpi, m))), (b) => {
        const r = typed(() => decodePrimaryIdentity(b));
        if (r.ok) expect(b.length).toBe(69);
      }),
      opts(),
    );
  });
});

describe('fuzz: certificates and identity move', () => {
  const cases: [string, string, (t: string) => unknown, Parameters<typeof signBody>[0], Uint8Array][] = [
    ['verifySharingCert', certText, (t) => verifySharingCert(t), 'sharing-cert', alice.id.master.secretKey],
    ['verifyDeviceCert', dcText, (t) => verifyDeviceCert(t), 'device-cert', alice.id.master.secretKey],
    ['verifyIdentityMove', moveText, (t) => verifyIdentityMove(t), 'identity-move', alice.id.master.secretKey],
  ];
  for (const [name, text, verify, domain, sk] of cases) {
    fit(`${name}: altered text is never accepted`, () => {
      fc.assert(
        fc.property(strMuts, (m) => {
          const t = mutateString(text, m);
          const r = typed(() => verify(t));
          if (r.ok) expect(t).toBe(text);
        }),
        opts(),
      );
    });
    fit(`${name}: re-signed structural mutations raise only typed errors`, () => {
      fc.assert(
        fc.property(jsonMuts, (m) => {
          const t = resign(domain, mutateJson(JSON.parse(text) as JsonObj, m), sk);
          if (t !== null) typed(() => verify(t));
        }),
        opts(),
      );
    });
  }
});

describe('fuzz: signed index', () => {
  fit('verifyIndex: altered text or bytes are never accepted', () => {
    fc.assert(
      fc.property(fc.oneof(strMuts.map((m) => mutateString(i1Text, m))), (t) => {
        const r = typed(() => verifyIndex(t, vOpts));
        if (r.ok) expect(t).toBe(i1Text);
      }),
      opts(),
    );
    fc.assert(
      fc.property(byteMuts, (m) => {
        const b = mutateBytes(utf8(i1Text), m);
        const r = typed(() => verifyIndex(b, vOpts));
        if (r.ok) expect(td.decode(b)).toBe(i1Text);
      }),
      opts(),
    );
  });

  fit('verifyIndex: random input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }), fc.json({ maxDepth: 3 })), (x) => {
        expect(typed(() => verifyIndex(x, vOpts)).ok).toBe(false);
      }),
      opts(),
    );
  });

  fit('verifyIndex: re-signed structural mutations raise only typed errors, and what passes is consistent', () => {
    const base = plain(sh.i1);
    fc.assert(
      fc.property(jsonMuts, fc.boolean(), (m, withLastSeen) => {
        const t = resign('index', mutateJson(base, m), alice.d1.sign.secretKey);
        if (t === null) return;
        const r = typed(() => verifyIndex(t, withLastSeen ? { ...vOpts, lastSeen: sh.i1 } : vOpts));
        if (!r.ok) return;
        const idx = r.value;
        expect(idx.owner).toBe(alice.id.owner);
        expect(idx.revoked_devices).not.toContain(idx.device_cert.device);
        for (const p of idx.packs) expect(p.file.endsWith(`b2b256-${p.hash.slice(7)}.bin`)).toBe(true);
      }),
      opts(),
    );
  });

  fit('checkNoRollback is a total order on (rotation, seq) within an owner', () => {
    const certs = [alice.cert0, w.aliceCert1, issueSharingCert(alice.id, w.aliceSharing1.publicKey, { rotation: 2, location: alice.location as string, revokedDevices: [alice.d2.id] })];
    const memo = new Map<string, SignedIndex>();
    const make = (rot: number, seq: number) => {
      const k = `${rot}/${seq}`;
      let idx = memo.get(k);
      if (!idx) {
        idx = verifyIndex(makeIndex({ keys: alice.d1, dc: alice.dc1, cert: certs[rot]!, seq, now: T0, vdk: alice.vdk }), { now });
        memo.set(k, idx);
      }
      return idx;
    };
    const key = fc.record({ rot: fc.integer({ min: 0, max: 2 }), seq: fc.integer({ min: 0, max: 50 }) });
    fc.assert(
      fc.property(key, key, key, (a, b, c) => {
        const ia = make(a.rot, a.seq);
        const ib = make(b.rot, b.seq);
        const ic = make(c.rot, c.seq);
        const accepts = (x: SignedIndex, last: SignedIndex) => typed(() => checkNoRollback(x, last)).ok;
        const cmp = (x: { rot: number; seq: number }, y: { rot: number; seq: number }) => x.rot - y.rot || x.seq - y.seq;
        // accepts(x, last) <=> x >= last in (rotation, seq) order.
        expect(accepts(ib, ia)).toBe(cmp(b, a) >= 0);
        expect(accepts(ia, ib)).toBe(cmp(a, b) >= 0);
        if (accepts(ib, ia) && accepts(ic, ib)) expect(accepts(ic, ia)).toBe(true);
      }),
      opts(),
    );
  });

  fit('signIndex -> serialize -> verifyIndex round-trips', () => {
    const entry = fc.uint8Array({ minLength: 1, maxLength: 64 }).map((b) => packEntry(b));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 53 - 1 }), fc.array(entry, { maxLength: 6 }), fc.array(fc.constantFrom('4', '4.1', '5'), { minLength: 1, maxLength: 3 }), (seq, packs, reads) => {
        const uniq = [...new Map(packs.map((p) => [p.hash, p])).values()];
        const idx = signIndex(alice.s1, { seq, sharingCert: alice.cert0, packs: uniq, reads: [...new Set(reads)], vaultDataKey: alice.vdk, now: T0 });
        expect(serialize(verifyIndex(serialize(idx), vOpts))).toBe(serialize(idx));
      }),
      opts(FEW),
    );
  });
});

describe('fuzz: packs and group keys', () => {
  fit('readPackHeader: random and mutated packs', () => {
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 300 }), byteMuts.map((m) => mutateBytes(sh.packA, m))), (b) => {
        typed(() => readPackHeader(b));
      }),
      opts(RUNS * 2),
    );
  });

  fit('pack decryption: a mutated pack opens only to the original content', () => {
    const orig = openUnchecked(sh.packA, bobKeys, alice.id.owner);
    fc.assert(
      fc.property(byteMuts, (m) => {
        const b = mutateBytes(sh.packA, m);
        const r = typed(() => openUnchecked(b, bobKeys, alice.id.owner));
        if (r.ok) {
          expect(r.value.id).toBe(orig.id);
          expect(Buffer.from(r.value.payload).equals(Buffer.from(orig.payload))).toBe(true);
        }
      }),
      opts(),
    );
  });

  fit('openPack: mutated packs listed in a verified index', () => {
    const orig = openPack(sh.packA, sh.i1, bobKeys);
    fc.assert(
      fc.property(byteMuts, (m) => {
        const b = mutateBytes(sh.packA, m);
        const idx = listing([b]);
        const r = typed(() => openPack(b, idx, bobKeys));
        if (r.ok) expect(Buffer.from(r.value.payload).equals(Buffer.from(orig.payload))).toBe(true);
        expect(typed(() => openPack(b, sh.i1, bobKeys)).ok).toBe(Buffer.from(b).equals(Buffer.from(sh.packA)));
      }),
      opts(FEW),
    );
  });

  fit('openGroupKey: mutated group-key packs listed in a verified index', () => {
    const orig = openGroupKey(group, listing([group]), bobKeys);
    fc.assert(
      fc.property(byteMuts, (m) => {
        const b = mutateBytes(group, m);
        const r = typed(() => openGroupKey(b, listing([b]), bobKeys));
        if (r.ok) expect(Buffer.from(r.value.keyPair.secretKey).equals(Buffer.from(orig.keyPair.secretKey))).toBe(true);
      }),
      opts(FEW),
    );
  });
});

describe('fuzz: invitation link and return link', () => {
  fit('parseInvitationLink: random strings', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 120 }), fc.base64String({ maxLength: 160 }), fc.uint8Array({ maxLength: 120 }).map(toB64Url)), (s) => {
        typed(() => parseInvitationLink(s, { now }));
      }),
      opts(RUNS * 2),
    );
  });

  fit('a mutated link is never accepted against the owner\'s index', () => {
    const idx = verifyIndex(i1Text, vOpts);
    fc.assert(
      fc.property(fc.oneof(strMuts.map((m) => mutateString(sh.f1, m)), byteMuts.map((m) => toB64Url(mutateBytes(new Uint8Array(Buffer.from(sh.f1, 'base64url')), m)))), (f) => {
        const r = typed(() => parseInvitationLink(f, { now }));
        if (!r.ok || f === sh.f1) return;
        const read = typed(() => verifyIndex(i1Text, { expectedOwner: r.value.owner, location: r.value.location, now }));
        const accepted = read.ok && typed(() => checkInvitationIndex(r.value, read.value, { now })).ok;
        expect(accepted).toBe(false);
        expect(typed(() => checkInvitationIndex(r.value, idx, { now })).ok).toBe(false);
      }),
      opts(),
    );
  });

  fit('openInvitationResponse: random and mutated outer bytes', () => {
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 700 }), byteMuts.map((m) => mutateBytes(sh.r1, m))), (b) => {
        const r = typed(() => openInvitationResponse(b, inv1, { now }));
        if (r.ok) expect(Buffer.from(b).equals(Buffer.from(sh.r1))).toBe(true);
      }),
      opts(),
    );
  });

  fit('openInvitationResponse: mutated inner bytes sealed to the invitation key are never accepted', () => {
    fc.assert(
      fc.property(byteMuts, (m) => {
        const inner = mutateBytes(inner1, m);
        const b = concat(Uint8Array.of(0x52, 4), S().crypto_box_seal(inner, inv1.keyPair.publicKey));
        const r = typed(() => openInvitationResponse(b, inv1, { now }));
        if (r.ok) expect(Buffer.from(inner).equals(Buffer.from(inner1))).toBe(true);
      }),
      opts(),
    );
  });
});

describe('fuzz: sealed sharing key, transfer, key export, vault', () => {
  fit('openSharingKey mode 1: mutated payloads sealed to the device', () => {
    const payload = td.decode(S().crypto_box_seal_open(tlsk1.subarray(6), alice.d1.box.publicKey, alice.d1.box.secretKey));
    fc.assert(
      fc.property(fc.oneof(strMuts.map((m) => mutateString(payload, m)), jsonMuts.map((m) => canonicalize(mutateJson(JSON.parse(payload) as JsonObj, m)))), (p) => {
        const b = concat(utf8('TLSK'), Uint8Array.of(2, 1), S().crypto_box_seal(utf8(p), alice.d1.box.publicKey));
        const r = typed(() => openSharingKey(b, alice.d1, { expectedOwner: alice.id.owner, lastSeen: alice.cert0 }));
        // The payload is authenticated by who can seal to the device (anyone) plus the certificate and
        // the secret: an accepted payload must carry the genuine certificate and secret.
        if (r.ok) {
          expect(canonicalize(r.value.cert)).toBe(canonicalize(alice.cert0));
          expect(Buffer.from(r.value.keyPair.secretKey).equals(Buffer.from(alice.sharing.secretKey))).toBe(true);
        }
      }),
      opts(),
    );
  });

  fit('openSharingKey: random and mutated blobs (both modes)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 400 }), byteMuts.map((m) => mutateBytes(tlsk1, m)), byteMuts.map((m) => mutateBytes(tlsk2, m))), fc.boolean(), (b, dev) => {
        const r = typed(() => openSharingKey(b, dev ? alice.d1 : alice.id));
        if (r.ok) expect(Buffer.from(r.value.keyPair.secretKey).equals(Buffer.from(alice.sharing.secretKey))).toBe(true);
      }),
      opts(),
    );
  });

  fit('decryptTransfer: random headers are refused before any key derivation', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 120 }), (b) => {
        // Force out-of-range Argon2 parameters (or a bad magic) so nothing slow runs.
        const x = b.slice();
        if (x.length >= 10) x[6] = 0xff;
        expect(typed(() => decryptTransfer(x, CODE, { now })).ok).toBe(false);
      }),
      opts(),
    );
  });

  fit('decryptTransfer: mutated blobs are never accepted', () => {
    fc.assert(
      fc.property(byteMuts, (m) => {
        const b = mutateBytes(transfer, m);
        const r = typed(() => decryptTransfer(b, CODE, { now: new Date(T0.getTime() + 60_000) }));
        if (r.ok) expect(Buffer.from(b).equals(Buffer.from(transfer))).toBe(true);
      }),
      opts(FEW),
    );
  });

  fit('decodeKeyExport: an accepted export carries the genuine certificate and secret', () => {
    const text = td.decode(keyExport);
    fc.assert(
      fc.property(fc.oneof(strMuts.map((m) => utf8(mutateString(text, m))), byteMuts.map((m) => mutateBytes(keyExport, m)), jsonMuts.map((m) => utf8(canonicalize(mutateJson(JSON.parse(text) as JsonObj, m))))), (b) => {
        const r = typed(() => decodeKeyExport(b, { expectedOwner: alice.id.owner }));
        if (r.ok) {
          expect(canonicalize(r.value.cert)).toBe(canonicalize(alice.cert0));
          expect(Buffer.from(r.value.keyPair.secretKey).equals(Buffer.from(alice.sharing.secretKey))).toBe(true);
        }
      }),
      opts(),
    );
  });

  fit('openVault: mutated envelopes are never accepted', () => {
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 200 }), byteMuts.map((m) => mutateBytes(vaultRecords, m))), (b) => {
        const r = typed(() => openVault(b, alice.id.owner, alice.vdk));
        if (r.ok) expect(Buffer.from(b).equals(Buffer.from(vaultRecords))).toBe(true);
      }),
      opts(),
    );
  });

  fit('openVault: hostile records sealed with the vault data key (a stolen device) raise only typed errors', () => {
    fc.assert(
      fc.property(jsonMuts, (m) => {
        let json: string;
        try {
          json = canonicalize(mutateJson(recordsDoc, m));
        } catch {
          return;
        }
        const r = typed(() => openVault(vaultBytes({ json, ownerPk: alice.id.master.publicKey, key: alice.vdk }), alice.id.owner, alice.vdk));
        if (!r.ok) return;
        // What passes keeps the invariants the security rules rely on.
        const owners = r.value.contacts.map((c) => c.owner);
        expect([...owners].sort()).toEqual(owners);
        for (const rec of r.value.invitations) expect(typed(() => invitationFromRecord(rec, alice.id.owner)).ok).toBe(true);
      }),
      opts(),
    );
  });
});

describe('properties', () => {
  fit('safetyCode is symmetric and has 12 groups of 5 digits', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), (a, b) => {
        const x = safetyCode(a, b);
        expect(x).toEqual(safetyCode(b, a));
        expect(x.every((g) => /^\d{5}$/.test(g))).toBe(true);
        expect(x.length).toBe(12);
      }),
      opts(),
    );
  });
});

