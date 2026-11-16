/**
 * The state machines of adding a device (spec "Adding a device", T-206), on both sides, over the
 * app-level channel of `channel.ts`. No React; storages and the master key are injected, so every
 * transition is unit-tested (`devices.test.ts`).
 *
 * Old device (this identity, any of my devices; the device certificate needs the master key:
 * primary device or the 12 words):
 *   LinkSender  idle → creating → waiting → request → approving → done   (+ expired, cancelled, failed)
 *   QrSender    idle → confirm → approving → showing → done              (+ expired, cancelled, failed)
 * New device (first launch, "I already have TrianguLair on another device"):
 *   LinkReceiver enter → opening → waiting → approved                    (+ wrong-code, expired, gone, failed)
 *   QrReceiver   showing → opening → approved                            (+ gone, failed)
 *   restoreWithPhrase(phrase, read address)                              (the 12 words: no other device)
 */
import {
  decodeKeyExport,
  decryptTransfer,
  devicePublicKeys,
  encodeKeyExport,
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
  type DeviceCert,
  type DeviceKeys,
  type SharingKey,
  type TransferParams,
} from '@triangulair/crypto';
import type { StorageAdapter } from '@triangulair/storage';
import { ContactBook, keyPath, VAULT_PATH } from '@triangulair/sync';

import type { MasterKeySource } from '../storage/certify';
import { parseConfig, type StorageConfig } from '../storage/config';
import {
  TRANSFER_WINDOW_MS,
  deviceFingerprint,
  encodeDeviceLink,
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

/** Vault values written by every device (SyncController): the storage settings and my first name. */
export const VALUE_STORAGE = 'storage';
export const VALUE_PROFILE = 'profile';

const MAX_FILE = 256 * 1024;

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
  fingerprint: string;
}

export type LinkSenderState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'waiting'; link: string; code: string; expiresAt: number }
  | { phase: 'request'; link: string; code: string; expiresAt: number; device: PendingDevice; error?: string }
  | { phase: 'approving'; link: string; code: string; expiresAt: number; device: PendingDevice }
  | { phase: 'done'; name: string; device: string }
  | { phase: 'expired' }
  | { phase: 'cancelled' }
  | { phase: 'failed'; error: string };

/** "Link + code" on the old device. */
export class LinkSender extends Machine<LinkSenderState> {
  private slot = '';
  private secret: Uint8Array | null = null;
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
      this.secret = sharing.keyPair.secretKey.slice();
      this.slot = newSlot();
      const code = generateTransferCode();
      const now = this.now();
      const blob = encryptForTransfer(encodeKeyExport(sharing), code, { now: new Date(now), ttlMs: TRANSFER_WINDOW_MS, ...(this.d.argon && { params: this.d.argon }) });
      await this.d.storage.put(slotFiles(this.slot).blob, blob, { contentType: 'application/octet-stream' });
      const expiresAt = now + TRANSFER_WINDOW_MS;
      this.d.trackSlot?.(this.slot, expiresAt);
      this.set({ phase: 'waiting', link: encodeDeviceLink({ slot: this.slot, location: this.d.location }), code, expiresAt });
    } catch (e) {
      this.set({ phase: 'failed', error: errorCode(e) });
    }
  }

  /** Looks for the new device's request (call every few seconds while waiting). */
  async poll(): Promise<void> {
    const s = this.s;
    if (s.phase !== 'waiting' && s.phase !== 'request') return;
    if (this.now() >= s.expiresAt) return this.expire();
    if (s.phase !== 'waiting' || !this.secret) return;
    const f = slotFiles(this.slot);
    try {
      const g = await this.d.storage.get(f.request, { maxBytes: MAX_FILE });
      if (!g) return;
      const req = openRequest(g.data, this.secret, this.slot);
      if (this.s.phase !== 'waiting') return;
      this.set({ ...s, phase: 'request', device: { ...req, fingerprint: deviceFingerprint(req.device) } });
    } catch {
      // a broken or foreign file: ignore it, the real request may still come
    }
  }

  /** The user checked the fingerprint on both screens: issue the certificate. */
  async approve(master: MasterKeySource): Promise<void> {
    const s = this.s;
    if (s.phase !== 'request' || !this.secret) return;
    if (this.now() >= s.expiresAt) return this.expire();
    this.set({ phase: 'approving', link: s.link, code: s.code, expiresAt: s.expiresAt, device: s.device });
    try {
      const cert = await this.d.certify({ device: s.device.device, box: s.device.box }, master);
      await this.d.storage.put(slotFiles(this.slot).approval, sealApproval(cert, this.secret, this.slot), { contentType: 'application/octet-stream' });
      await quietDelete(this.d.storage, slotFiles(this.slot).request);
      await quietDelete(this.d.storage, slotFiles(this.slot).blob);
      await this.d.register(cert, s.device.name);
      this.wipe();
      this.set({ phase: 'done', name: s.device.name, device: cert.device });
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

  /** Not my device: refuse and close the transfer. */
  async refuse(): Promise<void> {
    await this.cancel();
  }

  async cancel(): Promise<void> {
    if (this.s.phase === 'done' || this.s.phase === 'cancelled') return;
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
    this.secret?.fill(0);
    this.secret = null;
  }
}

export type QrSenderState =
  | { phase: 'idle' }
  | { phase: 'confirm'; device: PendingDevice; error?: string }
  | { phase: 'approving'; device: PendingDevice }
  | { phase: 'showing'; reply: string; name: string; expiresAt: number }
  | { phase: 'done'; name: string; device: string }
  | { phase: 'expired' }
  | { phase: 'cancelled' }
  | { phase: 'failed'; error: string };

/** "QR code" on the old device: scan the new device's code, approve, show the answer code. */
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

  async approve(master: MasterKeySource): Promise<void> {
    const s = this.s;
    if (s.phase !== 'confirm' || !this.offer) return;
    this.set({ phase: 'approving', device: s.device });
    const eph: EphemeralKeys = ephemeralKeys();
    try {
      const cert = await this.d.certify({ device: this.offer.device, box: this.offer.box }, master);
      const sharing = await this.d.sharing();
      this.slot = newSlot();
      const key = sharedKey(eph, this.offer.ephemeral, 'old', this.slot);
      const bytes = sealQrPackage({ cert, sealed: sealSharingKey(sharing, cert) }, key, this.slot);
      key.fill(0);
      await this.d.storage.put(slotFiles(this.slot).qr, bytes, { contentType: 'application/octet-stream' });
      const expiresAt = this.now() + TRANSFER_WINDOW_MS;
      this.d.trackSlot?.(this.slot, expiresAt);
      await this.d.register(cert, s.device.name);
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

  /** The new device deletes the file once it has it: then this side is done. */
  async poll(): Promise<void> {
    const s = this.s;
    if (s.phase !== 'showing') return;
    if (this.now() >= s.expiresAt) {
      await quietDelete(this.d.storage, slotFiles(this.slot).qr);
      this.set({ phase: 'expired' });
      return;
    }
    try {
      if (!(await this.d.storage.head(slotFiles(this.slot).qr))) this.set({ phase: 'done', name: s.name, device: this.cert!.device });
    } catch {
      // try again
    }
  }

  async cancel(): Promise<void> {
    if (this.s.phase === 'done' || this.s.phase === 'cancelled') return;
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
  | { phase: 'waiting'; fingerprint: string; error?: string }
  | { phase: 'approved'; joined: Joined }
  | { phase: 'failed'; error: 'no-storage' | 'storage-write' | 'failed' };

/** "Link + code" on the new device. */
export class LinkReceiver extends Machine<LinkReceiverState> {
  readonly deviceKeys: DeviceKeys;
  private ctx: { slot: string; location: string; sharing: SharingKey; storage: StorageConfig; profileName: string; writer: StorageAdapter } | null = null;
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
    const reader = this.d.readAdapter(link.location);
    const files = slotFiles(link.slot);
    let sharing: SharingKey;
    try {
      const g = await reader.get(files.blob, { maxBytes: MAX_FILE });
      if (!g) return this.set({ phase: 'enter', error: 'gone' });
      let plain: Uint8Array;
      try {
        plain = decryptTransfer(g.data, code, { now: new Date(this.now()) });
      } catch (e) {
        if (e instanceof ExpiredError) return this.set({ phase: 'enter', error: 'expired' });
        return this.set({ phase: 'enter', error: 'wrong-code' });
      }
      sharing = decodeKeyExport(plain);
      plain.fill(0);
      // The key export certifies my read address: it must be the one the link pointed to.
      if (sharing.cert.location !== link.location) return this.set({ phase: 'enter', error: 'failed' });
    } catch {
      return this.set({ phase: 'enter', error: 'failed' });
    }
    try {
      const v = await readVaultValues(reader, sharing);
      if (!v.storage || v.storage.kind === 'https') return this.set({ phase: 'failed', error: 'no-storage' });
      const writer = this.d.writeAdapter(v.storage);
      // Single use: the blob goes as soon as it is opened.
      await writer.delete(files.blob).catch(() => {});
      const pub = devicePublicKeys(this.deviceKeys);
      await writer.put(files.request, sealRequest({ device: pub.device, box: pub.box, name: this.deviceName }, sharing.keyPair.secretKey, link.slot), { contentType: 'application/octet-stream' });
      this.ctx = { slot: link.slot, location: link.location, sharing, storage: v.storage, profileName: v.profileName, writer };
      this.set({ phase: 'waiting', fingerprint: this.fingerprint });
    } catch {
      this.set({ phase: 'failed', error: 'storage-write' });
    }
  }

  /** Looks for the old device's approval (every few seconds while waiting). */
  async poll(): Promise<void> {
    const c = this.ctx;
    if (this.s.phase !== 'waiting' || !c) return;
    const f = slotFiles(c.slot);
    try {
      const g = await c.writer.get(f.approval, { maxBytes: MAX_FILE });
      if (!g) return;
      const cert = verifyDeviceCert(openApproval(g.data, c.sharing.keyPair.secretKey, c.slot) as never, { expectedOwner: c.sharing.cert.owner });
      if (cert.device !== this.deviceKeys.id || cert.box !== devicePublicKeys(this.deviceKeys).box) return;
      await quietDelete(c.writer, f.approval);
      await quietDelete(c.writer, f.request);
      this.finish(cert, null, null);
    } catch {
      // not there yet, or not for me
    }
  }

  /** While waiting: certify this device with the 12 words instead (no need for the other device). */
  async certifyWithPhrase(phrase: string, opts: { primary?: boolean } = {}): Promise<void> {
    const c = this.ctx;
    if (this.s.phase !== 'waiting' || !c) return;
    let id;
    try {
      id = identityFromPhrase(normalizePhrase(phrase));
    } catch {
      return this.set({ phase: 'waiting', fingerprint: this.fingerprint, error: 'phrase-mismatch' });
    }
    try {
      if (id.owner !== c.sharing.cert.owner) return this.set({ phase: 'waiting', fingerprint: this.fingerprint, error: 'phrase-mismatch' });
      const cert = issueDeviceCert(id, devicePublicKeys(this.deviceKeys));
      // Tell the old device (it shows "added") and close the slot.
      await c.writer.put(slotFiles(c.slot).approval, sealApproval(cert, c.sharing.keyPair.secretKey, c.slot)).catch(() => {});
      await quietDelete(c.writer, slotFiles(c.slot).request);
      this.finish(cert, opts.primary ? toB64Url(encodePrimaryIdentity(id)) : null, sealSharingKey(c.sharing, id));
    } finally {
      id.master.secretKey.fill(0);
      id.vaultKey.fill(0);
    }
  }

  private finish(cert: DeviceCert, primaryIdentity: string | null, vaultCopy: Uint8Array | null): void {
    const c = this.ctx!;
    this.set({
      phase: 'approved',
      joined: { owner: c.sharing.cert.owner, deviceKeys: this.deviceKeys, deviceCert: cert, sharing: c.sharing, storage: c.storage, profileName: c.profileName, primaryIdentity, vaultCopy },
    });
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

export type RestoreError = 'phrase' | 'address' | 'not-found' | 'failed';

export class RestoreFailed extends Error {
  constructor(readonly code: RestoreError) {
    super(code);
  }
}

/**
 * The 12 words and the storage read address (the recovery kit): the phrase-protected copy of my
 * sharing key at `keys/<owner>.bin`, then the vault. This device gets its own keys and a device
 * certificate from the phrase.
 */
export async function restoreWithPhrase(phrase: string, location: string, d: NewDeviceDeps, opts: { primary?: boolean } = {}): Promise<Joined> {
  let id;
  try {
    id = identityFromPhrase(normalizePhrase(phrase));
  } catch {
    throw new RestoreFailed('phrase');
  }
  try {
    let reader: StorageAdapter;
    try {
      reader = d.readAdapter(location.trim());
    } catch {
      throw new RestoreFailed('address');
    }
    let g;
    try {
      g = await reader.get(keyPath(id.owner), { maxBytes: MAX_FILE });
    } catch {
      throw new RestoreFailed('address');
    }
    if (!g) throw new RestoreFailed('not-found');
    let sharing: SharingKey;
    try {
      sharing = openSharingKey(g.data, id, { expectedOwner: id.owner });
    } catch {
      throw new RestoreFailed('not-found');
    }
    const deviceKeys = generateDeviceKeys();
    const deviceCert = issueDeviceCert(id, devicePublicKeys(deviceKeys));
    const v = await readVaultValues(sharing.cert.location ? d.readAdapter(sharing.cert.location) : reader, sharing).catch(() => ({ storage: null, profileName: '' }));
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
