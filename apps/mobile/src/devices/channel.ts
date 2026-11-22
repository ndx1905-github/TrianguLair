/**
 * Adding a device (spec "Adding a device", T-206): the app-level wrappers around the frozen crypto
 * structures. Nothing here is a crypto format; the crypto package is unchanged.
 *
 * Link + code (remote; devices review F-03: no key leaves the old device before its approval):
 *   - the old device makes a slot, a 6-word code and a random 32-byte channel key, and drops at
 *     `transfer/<slot>.bin` on my storage the frozen TLTX blob (Argon2id from the code, 15-minute
 *     authenticated expiry) of an **invitation to enrol**: `{owner, location, slot, channel key}`,
 *     no secret of mine (no sharing key, no vault data key, no storage access);
 *   - the **device link** `https://example.org/d#<b64url(1 | slot 16 B | read address)>` tells
 *     the new device where to fetch it anonymously; it holds no secret ("the link alone allows
 *     nothing");
 *   - the new device opens the blob with the 6 words and answers with a **request link**
 *     `https://example.org/d#<b64url(2 | slot 16 B | sealed request)>`: its public device keys
 *     and name, sealed under the channel key; the user sends it back to the old device (the new
 *     device cannot write to my storage: the storage access is in the vault, not released yet);
 *   - the old device opens the request, shows the name and a 12-digit number of the new device key
 *     (shown on both screens: the user types its last 4 digits), issues the device certificate with
 *     the master key and only then drops the **approval** `transfer/<slot>.ok`: the certificate and
 *     the sharing key with the vault data key sealed to the new device key (TLSK mode 1), under the
 *     channel key. The new device then reads my storage settings in the vault.
 *   Request and approval are XChaCha20-Poly1305 under the channel key (AD: kind and slot). Whoever
 *   intercepts the link and the code can write a request: the number on both screens is what
 *   authenticates it, and a refusal releases nothing (the app offers a key change anyway).
 *
 * QR (side by side, the default):
 *   - the new device shows `TLDA1:<b64url(sign pk | box pk | ephemeral X25519 pk | name)>`;
 *   - the old device scans it, shows the fingerprint, issues the device certificate and seals the
 *     sharing key to it (TLSK mode 1), encrypts `{cert, sealed}` under the shared temporary key
 *     BLAKE2b(X25519(old ephemeral, new ephemeral) | both public keys | slot), drops it at
 *     `transfer/<slot>.qr`, and shows `TLDB1:<b64url(slot | old ephemeral pk | read address)>`;
 *   - the new device scans it back, fetches and opens the file, reads the vault, deletes the file.
 *   Nothing travels in the clear: the storage sees an opaque blob for 15 minutes at most.
 */
import _sodium from 'libsodium-wrappers-sumo';
import { checkLocation, formatKey, fromB64Url, parseKey, toB64Url, type DeviceCert } from '@triangulair/crypto';
import { linkOrigin } from '../links/origin';

export const deviceLinkBase = (): string => `${linkOrigin()}/d`;
export const SLOT_BYTES = 16;
export const OFFER_PREFIX = 'TLDA1:';
export const REPLY_PREFIX = 'TLDB1:';
/** A transfer (link + code, or QR) lasts 15 minutes at most (spec), then its files are deleted. */
export const TRANSFER_WINDOW_MS = 15 * 60 * 1000;
const MAX_NAME_BYTES = 120;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export const slotFiles = (slot: string) => ({
  blob: `transfer/${slot}.bin`,
  request: `transfer/${slot}.req`,
  approval: `transfer/${slot}.ok`,
  qr: `transfer/${slot}.qr`,
});

export function newSlot(): string {
  return toB64Url(_sodium.randombytes_buf(SLOT_BYTES));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function checkSlot(slot: string): string {
  fromB64Url(slot, 'slot', SLOT_BYTES);
  return slot;
}

// ------------------------------------------------------------------ link + code

export interface DeviceLink {
  slot: string;
  /** The certified read address: the invitation is at `<location>transfer/<slot>.bin`. */
  location: string;
}

const LINK_INVITE = 1;
const LINK_REQUEST = 2;

function linkBytes(kind: number, slot: string, rest: Uint8Array): string {
  return `${deviceLinkBase()}#${toB64Url(concat(Uint8Array.of(kind), fromB64Url(slot, 'slot', SLOT_BYTES), rest))}`;
}

function linkPayload(text: string, kind: number): { slot: string; rest: Uint8Array } {
  const m = /(?:https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~-]+)*|triangulair:\/\/)\/d#([A-Za-z0-9_-]+)/.exec(text.trim());
  if (!m) throw new Error('bad-link');
  try {
    const b = fromB64Url(m[1], 'link');
    if (b.length < 1 + SLOT_BYTES + 8 || b[0] !== kind) throw new Error('kind');
    return { slot: toB64Url(b.subarray(1, 1 + SLOT_BYTES)), rest: b.slice(1 + SLOT_BYTES) };
  } catch {
    throw new Error('bad-link');
  }
}

export function encodeDeviceLink(l: DeviceLink): string {
  checkLocation(l.location);
  return linkBytes(LINK_INVITE, l.slot, enc.encode(l.location));
}

/** Finds a device link in pasted text (a mail, a message). Throws `Error('bad-link')` (a request link included). */
export function parseDeviceLink(text: string): DeviceLink {
  const { slot, rest } = linkPayload(text, LINK_INVITE);
  try {
    const location = dec.decode(rest);
    checkLocation(location);
    return { slot, location };
  } catch {
    throw new Error('bad-link');
  }
}

/** The new device's answer, to send back to the old device. */
export function encodeRequestLink(slot: string, sealed: Uint8Array): string {
  return linkBytes(LINK_REQUEST, slot, sealed);
}

/** Throws `Error('bad-link')` (an invitation link included). */
export function parseRequestLink(text: string): { slot: string; sealed: Uint8Array } {
  const { slot, rest } = linkPayload(text, LINK_REQUEST);
  return { slot, sealed: rest };
}

// ------------------------------------------------------------------ invitation, request, approval

export const CHANNEL_KEY_BYTES = 32;

export interface DeviceInvite {
  owner: string;
  location: string;
  slot: string;
  /** Channel key for the request and the approval. */
  key: Uint8Array;
}

export function newChannelKey(): Uint8Array {
  return _sodium.randombytes_buf(CHANNEL_KEY_BYTES);
}

/** The TLTX payload of `transfer/<slot>.bin` (encrypted by the caller with `encryptForTransfer`). */
export function encodeInvite(i: DeviceInvite): Uint8Array {
  checkLocation(i.location);
  parseKey('ed25519', i.owner, 'owner');
  return enc.encode(JSON.stringify({ type: 'tl-device-invite', v: 1, owner: i.owner, location: i.location, slot: checkSlot(i.slot), key: toB64Url(i.key) }));
}

export function decodeInvite(bytes: Uint8Array): DeviceInvite {
  const o = JSON.parse(dec.decode(bytes)) as unknown;
  if (!isObj(o) || o['type'] !== 'tl-device-invite' || o['v'] !== 1 || typeof o['owner'] !== 'string' || typeof o['location'] !== 'string' || typeof o['slot'] !== 'string') throw new Error('bad-file');
  parseKey('ed25519', o['owner'], 'owner');
  checkLocation(o['location']);
  return { owner: o['owner'], location: o['location'], slot: checkSlot(o['slot']), key: fromB64Url(o['key'], 'key', CHANNEL_KEY_BYTES) };
}

export interface DeviceRequest {
  device: string;
  box: string;
  name: string;
}

function seal(json: unknown, key: Uint8Array, ad: Uint8Array): Uint8Array {
  const nonce = _sodium.randombytes_buf(24);
  return concat(nonce, _sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(enc.encode(JSON.stringify(json)), ad, null, nonce, key));
}

function open(bytes: Uint8Array, key: Uint8Array, ad: Uint8Array): unknown {
  if (bytes.length < 24 + 16) throw new Error('bad-file');
  const plain = _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.subarray(24), ad, bytes.subarray(0, 24), key);
  return JSON.parse(dec.decode(plain)) as unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sealRequest(r: DeviceRequest, channelKey: Uint8Array, slot: string): Uint8Array {
  return seal({ type: 'tl-device-request', v: 2, device: r.device, box: r.box, name: cleanDeviceName(r.name) }, channelKey, enc.encode(`req|${slot}`));
}

export function openRequest(bytes: Uint8Array, channelKey: Uint8Array, slot: string): DeviceRequest {
  const o = open(bytes, channelKey, enc.encode(`req|${slot}`));
  if (!isObj(o) || o['type'] !== 'tl-device-request' || o['v'] !== 2 || typeof o['name'] !== 'string') throw new Error('bad-file');
  parseKey('ed25519', o['device'], 'device');
  parseKey('x25519', o['box'], 'box');
  return { device: o['device'] as string, box: o['box'] as string, name: cleanDeviceName(o['name']) };
}

/** The approval: the device certificate and the sharing key sealed to the new device (TLSK mode 1). */
export function sealApproval(p: { cert: DeviceCert; sealed: Uint8Array }, channelKey: Uint8Array, slot: string): Uint8Array {
  return seal({ type: 'tl-device-approval', v: 2, cert: p.cert, sealed: toB64Url(p.sealed) }, channelKey, enc.encode(`ok|${slot}`));
}

/** The certificate inside (still to verify against the owner and this device's keys) and the sealed key. */
export function openApproval(bytes: Uint8Array, channelKey: Uint8Array, slot: string): { cert: unknown; sealed: string } {
  const o = open(bytes, channelKey, enc.encode(`ok|${slot}`));
  if (!isObj(o) || o['type'] !== 'tl-device-approval' || o['v'] !== 2 || !isObj(o['cert']) || typeof o['sealed'] !== 'string') throw new Error('bad-file');
  return { cert: o['cert'], sealed: o['sealed'] };
}

// ------------------------------------------------------------------ QR channel

export interface DeviceOffer {
  device: string;
  box: string;
  /** Ephemeral X25519 public key of the new device (this transfer only). */
  ephemeral: Uint8Array;
  name: string;
}

export interface DeviceReply {
  slot: string;
  ephemeral: Uint8Array;
  location: string;
}

export function cleanDeviceName(name: unknown): string {
  if (typeof name !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  while (enc.encode(s).length > MAX_NAME_BYTES) s = [...s].slice(0, -1).join('');
  return s;
}

export function encodeOffer(o: DeviceOffer): string {
  const name = enc.encode(cleanDeviceName(o.name));
  return OFFER_PREFIX + toB64Url(concat(parseKey('ed25519', o.device), parseKey('x25519', o.box), o.ephemeral, name));
}

function payloadOf(text: string, prefix: string): Uint8Array {
  const i = text.indexOf(prefix);
  if (i < 0) throw new Error('bad-code');
  const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i + prefix.length));
  if (!m) throw new Error('bad-code');
  return fromB64Url(m[0], 'code');
}

export function parseOffer(text: string): DeviceOffer {
  try {
    const b = payloadOf(text.trim(), OFFER_PREFIX);
    if (b.length < 96) throw new Error('short');
    const device = formatKey('ed25519', b.subarray(0, 32));
    const box = formatKey('x25519', b.subarray(32, 64));
    parseKey('x25519', box);
    const ephemeral = b.slice(64, 96);
    parseKey('x25519', formatKey('x25519', ephemeral));
    return { device, box, ephemeral, name: cleanDeviceName(dec.decode(b.subarray(96))) };
  } catch {
    throw new Error('bad-code');
  }
}

export function encodeReply(r: DeviceReply): string {
  checkLocation(r.location);
  return REPLY_PREFIX + toB64Url(concat(fromB64Url(r.slot, 'slot', SLOT_BYTES), r.ephemeral, enc.encode(r.location)));
}

export function parseReply(text: string): DeviceReply {
  try {
    const b = payloadOf(text.trim(), REPLY_PREFIX);
    if (b.length < SLOT_BYTES + 32 + 8) throw new Error('short');
    const slot = checkSlot(toB64Url(b.subarray(0, SLOT_BYTES)));
    const ephemeral = b.slice(SLOT_BYTES, SLOT_BYTES + 32);
    parseKey('x25519', formatKey('x25519', ephemeral));
    const location = dec.decode(b.subarray(SLOT_BYTES + 32));
    checkLocation(location);
    return { slot, ephemeral, location };
  } catch {
    throw new Error('bad-code');
  }
}

export interface EphemeralKeys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function ephemeralKeys(): EphemeralKeys {
  const kp = _sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** The shared temporary key: BLAKE2b(X25519(mine, theirs) | new device pk | old device pk | slot). */
export function sharedKey(mine: EphemeralKeys, theirs: Uint8Array, role: 'old' | 'new', slot: string): Uint8Array {
  const dh = _sodium.crypto_scalarmult(mine.secretKey, theirs);
  try {
    const [newPk, oldPk] = role === 'new' ? [mine.publicKey, theirs] : [theirs, mine.publicKey];
    return _sodium.crypto_generichash(32, concat(enc.encode('TrianguLair/device-qr/v1|'), dh, newPk, oldPk, fromB64Url(slot, 'slot', SLOT_BYTES)), null);
  } finally {
    _sodium.memzero(dh);
  }
}

export interface QrPackage {
  cert: unknown;
  /** b64url TLSK sealed to the new device (mode 1). */
  sealed: string;
}

export function sealQrPackage(p: { cert: DeviceCert; sealed: Uint8Array }, key: Uint8Array, slot: string): Uint8Array {
  return seal({ type: 'tl-device-qr', v: 1, cert: p.cert, sealed: toB64Url(p.sealed) }, key, enc.encode(`qr|${slot}`));
}

export function openQrPackage(bytes: Uint8Array, key: Uint8Array, slot: string): QrPackage {
  const o = open(bytes, key, enc.encode(`qr|${slot}`));
  if (!isObj(o) || o['type'] !== 'tl-device-qr' || o['v'] !== 1 || !isObj(o['cert']) || typeof o['sealed'] !== 'string') throw new Error('bad-file');
  return { cert: o['cert'], sealed: o['sealed'] };
}

// ------------------------------------------------------------------ confirmation

/** 12 digits shown on both screens to confirm the new device (3 groups of 4). */
export function deviceFingerprint(deviceId: string): string {
  const h = _sodium.crypto_generichash(16, enc.encode(`TrianguLair/device-fingerprint/v1|${deviceId}`), null);
  const groups: string[] = [];
  for (let i = 0; i < 3; i++) {
    const n = ((h[i * 4]! << 24) | (h[i * 4 + 1]! << 16) | (h[i * 4 + 2]! << 8) | h[i * 4 + 3]!) >>> 0;
    groups.push(String(n % 10000).padStart(4, '0'));
  }
  return groups.join(' ');
}
