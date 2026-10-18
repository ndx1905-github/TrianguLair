import {
  canonicalize,
  checkInvitationIndex,
  createInvitation,
  parseInvitationLink,
  serialize,
  verifyIndex,
  type OwnerInvitation,
  type ReceivedInvitation,
  generateDeviceKeys,
  generateRecoveryPhrase,
  generateVaultDataKey,
  toB64Url,
  generateX25519KeyPair,
  identityFromPhrase,
  issueDeviceCert,
  issueSharingCert,
  devicePublicKeys,
  openPack,
  packEntry,
  sealPack,
  type SealOptions,
  signIndex,
  type DeviceCert,
  type DeviceKeys,
  type DeviceSigner,
  type Identity,
  type IndexContent,
  type KeyPair,
  type OpenedPack,
  type SharingCert,
  type SignedIndex,
} from '../src/index';

/** A user with an identity (phrase), one device, and a random sharing key at rotation 0. */
export interface Person {
  phrase: string;
  id: Identity;
  device: DeviceKeys;
  deviceCert: DeviceCert;
  signer: DeviceSigner;
  sharing: KeyPair;
  cert: SharingCert;
  /** Master-certified read address (in `cert`). */
  location: string;
  vaultDataKey: Uint8Array;
}

/** A distinct public https read address. */
export function newLocation(): string {
  return `https://storage.example.org/s/${toB64Url(generateVaultDataKey().subarray(0, 9))}/`;
}

/** `location`: the read address certified in the sharing cert (default: a fresh one). */
export function person(location: string = newLocation()): Person {
  const phrase = generateRecoveryPhrase();
  const id = identityFromPhrase(phrase);
  const device = generateDeviceKeys();
  const deviceCert = issueDeviceCert(id, devicePublicKeys(device));
  const sharing = generateX25519KeyPair();
  return {
    phrase,
    id,
    device,
    deviceCert,
    signer: { keys: device, cert: deviceCert },
    sharing,
    cert: issueSharingCert(id, sharing.publicKey, { rotation: 0, location }),
    location,
    vaultDataKey: generateVaultDataKey(),
  };
}

const seqs = new WeakMap<Person, number>();

/** Publishes (signs) a new index for `p` listing `packs`, with the next seq. */
export function publish(p: Person, packs: Uint8Array[], extra: Partial<IndexContent> = {}, signer?: DeviceSigner, cert?: SharingCert): SignedIndex {
  const seq = (seqs.get(p) ?? 0) + 1;
  seqs.set(p, seq);
  return signIndex(signer ?? p.signer, { seq, sharingCert: cert ?? p.cert, packs: packs.map((b) => packEntry(b)), ...extra });
}

/**
 * Owner side of an invitation: creates it with `signer` (default: p's device) and publishes the
 * index that lists it (with every invitation in `alsoListed`).
 */
export function invite(
  p: Person,
  opts: { now?: Date; ttlMs?: number; signer?: DeviceSigner; cert?: SharingCert; packs?: Uint8Array[] } = {},
): { invitation: OwnerInvitation; fragment: string; index: SignedIndex } {
  const now = opts.now ?? new Date();
  const created = createInvitation(opts.signer ?? p.signer, opts.cert ?? p.cert, opts.ttlMs !== undefined ? { now, ttlMs: opts.ttlMs } : { now });
  const index = publish(p, opts.packs ?? [], { invitations: [created.invitation], now }, opts.signer, opts.cert);
  return { ...created, index };
}

/** Invitee side: parses the link, reads `index` at the link's address and confirms the invitation. */
export function accept(fragment: string, index: SignedIndex, now: Date = new Date()): ReceivedInvitation {
  const received = parseInvitationLink(fragment, { now });
  const idx = verifyIndex(serialize(index), { expectedOwner: received.owner, location: received.location, now });
  checkInvitationIndex(received, idx, { now });
  return received;
}

let notaryPerson: Person | undefined;

/** Throwaway publisher used by trust() / open() / seal(). */
export function notary(): Person {
  notaryPerson ??= person();
  return notaryPerson;
}

/** A verified index (by the throwaway publisher) listing the given packs: for tests about pack internals. */
export function trust(...packs: Uint8Array[]): SignedIndex {
  return publish(notary(), packs);
}

/** sealPack bound to the throwaway publisher (open with open() or trust()). */
export function seal(payload: Uint8Array, recipients: Uint8Array[], opts?: SealOptions): Uint8Array {
  return sealPack(notary().id.owner, payload, recipients, opts);
}

/** openPack through a throwaway verified index. */
export function open(pack: Uint8Array, keys: KeyPair[]): OpenedPack {
  return openPack(pack, trust(pack), keys);
}

export const te = new TextEncoder();
export const td = new TextDecoder();

/** True if `needle` occurs anywhere in `hay`. */
export function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export function headerOf(pack: Uint8Array): Record<string, unknown> {
  const n = new DataView(pack.buffer, pack.byteOffset).getUint32(5, false);
  return JSON.parse(td.decode(pack.subarray(9, 9 + n)));
}

/** Rebuild a pack with a mutated header (keeps ciphertext). Canonical unless `raw` is given. */
export function mutateHeader(pack: Uint8Array, f: (h: Record<string, unknown>) => void, raw?: (h: Record<string, unknown>) => string): Uint8Array {
  const n = new DataView(pack.buffer, pack.byteOffset).getUint32(5, false);
  const h = headerOf(pack);
  f(h);
  const hb = te.encode(raw ? raw(h) : canonicalize(h));
  const out = new Uint8Array(9 + hb.length + pack.length - 9 - n);
  out.set(pack.subarray(0, 5));
  new DataView(out.buffer).setUint32(5, hb.length, false);
  out.set(hb, 9);
  out.set(pack.subarray(9 + n), 9 + hb.length);
  return out;
}
