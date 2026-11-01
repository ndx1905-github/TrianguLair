/*
 * Fixtures and low-level builders for the known-answer vectors. The builders write the documented
 * byte layouts directly (docs/format/), so that negative vectors can carry a VALID signature or
 * AEAD over an invalid structure, and so that the positive vectors double as a check that the
 * documentation's layouts are the library's.
 */
import {
  canonicalize,
  devicePublicKeys,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateVaultDataKey,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueSharingCert,
  parseKey,
  toB64Url,
  type DeviceCert,
  type DeviceKeys,
  type DeviceSigner,
  type Identity,
  type KeyPair,
  type SharingCert,
} from '../../src/index';
import { concat, fromB64Url, u16be, u32be, utf8 } from '../../src/encoding';
import { listingPadKey, padListing } from '../../src/invitation-listing';
import { paddedLength } from '../../src/pack';
import { signBinary, signBody, type SignatureDomain } from '../../src/sign';
import { S } from '../../src/sodium';
import type { JsonObj } from './ops';

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
/** Creation time of the fixtures (invitations, indexes). */
export const T0 = new Date('2026-10-20T12:00:00.000Z');
/** Reader clock of most vectors. */
export const NOW = new Date('2026-10-20T13:00:00.000Z');
export const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
export const iso = (d: Date): string => d.toISOString();
export const secs = (d: Date): number => Math.floor(d.getTime() / 1000);

export interface Person {
  name: string;
  phrase: string;
  id: Identity;
  d1: DeviceKeys;
  dc1: DeviceCert;
  s1: DeviceSigner;
  d2: DeviceKeys;
  dc2: DeviceCert;
  s2: DeviceSigner;
  sharing: KeyPair;
  cert0: SharingCert;
  location: string | undefined;
  vdk: Uint8Array;
}

export function person(name: string, location: string | undefined): Person {
  const phrase = generateRecoveryPhrase();
  const id = identityFromPhrase(phrase);
  const d1 = generateDeviceKeys();
  const dc1 = issueDeviceCert(id, devicePublicKeys(d1));
  const d2 = generateDeviceKeys();
  const dc2 = issueDeviceCert(id, devicePublicKeys(d2));
  const sharing = generateX25519KeyPair();
  const cert0 = issueSharingCert(id, sharing.publicKey, location === undefined ? { rotation: 0 } : { rotation: 0, location });
  return { name, phrase, id, d1, dc1, s1: { keys: d1, cert: dc1 }, d2, dc2, s2: { keys: d2, cert: dc2 }, sharing, cert0, location, vdk: generateVaultDataKey() };
}

export interface World {
  alice: Person;
  /** Alice's rotation 1: new sharing key, device d2 declared lost. */
  aliceSharing1: KeyPair;
  aliceCert1: SharingCert;
  /** Alice's rotation 2: storage move (same key as rotation 1). */
  aliceCert2: SharingCert;
  aliceNewLocation: string;
  /** Alice's new identity after her primary device was stolen, and a second (conflicting) one. */
  aliceNew: Person;
  aliceOther: Person;
  bob: Person;
  /** Bob's rotation 1: his device d1 declared lost. */
  bobCert1: SharingCert;
  carol: Person;
  /** Publishes nothing (no read address). */
  dave: Person;
}

export function world(): World {
  const alice = person('alice', 'https://storage.example.org/alice/');
  const aliceSharing1 = generateX25519KeyPair();
  const aliceCert1 = issueSharingCert(alice.id, aliceSharing1.publicKey, { rotation: 1, location: alice.location as string, revokedDevices: [alice.d2.id] });
  const aliceNewLocation = 'https://new.example.com/alice/';
  const aliceCert2 = issueSharingCert(alice.id, aliceSharing1.publicKey, { rotation: 2, location: aliceNewLocation, revokedDevices: [alice.d2.id] });
  const aliceNew = person('alice-new', 'https://storage.example.org/alice2/');
  const aliceOther = person('alice-other', 'https://other.example.org/a/');
  const bob = person('bob', 'https://bob.example.net/tl/');
  const bobCert1 = issueSharingCert(bob.id, generateX25519KeyPair().publicKey, { rotation: 1, location: bob.location as string, revokedDevices: [bob.d1.id] });
  const carol = person('carol', 'https://carol.example.com/places/');
  const dave = person('dave', undefined);
  return { alice, aliceSharing1, aliceCert1, aliceCert2, aliceNewLocation, aliceNew, aliceOther, bob, bobCert1, carol, dave };
}

// ---------------------------------------------------------------------------------------------
// JSON documents
// ---------------------------------------------------------------------------------------------

export function plain(x: unknown): JsonObj {
  return JSON.parse(canonicalize(x)) as JsonObj;
}

/** Signs `body` (any "signature" field is replaced) and returns the canonical text. */
export function signDoc(domain: SignatureDomain, body: JsonObj, secretKey: Uint8Array): string {
  const { signature: _s, ...rest } = body;
  return canonicalize(signBody(domain, rest, secretKey));
}

export function compactCert(cert: SharingCert | JsonObj): JsonObj {
  const { type: _t, version: _v, owner: _o, revoked_devices: _r, ...rest } = plain(cert);
  return rest;
}

export function compactDc(dc: DeviceCert | JsonObj): JsonObj {
  const { type: _t, version: _v, owner: _o, ...rest } = plain(dc);
  return rest;
}

/** A sharing certificate body signed by `identity`'s master (no checks: for negative vectors). */
export function rawCert(identity: Identity, body: JsonObj): string {
  return signDoc('sharing-cert', body, identity.master.secretKey);
}

export interface IndexSpec {
  keys: DeviceKeys;
  dc: DeviceCert | JsonObj;
  cert: SharingCert | JsonObj;
  seq: number;
  now: Date;
  packs?: { file: string; hash: string }[];
  /** Real tokens to list (padded with the owner's dummies); null omits the field. */
  tokens?: string[] | null;
  vdk: Uint8Array;
  mutate?: (body: JsonObj) => void;
}

/** Writes an index exactly as documented, without the writer-side checks of signIndex. */
export function makeIndex(o: IndexSpec): string {
  const cert = plain(o.cert);
  const body: JsonObj = {
    version: 4,
    seq: o.seq,
    owner: cert['owner'] as string,
    updated: iso(o.now),
    sharing_cert: compactCert(cert),
    revoked_devices: cert['revoked_devices'] as string[],
    reads: ['4'],
    device_cert: compactDc(o.dc),
    packs: (o.packs ?? []).map((p) => ({ file: p.file, hash: p.hash })),
  };
  if (o.tokens !== null) body['invitations'] = padListing(o.tokens ?? [], listingPadKey(o.vdk), o.now.getTime());
  o.mutate?.(body);
  return signDoc('index', body, o.keys.sign.secretKey);
}

// ---------------------------------------------------------------------------------------------
// Binary structures
// ---------------------------------------------------------------------------------------------

export const LINK_PREFIX = 'https://triangulair.app/i#';

export function linkBytes(ownerPk: Uint8Array, seed: Uint8Array, rotation: number, expiresS: number, address: string, version = 5, magic = 0x49): Uint8Array {
  return concat(Uint8Array.of(magic, version), ownerPk, seed, u32be(rotation), u32be(expiresS), utf8(address));
}

export function link(bytes: Uint8Array): string {
  return toB64Url(bytes);
}

/** invitation-record signed bytes (docs/format/invitation-record.md). */
export function recordBytes(ownerPk: Uint8Array, id16: Uint8Array, invPk: Uint8Array, rotation: number, createdS: number, expiresS: number, location: string): Uint8Array {
  const loc = utf8(location);
  return concat(ownerPk, id16, invPk, u32be(rotation), u32be(createdS), u32be(expiresS), u16be(loc.length), loc);
}

export function sig(domain: SignatureDomain, message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return signBinary(domain, message, secretKey);
}

/** Compact sharing certificate of a return link. */
export function compactCertBytes(cert: SharingCert | JsonObj): Uint8Array {
  const c = plain(cert);
  const loc = c['location'] === undefined ? new Uint8Array(0) : utf8(c['location'] as string);
  const revoked = (c['revoked_devices'] as string[]).map((d) => parseKey('ed25519', d));
  return concat(
    parseKey('x25519', c['key']),
    u32be(c['rotation'] as number),
    u16be(revoked.length),
    ...revoked,
    u16be(loc.length),
    loc,
    fromB64Url(c['signature'], 'sig', 64),
  );
}

export function compactDcBytes(dc: DeviceCert | JsonObj): Uint8Array {
  const d = plain(dc);
  return concat(parseKey('ed25519', d['device']), parseKey('x25519', d['box']), fromB64Url(d['signature'], 'sig', 64));
}

export interface ResponseSpec {
  id16: Uint8Array;
  responderPk: Uint8Array;
  createdS: number;
  certBytes: Uint8Array;
  dcBytes: Uint8Array;
  signerSk: Uint8Array;
  inviterPk: Uint8Array;
  invitationPk: Uint8Array;
  /** Appended to the inner bytes after the signature. */
  trailing?: Uint8Array;
  version?: number;
}

/** Return link written from its documented layout; also returns the inner bytes and the signed bytes. */
export function responseBytes(r: ResponseSpec): { bytes: Uint8Array; inner: Uint8Array; signed: Uint8Array } {
  const body = concat(r.id16, r.responderPk, u32be(r.createdS), r.certBytes, r.dcBytes);
  const signed = concat(body, r.inviterPk, r.invitationPk);
  const inner = concat(body, sig('invitation-response', signed, r.signerSk), r.trailing ?? new Uint8Array(0));
  return { bytes: concat(Uint8Array.of(0x52, r.version ?? 4), S().crypto_box_seal(inner, r.invitationPk)), inner, signed };
}

/** Pack envelope from its parts (docs/format/pack.md): AEAD over `frame` with the documented AD. */
export function packBytes(o: {
  ownerPk: Uint8Array;
  header: JsonObj; // protected header (without wraps)
  wraps: string[];
  frame: Uint8Array;
  batchKey: Uint8Array;
  nonce: Uint8Array;
  envelopeVersion?: number;
}): { bytes: Uint8Array; ad: Uint8Array; headerText: string } {
  const s = S();
  const ad = concat(utf8('TLPK'), Uint8Array.of(4), o.ownerPk, utf8(canonicalize(o.header)));
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(o.frame, ad, null, o.nonce, o.batchKey);
  const headerText = canonicalize({ ...o.header, wraps: o.wraps });
  const hb = utf8(headerText);
  return { bytes: concat(utf8('TLPK'), Uint8Array.of(o.envelopeVersion ?? 4), u32be(hb.length), hb, ct), ad, headerText };
}

/** Pack plaintext frame: id 16 || type || u32 length || payload || zero padding (Padmé or none). */
export function frame(id16: Uint8Array, type: number, payload: Uint8Array, pad: 'padme' | 'none', override?: { length?: number; padByte?: number; declared?: number }): Uint8Array {
  const n = 21 + payload.length;
  const len = override?.length ?? (pad === 'padme' ? paddedLength(n) : n);
  const out = new Uint8Array(len);
  out.set(id16, 0);
  out[16] = type;
  out.set(u32be(override?.declared ?? payload.length), 17);
  out.set(payload.subarray(0, Math.max(0, Math.min(payload.length, len - 21))), 21);
  if (override?.padByte !== undefined && len > n) out[len - 1] = override.padByte;
  return out;
}

/** TLVD envelope from a records text, with the documented AD and padding (overridable). */
export function vaultBytes(o: { json: string; ownerPk: Uint8Array; key: Uint8Array; length?: number; padByte?: number; declared?: number }): Uint8Array {
  const s = S();
  const json = utf8(o.json);
  const len = o.length ?? paddedLength(4 + json.length);
  const pt = new Uint8Array(len);
  pt.set(u32be(o.declared ?? json.length), 0);
  pt.set(json.subarray(0, Math.min(json.length, len - 4)), 4);
  if (o.padByte !== undefined) pt[len - 1] = o.padByte;
  const head = concat(utf8('TLVD'), Uint8Array.of(3));
  const nonce = s.randombytes_buf(24);
  const ad = concat(head, o.ownerPk, nonce);
  return concat(head, nonce, s.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, ad, null, nonce, o.key));
}

/** TLSK mode 1 with an arbitrary payload object. */
export function sealedKeyToDevice(payload: JsonObj, boxPk: Uint8Array, version = 2): Uint8Array {
  return concat(utf8('TLSK'), Uint8Array.of(version, 1), S().crypto_box_seal(utf8(canonicalize(payload)), boxPk));
}

export function flip(b: Uint8Array, at: number): Uint8Array {
  const out = b.slice();
  const i = at < 0 ? out.length + at : at;
  out[i] = (out[i] as number) ^ 0x01;
  return out;
}
