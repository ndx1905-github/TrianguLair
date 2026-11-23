/**
 * The state machines of adding a device (spec "Adding a device", T-206), on both sides, over the
 * app-level channel of `channel.ts`. No React; storages and the master key are injected, so every
 * transition is unit-tested (`devices.test.ts`).
 *
 * Old device (this identity, any of my devices; the device certificate needs the master key:
 * primary device or the 12 words):
 *   LinkSender  idle → creating → waiting → request → approving → sent → done
 *                                                   (+ refused, expired, cancelled, failed)
 *   QrSender    idle → confirm → approving → showing → done              (+ refused, expired, cancelled, failed)
 *   The new device is listed (`register`) only once it has picked its keys up (review F-04); a
 *   refusal (or digits that differ) releases nothing, and the screen offers a key change (F-03).
 * New device (first launch, "I already have TrianguLair on another device"):
 *   LinkReceiver enter → opening → waiting (request link shown) → approved   (+ wrong-code, expired, gone, failed)
 *   QrReceiver   showing → opening → approved                            (+ gone, failed)
 *   restoreWithPhrase(phrase, read address)                              (the 12 words: no other device)
 */
import {
  decryptTransfer,
  devicePublicKeys,
  encryptForTransfer,
  encodePrimaryIdentity,
  ExpiredError,
  generateDeviceKeys,
  generateTransferCode,
  identityFromPhrase,
  issueDeviceCert,
  openSharingKey,
  openVault,
  sealSharingKey,
  toB64Url,
  fromB64Url,
  verifyDeviceCert,
  verifyIndex,
  type DeviceCert,
  type DeviceKeys,
  type SharingKey,
  type TransferParams,
} from '@triangulair/crypto';
import type { StorageAdapter } from '@triangulair/storage';
import { ContactBook, keyPath, VAULT_PATH } from '@triangulair/sync';

import { adoptLinkOriginFrom } from '../links/origin';
import type { MasterKeySource } from '../storage/certify';
import { parseConfig, type StorageConfig } from '../storage/config';
import {
  TRANSFER_WINDOW_MS,
  decodeInvite,
  deviceFingerprint,
  encodeDeviceLink,
  encodeInvite,
  encodeRequestLink,
  newChannelKey,
  parseRequestLink,
  type DeviceInvite,
  encodeOffer,
  encodeReply,
  ephemeralKeys,
  newSlot,
  openApproval,
  openQrPackage,
  openRequest,
  parseDeviceLink,
  parseOffer,
  parseReply,
  sealApproval,
  sealQrPackage,
  sealRequest,
  sharedKey,
  slotFiles,
  type DeviceOffer,
  type DeviceRequest,
  type EphemeralKeys,
} from './channel';

/**
 * Vault values written by every device (SyncController): the storage settings, my first name, and
 * the names I gave my contacts (owner id → name), so that a device restored with the kit or added
 * later shows them.
 */
export const VALUE_STORAGE = 'storage';
export const VALUE_PROFILE = 'profile';
export const VALUE_CONTACT_NAMES = 'contact-names';
/** Longest contact name kept in the vault value (what the contact screens accept). */
export const MAX_CONTACT_NAME = 80;

const MAX_FILE = 256 * 1024;
const INDEX = 'index.json';

type Listener = () => void;

class Machine<S> {
  private listeners = new Set<Listener>();
  constructor(protected s: S) {}
  get state(): S {
    return this.s;
  }
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  protected set(next: S): void {
    this.s = next;
    for (const l of this.listeners) l();
  }
}

async function quietDelete(a: StorageAdapter, path: string): Promise<void> {
  try {
    await a.delete(path);
  } catch {
    // already gone, or no write access: it expires anyway
  }
}

function errorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (m === 'phrase-mismatch' || m === 'master-key-needed' || m === 'bad-link' || m === 'bad-code') return m;
  return 'failed';
}

// ================================================================== old device

export interface OldDeviceDeps {
  /** My storage, with write access. */
  storage: StorageAdapter;
  /** My certified read address (where the new device reads anonymously). */
  location: string;
  /** My current sharing key (sharing key pair, certificate, vault data key). */
  sharing(): Promise<SharingKey>;
  /** Issues the master-signed device certificate (`IdentityApi.certifyDevice`). */
  certify(pub: { device: string; box: string }, master: MasterKeySource): Promise<DeviceCert>;
  /** Lists the new device in the vault and publishes (SyncController.addDevice). */
  register(cert: DeviceCert, name: string): Promise<void>;
  /** A slot whose files must be deleted at `expiresAt` even if this screen is closed. */
  trackSlot?(slot: string, expiresAt: number): void;
  now?: () => number;
  /** Argon2id parameters (default: libsodium INTERACTIVE, the format's minimum). */
  argon?: TransferParams;
}

export interface PendingDevice extends DeviceRequest {
  /** 12 digits (3 groups of 4) of the new device key, shown in full on the new device. */
  fingerprint: string;
}

/** The last 4 digits of the number, which the user types on the old device (devices review F-03). */
export function lastDigits(fingerprint: string): string {
  return fingerprint.replace(/\D/g, '').slice(-4);
}

/** The number as the old device shows it: the last group is what the user types. */
export function maskedFingerprint(fingerprint: string): string {
  return fingerprint.replace(/\d{4}$/, '····');
}

function digitsMatch(device: PendingDevice, typed: string): boolean {
  return typed.replace(/\D/g, '') === lastDigits(device.fingerprint);
}

export type LinkSenderState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'waiting'; link: string; code: string; expiresAt: number; error?: 'bad-link' }
  | { phase: 'request'; link: string; code: string; expiresAt: number; device: PendingDevice; error?: string }
  | { phase: 'approving'; link: string; code: string; expiresAt: number; device: PendingDevice }
  | { phase: 'sent'; name: string; device: string; expiresAt: number }
  | { phase: 'done'; name: string; device: string }
  | { phase: 'refused'; device: PendingDevice }
  | { phase: 'expired' }
  | { phase: 'cancelled' }
  | { phase: 'failed'; error: string };

/**
 * "Link + code" on the old device (channel.ts): an invitation to enrol, then the new device's
 * request link pasted here, the number checked (last 4 digits typed), the certificate issued with
 * the master key, and only then the keys sealed to the new device. Nothing is listed or delivered
 * until the new device has picked its approval up.
 */
export class LinkSender extends Machine<LinkSenderState> {
  private slot = '';
  private key: Uint8Array | null = null;
  private cert: DeviceCert | null = null;
  constructor(private readonly d: OldDeviceDeps) {
    super({ phase: 'idle' });
  }
  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    if (this.s.phase !== 'idle') return;
    this.set({ phase: 'creating' });
    try {
      const sharing = await this.d.sharing();
      this.slot = newSlot();
      this.key = newChannelKey();
      const code = generateTransferCode();
      const now = this.now();
      const invite = encodeInvite({ owner: sharing.cert.owner, location: this.d.location, slot: this.slot, key: this.key });
      const blob = encryptForTransfer(invite, code, { now: new Date(now), ttlMs: TRANSFER_WINDOW_MS, ...(this.d.argon && { params: this.d.argon }) });
      const expiresAt = now + TRANSFER_WINDOW_MS;
      this.d.trackSlot?.(this.slot, expiresAt);
      await this.d.storage.put(slotFiles(this.slot).blob, blob, { contentType: 'application/octet-stream' });
      this.set({ phase: 'waiting', link: encodeDeviceLink({ slot: this.slot, location: this.d.location }), code, expiresAt });
    } catch (e) {
      this.wipe();
      this.set({ phase: 'failed', error: errorCode(e) });
    }
  }

  /** The new device's request link, pasted here. Sets `error: 'bad-link'` when it is not this transfer's. */
  received(text: string): void {
    const s = this.s;
    if (s.phase !== 'waiting' || !this.key) return;
    if (this.now() >= s.expiresAt) {
      void this.expire();
      return;
    }
    try {
      const r = parseRequestLink(text);
      if (r.slot !== this.slot) throw new Error('another transfer');
      const req = openRequest(r.sealed, this.key, this.slot);
      this.set({ phase: 'request', link: s.link, code: s.code, expiresAt: s.expiresAt, device: { ...req, fingerprint: deviceFingerprint(req.device) } });
    } catch {
      this.set({ ...s, error: 'bad-link' });
    }
  }

  /**
   * The user typed the last 4 digits the new device shows (`digits`) and the master key is at hand:
   * issue the certificate, seal the keys to the new device, drop the approval.
   */
  async approve(master: MasterKeySource, digits: string): Promise<void> {
    const s = this.s;
    if (s.phase !== 'request' || !this.key) return;
    if (this.now() >= s.expiresAt) return this.expire();
    if (!digitsMatch(s.device, digits)) return this.set({ ...s, error: 'digits' });
    this.set({ phase: 'approving', link: s.link, code: s.code, expiresAt: s.expiresAt, device: s.device });
    try {
      const cert = await this.d.certify({ device: s.device.device, box: s.device.box }, master);
      const sharing = await this.d.sharing();
      await this.d.storage.put(slotFiles(this.slot).approval, sealApproval({ cert, sealed: sealSharingKey(sharing, cert) }, this.key, this.slot), { contentType: 'application/octet-stream' });
      await quietDelete(this.d.storage, slotFiles(this.slot).blob);
      this.cert = cert;
      this.wipe();
      this.set({ phase: 'sent', name: s.device.name, device: cert.device, expiresAt: s.expiresAt });
    } catch (e) {
      const error = errorCode(e);
      // A wrong phrase can be typed again; anything else ends the transfer.
      if (error === 'phrase-mismatch' || error === 'master-key-needed') this.set({ ...s, error });
      else {
        await this.cleanup();
        this.set({ phase: 'failed', error });
      }
    }
  }

  /** The new device picked its approval up (it deletes the file): list it now. */
  async poll(): Promise<void> {
    const s = this.s;
    if (s.phase === 'waiting' || s.phase === 'request') {
      if (this.now() >= s.expiresAt) await this.expire();
      return;
    }
    if (s.phase !== 'sent') return;
    try {
      if (!(await this.d.storage.head(slotFiles(this.slot).approval))) return this.finish();
    } catch {
      return; // try again
    }
    if (this.now() >= s.expiresAt) await this.expire();
  }

  private async finish(): Promise<void> {
    const s = this.s;
    if (s.phase !== 'sent' || !this.cert) return;
    this.set({ phase: 'done', name: s.name, device: s.device });
    try {
      await this.d.register(this.cert, s.name);
    } catch {
      // it lists itself at its first sync anyway
    }
  }

  /** Not my device (or the digits differ): nothing was given to it. The screen offers a key change. */
  async refuse(): Promise<void> {
    const s = this.s;
    if (s.phase !== 'request') return this.cancel();
    await this.cleanup();
    this.set({ phase: 'refused', device: s.device });
  }

  async cancel(): Promise<void> {
    const s = this.s;
    if (s.phase === 'done' || s.phase === 'cancelled' || s.phase === 'refused') return;
    if (s.phase === 'sent') {
      // Picked up already: the device has its keys, it is listed (remove it from Settings › Devices).
      const there = await this.d.storage.head(slotFiles(this.slot).approval).catch(() => true);
      if (!there) return this.finish();
    }
    await this.cleanup();
    this.set({ phase: 'cancelled' });
  }

  private async expire(): Promise<void> {
    await this.cleanup();
    this.set({ phase: 'expired' });
  }

  private async cleanup(): Promise<void> {
    this.wipe();
    if (!this.slot) return;
    const f = slotFiles(this.slot);
    for (const p of [f.blob, f.request, f.approval]) await quietDelete(this.d.storage, p);
  }

  private wipe(): void {
    this.key?.fill(0);
    this.key = null;
  }
}

export type QrSenderState =
  | { phase: 'idle' }
  | { phase: 'confirm'; device: PendingDevice; error?: string }
  | { phase: 'approving'; device: PendingDevice }
  | { phase: 'showing'; reply: string; name: string; expiresAt: number }
  | { phase: 'done'; name: string; device: string }
  | { phase: 'refused'; device: PendingDevice }
  | { phase: 'expired' }
  | { phase: 'cancelled' }
  | { phase: 'failed'; error: string };

/**
 * "QR code" on the old device: scan the new device's code, check the number (last 4 digits typed),
 * approve, show the answer code. The new device is listed only once it has fetched its package
 * (devices review F-04): "Cancel" before that leaves nothing behind.
 */
export class QrSender extends Machine<QrSenderState> {
  private offer: DeviceOffer | null = null;
  private slot = '';
  private cert: DeviceCert | null = null;
  constructor(private readonly d: OldDeviceDeps) {
    super({ phase: 'idle' });
  }
  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** The new device's code, scanned or pasted. Throws `Error('bad-code')`. */
  scanned(text: string): void {
    if (this.s.phase !== 'idle' && this.s.phase !== 'confirm') return;
    const offer = parseOffer(text);
    this.offer = offer;
    this.set({ phase: 'confirm', device: { device: offer.device, box: offer.box, name: offer.name, fingerprint: deviceFingerprint(offer.device) } });
  }

  async approve(master: MasterKeySource, digits: string): Promise<void> {
    const s = this.s;
    if (s.phase !== 'confirm' || !this.offer) return;
    if (!digitsMatch(s.device, digits)) return this.set({ ...s, error: 'digits' });
    this.set({ phase: 'approving', device: s.device });
    const eph: EphemeralKeys = ephemeralKeys();
    try {
      const cert = await this.d.certify({ device: this.offer.device, box: this.offer.box }, master);
      const sharing = await this.d.sharing();
      this.slot = newSlot();
      const key = sharedKey(eph, this.offer.ephemeral, 'old', this.slot);
      const bytes = sealQrPackage({ cert, sealed: sealSharingKey(sharing, cert) }, key, this.slot);
      key.fill(0);
      const expiresAt = this.now() + TRANSFER_WINDOW_MS;
      this.d.trackSlot?.(this.slot, expiresAt);
      await this.d.storage.put(slotFiles(this.slot).qr, bytes, { contentType: 'application/octet-stream' });
      this.cert = cert;
      this.set({ phase: 'showing', reply: encodeReply({ slot: this.slot, ephemeral: eph.publicKey, location: this.d.location }), name: s.device.name, expiresAt });
    } catch (e) {
      const error = errorCode(e);
      if (error === 'phrase-mismatch' || error === 'master-key-needed') this.set({ ...s, error });
      else this.set({ phase: 'failed', error });
    } finally {
      eph.secretKey.fill(0);
    }
  }

  /** The new device deletes the file once it has it: then it is listed and this side is done. */
  async poll(): Promise<void> {
    const s = this.s;
    if (s.phase !== 'showing') return;
    try {
      if (!(await this.d.storage.head(slotFiles(this.slot).qr))) return this.finish();
    } catch {
      return; // try again
    }
    if (this.now() >= s.expiresAt) {
      await quietDelete(this.d.storage, slotFiles(this.slot).qr);
      this.set({ phase: 'expired' });
    }
  }

  private async finish(): Promise<void> {
    const s = this.s;
    if (s.phase !== 'showing' || !this.cert) return;
    this.set({ phase: 'done', name: s.name, device: this.cert.device });
    try {
      await this.d.register(this.cert, s.name);
    } catch {
      // it lists itself at its first sync anyway
    }
  }

  /** Not my device (or the digits differ): nothing was given to it. The screen offers a key change. */
  refuse(): void {
    const s = this.s;
    if (s.phase === 'confirm') this.set({ phase: 'refused', device: s.device });
    else void this.cancel();
  }

  async cancel(): Promise<void> {
    const s = this.s;
    if (s.phase === 'done' || s.phase === 'cancelled' || s.phase === 'refused') return;
    if (s.phase === 'showing') {
      // Fetched already: the device has its keys, it is listed (remove it from Settings › Devices).
      const there = await this.d.storage.head(slotFiles(this.slot).qr).catch(() => true);
      if (!there) return this.finish();
    }
    if (this.slot) await quietDelete(this.d.storage, slotFiles(this.slot).qr);
    this.set({ phase: 'cancelled' });
  }
}

// ================================================================== new device

/** What a new device holds once it joined: enough to store an identity and sync. */
export interface Joined {
  owner: string;
  deviceKeys: DeviceKeys;
  deviceCert: DeviceCert;
  sharing: SharingKey;
  /** My storage with write access, from the vault (null: not there, or credentials to type again). */
  storage: StorageConfig | null;
  /** My first name, from the vault. */
  profileName: string;
  /** TLPI blob, when this device keeps the master key (phrase path only). */
  primaryIdentity: string | null;
  /** The phrase-protected copy of the sharing key (phrase path), for the recovery vault file. */
  vaultCopy: Uint8Array | null;
}

export interface NewDeviceDeps {
  /** Anonymous HTTPS reads at a read address (`HttpsReadOnlyAdapter`). */
  readAdapter(location: string): StorageAdapter;
  /** My storage with the credentials found in the vault. */
  writeAdapter(config: StorageConfig): StorageAdapter;
  now?: () => number;
}

/**
 * Reads my vault at the read address with the vault data key: storage settings and first name,
 * as signed by my master key or a certified device my current certificate does not revoke
 * (devices review F-01; a value planted by a lost device is not taken).
 */
export async function readVaultValues(adapter: StorageAdapter, sharing: SharingKey): Promise<{ storage: StorageConfig | null; profileName: string }> {
  const g = await adapter.get(VAULT_PATH, { maxBytes: 16 * 1024 * 1024 });
  if (!g) return { storage: null, profileName: '' };
  const book = new ContactBook(openVault(g.data, sharing.cert.owner, sharing.vaultDataKey));
  const trust = { revoked: sharing.cert.revoked_devices };
  let storage: StorageConfig | null = null;
  try {
    const v = book.value<unknown>(VALUE_STORAGE, trust)?.value;
    storage = v ? parseConfig(v) : null;
  } catch {
    storage = null;
  }
  const p = book.value<{ name?: unknown }>(VALUE_PROFILE, trust)?.value;
  return { storage, profileName: typeof p?.name === 'string' ? p.name : '' };
}

export type LinkReceiverState =
  | { phase: 'enter'; error?: 'bad-link' | 'wrong-code' | 'expired' | 'gone' | 'failed' }
  | { phase: 'opening' }
  | { phase: 'waiting'; requestLink: string; fingerprint: string; error?: string }
  | { phase: 'approved'; joined: Joined }
  | { phase: 'failed'; error: 'failed' };

/**
 * "Link + code" on the new device: open the invitation with the 6 words, show the request link to
 * send back and the number, then wait for the approval, which alone carries the keys (F-03).
 */
export class LinkReceiver extends Machine<LinkReceiverState> {
  readonly deviceKeys: DeviceKeys;
  private ctx: { invite: DeviceInvite; reader: StorageAdapter } | null = null;
  private linkText = '';
  constructor(private readonly d: NewDeviceDeps, private readonly deviceName: string) {
    super({ phase: 'enter' });
    this.deviceKeys = generateDeviceKeys();
  }
  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
  get fingerprint(): string {
    return deviceFingerprint(this.deviceKeys.id);
  }

  async open(linkText: string, code: string): Promise<void> {
    if (this.s.phase !== 'enter') return;
    let link;
    try {
      link = parseDeviceLink(linkText);
    } catch {
      return this.set({ phase: 'enter', error: 'bad-link' });
    }
    this.set({ phase: 'opening' });
    let invite: DeviceInvite;
    let reader: StorageAdapter;
    try {
      reader = this.d.readAdapter(link.location);
      const g = await reader.get(slotFiles(link.slot).blob, { maxBytes: MAX_FILE });
      if (!g) return this.set({ phase: 'enter', error: 'gone' });
      let plain: Uint8Array;
      try {
        plain = decryptTransfer(g.data, code, { now: new Date(this.now()) });
      } catch (e) {
        if (e instanceof ExpiredError) return this.set({ phase: 'enter', error: 'expired' });
        return this.set({ phase: 'enter', error: 'wrong-code' });
      }
      invite = decodeInvite(plain);
      // The invitation names my read address and this slot: they must be the link's.
      if (invite.location !== link.location || invite.slot !== link.slot) return this.set({ phase: 'enter', error: 'failed' });
    } catch {
      return this.set({ phase: 'enter', error: 'failed' });
    }
    this.linkText = linkText;
    const pub = devicePublicKeys(this.deviceKeys);
    const sealed = sealRequest({ device: pub.device, box: pub.box, name: this.deviceName }, invite.key, invite.slot);
    this.ctx = { invite, reader };
    this.set({ phase: 'waiting', requestLink: encodeRequestLink(invite.slot, sealed), fingerprint: this.fingerprint });
  }

  /** Looks for the old device's approval (every few seconds while waiting). */
  async poll(): Promise<void> {
    const c = this.ctx;
    if (this.s.phase !== 'waiting' || !c) return;
    const f = slotFiles(c.invite.slot);
    let joined: Joined;
    try {
      const g = await c.reader.get(f.approval, { maxBytes: MAX_FILE });
      if (!g) return;
      const a = openApproval(g.data, c.invite.key, c.invite.slot);
      const owner = c.invite.owner;
      const cert = verifyDeviceCert(a.cert as never, { expectedOwner: owner });
      if (cert.device !== this.deviceKeys.id || cert.box !== devicePublicKeys(this.deviceKeys).box) return;
      const sharing = openSharingKey(fromB64Url(a.sealed, 'sealed'), this.deviceKeys, { expectedOwner: owner });
      if (sharing.cert.location !== c.invite.location) return;
      const v = await readVaultValues(c.reader, sharing);
      joined = { owner, deviceKeys: this.deviceKeys, deviceCert: cert, sharing, storage: v.storage, profileName: v.profileName, primaryIdentity: null, vaultCopy: null };
    } catch {
      return; // not there yet, or not for me
    }
    // Added from the web app: its address becomes this phone's link address (src/links/origin.ts).
    adoptLinkOriginFrom(this.linkText);
    // Picked up: the old device sees the file gone and lists this device.
    if (joined.storage && joined.storage.kind !== 'https') {
      const w = this.d.writeAdapter(joined.storage);
      for (const p of [f.approval, f.blob, f.request]) await quietDelete(w, p);
    }
    this.wipe();
    this.set({ phase: 'approved', joined });
  }

  /**
   * While waiting: the other device is out of reach. The 12 words restore from the read address
   * the invitation named (`restoreWithPhrase`), for the identity it named.
   */
  async certifyWithPhrase(phrase: string, opts: { primary?: boolean } = {}): Promise<void> {
    const c = this.ctx;
    const s = this.s;
    if (s.phase !== 'waiting' || !c) return;
    try {
      const id = identityFromPhrase(normalizePhrase(phrase));
      const owner = id.owner;
      id.master.secretKey.fill(0);
      id.vaultKey.fill(0);
      if (owner !== c.invite.owner) return this.set({ ...s, error: 'phrase-mismatch' });
    } catch {
      return this.set({ ...s, error: 'phrase-mismatch' });
    }
    try {
      const joined = await restoreWithPhrase(phrase, c.invite.location, this.d, { ...opts, deviceKeys: this.deviceKeys });
      if (joined.storage && joined.storage.kind !== 'https') {
        const w = this.d.writeAdapter(joined.storage);
        for (const p of Object.values(slotFiles(c.invite.slot))) await quietDelete(w, p);
      }
      this.wipe();
      this.set({ phase: 'approved', joined });
    } catch (e) {
      this.set({ ...s, error: e instanceof RestoreFailed ? e.code : 'failed' });
    }
  }

  private wipe(): void {
    this.ctx?.invite.key.fill(0);
    this.ctx = null;
  }

  /** Back to the link and code fields. */
  reset(): void {
    if (this.s.phase === 'enter' || this.s.phase === 'failed') this.set({ phase: 'enter' });
  }
}

export type QrReceiverState =
  | { phase: 'showing'; offer: string; fingerprint: string; error?: 'bad-code' | 'gone' | 'failed' }
  | { phase: 'opening' }
  | { phase: 'approved'; joined: Joined };

/** "QR code" on the new device: show my code, then scan the old device's answer. */
export class QrReceiver extends Machine<QrReceiverState> {
  readonly deviceKeys: DeviceKeys;
  private readonly eph: EphemeralKeys;
  constructor(private readonly d: NewDeviceDeps, deviceName: string) {
    const deviceKeys = generateDeviceKeys();
    const eph = ephemeralKeys();
    const pub = devicePublicKeys(deviceKeys);
    super({ phase: 'showing', offer: encodeOffer({ device: pub.device, box: pub.box, ephemeral: eph.publicKey, name: deviceName }), fingerprint: deviceFingerprint(deviceKeys.id) });
    this.deviceKeys = deviceKeys;
    this.eph = eph;
  }

  async scanned(text: string): Promise<void> {
    const s = this.s;
    if (s.phase !== 'showing') return;
    let reply;
    try {
      reply = parseReply(text);
    } catch {
      return this.set({ ...s, error: 'bad-code' });
    }
    this.set({ phase: 'opening' });
    try {
      const reader = this.d.readAdapter(reply.location);
      const g = await reader.get(slotFiles(reply.slot).qr, { maxBytes: MAX_FILE });
      if (!g) return this.set({ ...s, error: 'gone' });
      const key = sharedKey(this.eph, reply.ephemeral, 'new', reply.slot);
      const pkg = openQrPackage(g.data, key, reply.slot);
      key.fill(0);
      const sharing = openSharingKey(fromB64Url(pkg.sealed, 'sealed'), this.deviceKeys);
      const cert = verifyDeviceCert(pkg.cert as never, { expectedOwner: sharing.cert.owner });
      if (cert.device !== this.deviceKeys.id || cert.box !== devicePublicKeys(this.deviceKeys).box) throw new Error('not for me');
      if (sharing.cert.location !== reply.location) throw new Error('another address');
      const v = await readVaultValues(reader, sharing);
      if (v.storage && v.storage.kind !== 'https') await this.d.writeAdapter(v.storage).delete(slotFiles(reply.slot).qr).catch(() => {});
      this.eph.secretKey.fill(0);
      this.set({ phase: 'approved', joined: { owner: sharing.cert.owner, deviceKeys: this.deviceKeys, deviceCert: cert, sharing, storage: v.storage, profileName: v.profileName, primaryIdentity: null, vaultCopy: null } });
    } catch {
      this.set({ ...s, error: 'failed' });
    }
  }
}

export function normalizePhrase(p: string): string {
  return p.trim().toLowerCase().split(/\s+/).join(' ');
}

export type RestoreError = 'phrase' | 'address' | 'not-found' | 'stale' | 'failed';

export class RestoreFailed extends Error {
  constructor(readonly code: RestoreError) {
    super(code);
  }
}

/**
 * The certificate my index publishes at `reader` (master-signed; null when there is no index).
 * Throws when an index is there but does not verify for me.
 */
async function publishedCert(reader: StorageAdapter, owner: string): Promise<{ key: string; location: string; rotation: number } | null> {
  const g = await reader.get(INDEX, { maxBytes: 4 * 1024 * 1024 });
  if (!g) return null;
  return verifyIndex(g.data, { expectedOwner: owner }).sharing_cert;
}

/**
 * The 12 words and the storage read address (the recovery kit): the phrase-protected copy of my
 * sharing key at `keys/<owner>.bin`, then the vault. This device gets its own keys and a device
 * certificate from the phrase.
 *
 * Freshness (devices review F-05): the copy must hold the certificate my index publishes there
 * (same rotation and key; a copy put back from before a declaration of loss is refused, `stale`),
 * and the vault must open with it. When the index there certifies another address (the kit names a
 * previous storage, which keeps a signed redirect), the restore continues at that address.
 */
export async function restoreWithPhrase(phrase: string, location: string, d: NewDeviceDeps, opts: { primary?: boolean; deviceKeys?: DeviceKeys } = {}): Promise<Joined> {
  let id;
  try {
    id = identityFromPhrase(normalizePhrase(phrase));
  } catch {
    throw new RestoreFailed('phrase');
  }
  try {
    let at = location.trim();
    let reader: StorageAdapter;
    let g;
    let published: { key: string; location: string; rotation: number } | null;
    for (let hop = 0; ; hop++) {
      try {
        reader = d.readAdapter(at);
        published = await publishedCert(reader, id.owner);
        g = await reader.get(keyPath(id.owner), { maxBytes: MAX_FILE });
      } catch {
        throw new RestoreFailed('address');
      }
      // A previous storage: its index is the signed redirect to where I live now.
      if (hop === 0 && published?.location && published.location !== at) {
        at = published.location;
        continue;
      }
      break;
    }
    if (!g) throw new RestoreFailed('not-found');
    let sharing: SharingKey;
    try {
      sharing = openSharingKey(g.data, id, { expectedOwner: id.owner });
    } catch {
      throw new RestoreFailed('not-found');
    }
    if (published && (published.rotation > sharing.cert.rotation || (published.rotation === sharing.cert.rotation && published.key !== sharing.cert.key))) {
      throw new RestoreFailed('stale');
    }
    let v: { storage: StorageConfig | null; profileName: string };
    try {
      v = await readVaultValues(sharing.cert.location ? d.readAdapter(sharing.cert.location) : reader, sharing);
    } catch {
      // A vault that does not open with this key was written under a newer one.
      throw new RestoreFailed('stale');
    }
    const deviceKeys = opts.deviceKeys ?? generateDeviceKeys();
    const deviceCert = issueDeviceCert(id, devicePublicKeys(deviceKeys));
    return {
      owner: id.owner,
      deviceKeys,
      deviceCert,
      sharing,
      storage: v.storage,
      profileName: v.profileName,
      primaryIdentity: opts.primary ? toB64Url(encodePrimaryIdentity(id)) : null,
      vaultCopy: sealSharingKey(sharing, id),
    };
  } catch (e) {
    if (e instanceof RestoreFailed) throw e;
    throw new RestoreFailed('failed');
  } finally {
    id.master.secretKey.fill(0);
    id.vaultKey.fill(0);
  }
}
