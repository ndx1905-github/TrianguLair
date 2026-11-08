/**
 * Adding a device (spec "Adding a device", T-206): the app-level wrappers around the frozen crypto
 * structures. Nothing here is a crypto format; the crypto package is unchanged.
 *
 * Link + code (remote):
 *   - the old device seals `encodeKeyExport(current)` with `encryptForTransfer(…, code)` (TLTX,
 *     Argon2id, 15-minute authenticated expiry) and drops it at `transfer/<slot>.bin` on my storage;
 *   - the link is `https://triangulair.app/d#<b64url(1 | slot 16 B | read address)>`: the read
 *     address tells the new device where to fetch the blob anonymously (the read address serves the
 *     same folder); it holds no secret ("the link alone allows nothing");
 *   - the new device decrypts with the 6 words, reads the vault at the read address with the vault
 *     data key (storage write access, profile), deletes the blob (single use), and leaves a
 *     **request** `transfer/<slot>.req` with its public device keys and name;
 *   - the old device shows the request (name + a 12-digit fingerprint of the new device key, shown
 *     on both screens), issues the device certificate with the master key (primary device or the
 *     12 words) and writes the **approval** `transfer/<slot>.ok`.
 *   Request and approval are encrypted (XChaCha20-Poly1305) under BLAKE2b(key = sharing secret key,
 *   "TrianguLair/device-slot/v1" | kind | slot), a key both devices hold once the blob is opened,
 *   so the host learns no device name. The confirmation on both screens is what authenticates the
 *   request (someone else holding the sharing key, a device stolen and not declared yet, could
 *   write one during those 15 minutes).
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

export const DEVICE_LINK_BASE = 'https://triangulair.app/d';
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
  /** The certified read address: the blob is at `<location>transfer/<slot>.bin`. */
  location: string;
}

export function encodeDeviceLink(l: DeviceLink): string {
  checkLocation(l.location);
  return `${DEVICE_LINK_BASE}#${toB64Url(concat(Uint8Array.of(1), fromB64Url(l.slot, 'slot', SLOT_BYTES), enc.encode(l.location)))}`;
}

/** Finds a device link in pasted text (a mail, a message). Throws `Error('bad-link')`. */
export function parseDeviceLink(text: string): DeviceLink {
  const m = /triangulair\.app\/d#([A-Za-z0-9_-]+)/.exec(text.trim());
  if (!m) throw new Error('bad-link');
  try {
    const b = fromB64Url(m[1], 'link');
    if (b.length < 1 + SLOT_BYTES + 8 || b[0] !== 1) throw new Error('version');
    const slot = toB64Url(b.subarray(1, 1 + SLOT_BYTES));
    const location = dec.decode(b.subarray(1 + SLOT_BYTES));
    checkLocation(location);
    return { slot, location };
  } catch {
    throw new Error('bad-link');
  }
}

// ------------------------------------------------------------------ request / approval (sealed JSON)

export interface DeviceRequest {
  device: string;
  box: string;
  name: string;
}

function slotKey(sharingSecret: Uint8Array, kind: 'req' | 'ok', slot: string): Uint8Array {
  return _sodium.crypto_generichash(32, concat(enc.encode(`TrianguLair/device-slot/v1|${kind}|`), fromB64Url(slot, 'slot', SLOT_BYTES)), sharingSecret);
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

export function sealRequest(r: DeviceRequest, sharingSecret: Uint8Array, slot: string): Uint8Array {
  return seal({ type: 'tl-device-request', v: 1, device: r.device, box: r.box, name: r.name }, slotKey(sharingSecret, 'req', slot), enc.encode(`req|${slot}`));
}

export function openRequest(bytes: Uint8Array, sharingSecret: Uint8Array, slot: string): DeviceRequest {
  const o = open(bytes, slotKey(sharingSecret, 'req', slot), enc.encode(`req|${slot}`));
  if (!isObj(o) || o['type'] !== 'tl-device-request' || o['v'] !== 1 || typeof o['name'] !== 'string') throw new Error('bad-file');
  parseKey('ed25519', o['device'], 'device');
  parseKey('x25519', o['box'], 'box');
  return { device: o['device'] as string, box: o['box'] as string, name: cleanDeviceName(o['name']) };
}

export function sealApproval(cert: DeviceCert, sharingSecret: Uint8Array, slot: string): Uint8Array {
  return seal({ type: 'tl-device-approval', v: 1, cert }, slotKey(sharingSecret, 'ok', slot), enc.encode(`ok|${slot}`));
}

/** The certificate inside (still to verify against the owner and this device's keys). */
export function openApproval(bytes: Uint8Array, sharingSecret: Uint8Array, slot: string): unknown {
  const o = open(bytes, slotKey(sharingSecret, 'ok', slot), enc.encode(`ok|${slot}`));
  if (!isObj(o) || o['type'] !== 'tl-device-approval' || o['v'] !== 1 || !isObj(o['cert'])) throw new Error('bad-file');
  return o['cert'];
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
