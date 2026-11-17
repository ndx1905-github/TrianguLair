/**
 * The phrase-protected copy of my sharing key (TLSK mode 2) that "restore with the 12 words" reads
 * at `keys/<owner>.bin` (spec "Recovery kit"; devices review F-05).
 *
 * Kept in the secret store (`recovery-copy`) with the certificate it was made for, so that a
 * device never uploads a copy of an older key (another device may have rotated since). When the
 * stored copy is missing or older, a device that can open the master key without asking (primary
 * device, or the new phrase still waiting for the kit) seals a fresh one; otherwise only the 12
 * words can, and the Devices screen asks for them once (`IdentityApi.writeRecoveryCopy`).
 */
import { decodePrimaryIdentity, fromB64Url, identityFromPhrase, sealSharingKey, toB64Url, type Identity, type SharingCert, type SharingKey } from '@triangulair/crypto';

export interface StoredRecoveryCopy {
  /** b64url TLSK mode 2. */
  copy: string;
  rotation: number;
  /** The sharing public key it holds (`x25519:…`). */
  key: string;
}

/** What goes into the secret store. */
export function encodeRecoveryCopy(copy: Uint8Array, cert: SharingCert): string {
  return JSON.stringify({ v: 1, copy: toB64Url(copy), rotation: cert.rotation, key: cert.key } satisfies StoredRecoveryCopy & { v: 1 });
}

/** Null when absent, malformed, or of the earlier format (a bare copy: its key is unknown). */
export function parseRecoveryCopy(s: string | null): StoredRecoveryCopy | null {
  if (!s || !s.startsWith('{')) return null;
  try {
    const o = JSON.parse(s) as Partial<StoredRecoveryCopy> & { v?: unknown };
    if (o.v !== 1 || typeof o.copy !== 'string' || !Number.isSafeInteger(o.rotation) || typeof o.key !== 'string') return null;
    fromB64Url(o.copy, 'copy');
    return { copy: o.copy, rotation: o.rotation!, key: o.key };
  } catch {
    return null;
  }
}

/** Seals a copy of `sharing` with the phrase-derived key of `identity` (it must be the same owner). */
export function sealRecoveryCopy(sharing: SharingKey, identity: Identity): { copy: string; store: string } {
  const bytes = sealSharingKey(sharing, identity);
  return { copy: toB64Url(bytes), store: encodeRecoveryCopy(bytes, sharing.cert) };
}

/**
 * The copy to keep at `keys/<owner>.bin` for my current key `sharing`: the stored one when it was
 * made for this very certificate; else a new one from the master key this device holds (primary
 * device, or the pending phrase), with `store` to save; else null (only the 12 words can make it).
 */
export function recoveryCopyFor(
  sharing: SharingKey,
  held: { stored: string | null; primaryIdentity: string | null; pendingPhrase?: string | null },
): { copy: string; store?: string } | null {
  const s = parseRecoveryCopy(held.stored);
  if (s && s.rotation === sharing.cert.rotation && s.key === sharing.cert.key) return { copy: s.copy };
  let id: Identity | null = null;
  try {
    if (held.primaryIdentity) id = decodePrimaryIdentity(fromB64Url(held.primaryIdentity, 'primaryIdentity'));
    else if (held.pendingPhrase) id = identityFromPhrase(held.pendingPhrase);
    if (!id || id.owner !== sharing.cert.owner) return null;
    return sealRecoveryCopy(sharing, id);
  } catch {
    return null;
  } finally {
    id?.master.secretKey.fill(0);
    id?.vaultKey.fill(0);
  }
}
