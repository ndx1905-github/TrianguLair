import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  bytesEqual,
  checkByteVersion,
  checkStructure,
  concat,
  deepFreeze,
  formatKey,
  isoDate,
  nowMs,
  ownerString,
  parseJsonObject,
  parseKey,
  Reader,
  str,
  utf8,
  type JsonObject,
} from './encoding';
import { FormatError, SignatureError, TLCryptoError } from './errors';
import { signBody, signBodyField, verifyBody } from './sign';
import { S } from './sodium';

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * What the recovery phrase gives: the master key (Ed25519, ONLY signs certificates) and the
 * recovery-vault key. It exists in memory while the user typed the 12 words, and is persisted
 * only on the optional primary device (encodePrimaryIdentity). Ordinary devices never hold it.
 */
export interface Identity {
  /** "ed25519:<b64url master public key>": the owner id friends know. */
  owner: string;
  /** Ed25519 master key pair (secretKey is 64 bytes, libsodium format). */
  master: KeyPair;
  /**
   * 32-byte symmetric key for the phrase-protected copy of the sharing key and vault data key (TLSK
   * mode 2). Derived from the phrase only. Not the vault DATA key, which is random (vault.ts).
   */
  vaultKey: Uint8Array;
}

const ROOT_CONTEXT = 'TrianguLair/root/v1';
const KDF_MASTER = 'TLmaster'; // crypto_kdf contexts are exactly 8 bytes
const KDF_VAULT = 'TLvault_';

function normalizePhrase(phrase: string): string {
  return phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

/** New random 12-word BIP39 (English) recovery phrase = 128 bits of entropy. */
export function generateRecoveryPhrase(): string {
  const entropy = S().randombytes_buf(16);
  try {
    return entropyToMnemonic(entropy, wordlist);
  } finally {
    S().memzero(entropy);
  }
}

/** Deterministic: same phrase => same identity. Throws code INVALID_PHRASE on bad words/checksum. */
export function identityFromPhrase(phrase: string): Identity {
  const norm = normalizePhrase(phrase);
  if (norm.split(' ').length !== 12 || !validateMnemonic(norm, wordlist)) {
    throw new TLCryptoError('INVALID_PHRASE', 'recovery phrase must be 12 valid BIP39 English words with a valid checksum');
  }
  const s = S();
  const entropy = mnemonicToEntropy(norm, wordlist);
  // root = BLAKE2b-256(key = 16-byte entropy, msg = context)
  const root = s.crypto_generichash(32, utf8(ROOT_CONTEXT), entropy);
  const masterSeed = s.crypto_kdf_derive_from_key(32, 1, KDF_MASTER, root);
  try {
    const vaultKey = s.crypto_kdf_derive_from_key(32, 2, KDF_VAULT, root);
    return fromSeeds(masterSeed, vaultKey);
  } finally {
    s.memzero(entropy);
    s.memzero(root);
    s.memzero(masterSeed);
  }
}

function fromSeeds(masterSeed: Uint8Array, vaultKey: Uint8Array): Identity {
  const kp = S().crypto_sign_seed_keypair(masterSeed);
  const master = { publicKey: kp.publicKey, secretKey: kp.privateKey };
  return { owner: formatKey('ed25519', master.publicKey), master, vaultKey };
}

// ---------------------------------------------------------------------------
// Primary device: the optional single device that keeps the master key.
//   "TLPI" | version u8 (=1) | master seed 32B | vault key 32B     (69 bytes)
// Store it in the system's secure vault (Keychain/Keystore), never on the storage.
// ---------------------------------------------------------------------------

const PRIMARY_MAGIC = utf8('TLPI');
export const PRIMARY_IDENTITY_VERSION = 1;

export function encodePrimaryIdentity(identity: Identity): Uint8Array {
  return concat(PRIMARY_MAGIC, Uint8Array.of(PRIMARY_IDENTITY_VERSION), identity.master.secretKey.subarray(0, 32), identity.vaultKey);
}

export function decodePrimaryIdentity(bytes: Uint8Array): Identity {
  const W = 'primary-identity';
  const r = new Reader(bytes, W);
  if (!bytesEqual(r.bytes(4), PRIMARY_MAGIC)) throw new FormatError(`${W}: bad magic`);
  checkByteVersion(r.u8(), W, PRIMARY_IDENTITY_VERSION);
  const seed = r.bytes(32).slice();
  const vaultKey = r.bytes(32).slice();
  r.end();
  try {
    return fromSeeds(seed, vaultKey);
  } finally {
    S().memzero(seed);
  }
}

/** Random X25519 key pair: sharing keys (never derived from the phrase), groups, invitations. */
export function generateX25519KeyPair(): KeyPair {
  const kp = S().crypto_box_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

// ---------------------------------------------------------------------------
// Device keys: generated on each device, never copied.
// ---------------------------------------------------------------------------

export interface DeviceKeys {
  /** "ed25519:<b64url>" = sign.publicKey. Listed in revoked_devices when the device is declared lost. */
  id: string;
  /** Ed25519: signs the indexes this device publishes. */
  sign: KeyPair;
  /** X25519: receives the sharing key, sealed to it. */
  box: KeyPair;
}

export function generateDeviceKeys(): DeviceKeys {
  const s = S();
  const kp = s.crypto_sign_keypair();
  const sign = { publicKey: kp.publicKey, secretKey: kp.privateKey };
  return { id: formatKey('ed25519', sign.publicKey), sign, box: generateX25519KeyPair() };
}

// ---------------------------------------------------------------------------
// Identity move ("Declare the primary device lost"): the old master signs that the identity now
// lives under a new master key; the new master countersigns (so nobody can move "to" a key they
// do not hold). Published as the `move` field of the new identity's signed index.
// ---------------------------------------------------------------------------

export const IDENTITY_MOVE_VERSION = 1;

export interface IdentityMove {
  type: 'identity-move';
  version: number;
  from: string;
  to: string;
  issued: string;
  to_signature: string;
  signature: string;
}

export function issueIdentityMove(from: Identity, to: Identity, opts: { now?: Date } = {}): IdentityMove {
  if (from.owner === to.owner) throw new FormatError('identity-move: from and to are the same identity');
  const body: JsonObject = {
    type: 'identity-move',
    version: IDENTITY_MOVE_VERSION,
    from: from.owner,
    to: to.owner,
    issued: new Date(nowMs(opts.now, 'identity-move')).toISOString(),
  };
  body['to_signature'] = signBodyField('identity-move-to', body, 'to_signature', to.master.secretKey);
  return verifyIdentityMove(signBody('identity-move', body, from.master.secretKey));
}

export function verifyIdentityMove(input: string | IdentityMove | JsonObject, opts: { expectedFrom?: Uint8Array | string } = {}): IdentityMove {
  const W = 'identity-move';
  const doc = parseJsonObject(input as string | JsonObject, W);
  checkStructure(doc, W, IDENTITY_MOVE_VERSION, ['type', 'version', 'from', 'to', 'issued', 'to_signature', 'signature']);
  if (doc['type'] !== W) throw new FormatError(`${W}: wrong type`);
  const fromPk = parseKey('ed25519', doc['from'], `${W}.from`);
  const toPk = parseKey('ed25519', doc['to'], `${W}.to`);
  if (bytesEqual(fromPk, toPk)) throw new FormatError(`${W}: from and to are the same identity`);
  isoDate(doc, 'issued', W);
  verifyBody('identity-move-to', doc, toPk, 'to_signature');
  verifyBody('identity-move', doc, fromPk);
  if (opts.expectedFrom !== undefined && ownerString(opts.expectedFrom) !== str(doc, 'from', W)) {
    throw new SignatureError(`${W}: moves another identity`, 'OWNER_MISMATCH');
  }
  return deepFreeze({ ...doc } as unknown as IdentityMove);
}

/** Throws SignatureError(REVOKED) if `owner` is in `retiredOwners` (identities that moved away). */
export function checkNotRetired(owner: string, retiredOwners: Iterable<string> | undefined, what: string): void {
  if (!retiredOwners) return;
  for (const r of retiredOwners) {
    if (r === owner) throw new SignatureError(`${what}: signed by a master key whose identity moved away`, 'REVOKED');
  }
}
