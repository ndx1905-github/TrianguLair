/**
 * What the contacts screens keep on this device only:
 *
 * - names I gave people (the formats carry no name: an invitation link holds a key, an address
 *   and a secret, a return link a key and certificates), and the name I gave each invitation;
 * - "I compared the safety code" marks: a personal declaration, never sent to anyone (spec
 *   "Optional verification"). Removed when the person's identity moves;
 * - which invitation was made face to face (its answer is then verified automatically);
 * - the last sharing-key rotation seen per contact and the key-change notices not dismissed yet.
 *
 * Plain device settings (`LocalKV`), one versioned JSON value parsed defensively. The invitations
 * I received hold a secret (the invitation key that reads the inviter's places until my answer is
 * accepted): they go to the secret store instead (`SecretKV`, entry `invitations-received`).
 */
import type { KeyNotice, KeySnapshot } from './model';

export interface LocalKV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface SecretKV {
  get(key: 'invitations-received'): Promise<string | null>;
  set(key: 'invitations-received', value: string): Promise<void>;
}

export interface InvitationLabel {
  name: string;
  faceToFace?: boolean;
  /** Owner of the answer received face to face (verified automatically on acceptance). */
  faceToFaceOwner?: string;
}

export interface LocalState {
  v: 1;
  names: Record<string, string>;
  verified: Record<string, true>;
  labels: Record<string, InvitationLabel>;
  keys: KeySnapshot;
  notices: KeyNotice[];
}

export interface ReceivedInvitation {
  /** The invitation link (holds the secret). */
  link: string;
  owner: string;
  expires: number;
}

const KEY = 'contacts-local';
const EMPTY: LocalState = { v: 1, names: {}, verified: {}, labels: {}, keys: { rotations: {} }, notices: [] };
const MAX_NAME = 80;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function strings(x: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(x)) for (const [k, v] of Object.entries(x)) if (typeof v === 'string') out[k] = v.slice(0, MAX_NAME);
  return out;
}

export function parseLocal(s: string | null): LocalState {
  if (!s) return structuredCloneish(EMPTY);
  try {
    const o = JSON.parse(s) as unknown;
    if (!isObj(o) || o['v'] !== 1) return structuredCloneish(EMPTY);
    const verified: Record<string, true> = {};
    if (isObj(o['verified'])) for (const [k, v] of Object.entries(o['verified'])) if (v === true) verified[k] = true;
    const labels: Record<string, InvitationLabel> = {};
    if (isObj(o['labels'])) {
      for (const [k, v] of Object.entries(o['labels'])) {
        if (!isObj(v) || typeof v['name'] !== 'string') continue;
        labels[k] = { name: v['name'].slice(0, MAX_NAME), ...(v['faceToFace'] === true && { faceToFace: true }), ...(typeof v['faceToFaceOwner'] === 'string' && { faceToFaceOwner: v['faceToFaceOwner'] }) };
      }
    }
    const rotations: Record<string, number> = {};
    const keys = o['keys'];
    if (isObj(keys) && isObj(keys['rotations'])) for (const [k, v] of Object.entries(keys['rotations'])) if (Number.isSafeInteger(v) && (v as number) >= 0) rotations[k] = v as number;
    const notices: KeyNotice[] = Array.isArray(o['notices'])
      ? (o['notices'] as unknown[]).filter((n): n is KeyNotice => isObj(n) && typeof n['owner'] === 'string' && (n['kind'] === 'key-changed' || n['kind'] === 'identity-moved') && typeof n['at'] === 'number').slice(-50)
      : [];
    return { v: 1, names: strings(o['names']), verified, labels, keys: { rotations }, notices };
  } catch {
    return structuredCloneish(EMPTY);
  }
}

function structuredCloneish(s: LocalState): LocalState {
  return JSON.parse(JSON.stringify(s)) as LocalState;
}

export class LocalContacts {
  private s: LocalState;
  constructor(private readonly kv: LocalKV) {
    this.s = parseLocal(kv.get(KEY));
  }
  get state(): Readonly<LocalState> {
    return this.s;
  }
  update(fn: (s: LocalState) => void): void {
    const next = structuredCloneish(this.s);
    fn(next);
    this.s = next;
    this.kv.set(KEY, JSON.stringify(next));
  }
}

export function parseReceived(s: string | null, now: number): ReceivedInvitation[] {
  if (!s) return [];
  try {
    const a = JSON.parse(s) as unknown;
    if (!Array.isArray(a)) return [];
    return a.filter((r): r is ReceivedInvitation => isObj(r) && typeof r['link'] === 'string' && typeof r['owner'] === 'string' && typeof r['expires'] === 'number' && (r['expires'] as number) > now);
  } catch {
    return [];
  }
}

/** A name typed by the user: trimmed, single line, bounded. */
export function cleanName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/** Memory-only settings (tests). */
export function memoryKV(): LocalKV {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

/** Memory-only secrets (tests). */
export function memorySecrets(): SecretKV {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}
