import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  checkKeys,
  checkVersion,
  formatKey,
  int,
  isoDate,
  parseJsonObject,
  parseKey,
  str,
  utf8,
  type JsonObject,
} from './encoding';
import { FormatError, RollbackError, SignatureError, TLCryptoError } from './errors';
import { signBody, verifyBody } from './sign';
import { S } from './sodium';

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** A person's long-term identity. `master` is Ed25519 and ONLY signs. */
export interface Identity {
  /** 32-byte root secret derived from the recovery phrase; every other key derives from it. */
  rootSeed: Uint8Array;
  /** Ed25519 master key pair (secretKey is 64 bytes, libsodium format). */
  master: KeyPair;
  /** "ed25519:<b64url master public key>" — the owner id used in signed documents. */
  owner: string;
}

const ROOT_CONTEXT = 'TrianguLair/root/v1';
const KDF_MASTER = 'TLmaster'; // crypto_kdf contexts are exactly 8 bytes
const KDF_SHARE = 'TLshare_';

function normalizePhrase(phrase: string): string {
  return phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

/** New random 12-word BIP39 (English) recovery phrase = 128 bits of entropy. */
export function generateRecoveryPhrase(): string {
  return entropyToMnemonic(S().randombytes_buf(16), wordlist);
}

/** Deterministic: same phrase => same identity. Throws code INVALID_PHRASE on bad words/checksum. */
export function identityFromPhrase(phrase: string): Identity {
  const norm = normalizePhrase(phrase);
  if (norm.split(' ').length !== 12 || !validateMnemonic(norm, wordlist)) {
    throw new TLCryptoError('INVALID_PHRASE', 'recovery phrase must be 12 valid BIP39 English words with a valid checksum');
  }
  const entropy = mnemonicToEntropy(norm, wordlist);
  // root = BLAKE2b-256(key = 16-byte entropy, msg = context)
  const rootSeed = S().crypto_generichash(32, utf8(ROOT_CONTEXT), entropy);
  return identityFromRootSeed(rootSeed);
}

export function identityFromRootSeed(rootSeed: Uint8Array): Identity {
  if (rootSeed.length !== 32) throw new FormatError('root seed must be 32 bytes');
  const s = S();
  const masterSeed = s.crypto_kdf_derive_from_key(32, 1, KDF_MASTER, rootSeed);
  const kp = s.crypto_sign_seed_keypair(masterSeed);
  const master = { publicKey: kp.publicKey, secretKey: kp.privateKey };
  return { rootSeed: rootSeed.slice(), master, owner: formatKey('ed25519', master.publicKey) };
}

/**
 * X25519 sharing key for a given rotation counter, derived from the root seed so the
 * recovery phrase restores every past and present sharing key.
 */
export function deriveSharingKeyPair(identity: Identity, rotation: number): KeyPair {
  if (!Number.isSafeInteger(rotation) || rotation < 0) throw new FormatError('rotation must be a non-negative integer');
  const s = S();
  const seed = s.crypto_kdf_derive_from_key(32, rotation, KDF_SHARE, identity.rootSeed);
  const kp = s.crypto_box_seed_keypair(seed);
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** Random X25519 key pair (used for groups, invitations, dummy wraps, tests). */
export function generateX25519KeyPair(): KeyPair {
  const kp = S().crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// ---------------------------------------------------------------------------
// Sharing-key certificate
// ---------------------------------------------------------------------------

export const SHARING_CERT_VERSION = 1;

export interface SharingCert {
  type: 'sharing-cert';
  version: number;
  owner: string; // ed25519:<b64url>
  key: string; // x25519:<b64url>
  rotation: number;
  issued: string; // ISO-8601 UTC
  signature: string;
}

export interface VerifiedSharingCert {
  cert: SharingCert;
  ownerPublicKey: Uint8Array;
  sharingPublicKey: Uint8Array;
}

/** Master key signs a certificate binding the current sharing public key. Returns canonical JSON. */
export function issueSharingCert(
  identity: Identity,
  sharingPublicKey: Uint8Array,
  opts: { rotation: number; now?: Date },
): SharingCert {
  if (!Number.isSafeInteger(opts.rotation) || opts.rotation < 0) throw new FormatError('rotation must be a non-negative integer');
  return signBody(
    'sharing-cert',
    {
      type: 'sharing-cert' as const,
      version: SHARING_CERT_VERSION,
      owner: identity.owner,
      key: formatKey('x25519', sharingPublicKey),
      rotation: opts.rotation,
      issued: (opts.now ?? new Date()).toISOString(),
    },
    identity.master.secretKey,
  );
}

export function ownerString(owner: Uint8Array | string): string {
  return typeof owner === 'string' ? (parseKey('ed25519', owner, 'owner'), owner) : formatKey('ed25519', owner);
}

/**
 * Verifies structure + signature. Optional: `expectedOwner` (else OWNER_MISMATCH) and
 * `lastSeen` (a previously accepted cert of the same owner; lower rotation => RollbackError).
 */
export function verifySharingCert(
  input: string | SharingCert | JsonObject,
  opts: { expectedOwner?: Uint8Array | string; lastSeen?: SharingCert } = {},
): VerifiedSharingCert {
  const W = 'sharing-cert';
  const doc = parseJsonObject(input as string | JsonObject, W);
  checkVersion(doc, W, SHARING_CERT_VERSION);
  checkKeys(doc, W, ['type', 'version', 'owner', 'key', 'rotation', 'issued', 'signature']);
  if (doc['type'] !== 'sharing-cert') throw new FormatError(`${W}: wrong type`);
  const ownerPublicKey = parseKey('ed25519', doc['owner'], `${W}.owner`);
  const sharingPublicKey = parseKey('x25519', doc['key'], `${W}.key`);
  const rotation = int(doc, 'rotation', W);
  isoDate(doc, 'issued', W);
  verifyBody('sharing-cert', doc, ownerPublicKey);
  const owner = str(doc, 'owner', W);
  if (opts.expectedOwner !== undefined && ownerString(opts.expectedOwner) !== owner) {
    throw new SignatureError(`${W}: signed by an unexpected owner`, 'OWNER_MISMATCH');
  }
  if (opts.lastSeen) {
    if (opts.lastSeen.owner !== owner) throw new SignatureError(`${W}: lastSeen belongs to another owner`, 'OWNER_MISMATCH');
    if (rotation < opts.lastSeen.rotation) throw new RollbackError(`${W}: rotation ${rotation} is older than last seen ${opts.lastSeen.rotation}`);
    if (rotation === opts.lastSeen.rotation && doc['key'] !== opts.lastSeen.key) {
      throw new RollbackError(`${W}: two different keys certified for rotation ${rotation}`);
    }
  }
  return { cert: doc as unknown as SharingCert, ownerPublicKey, sharingPublicKey };
}
