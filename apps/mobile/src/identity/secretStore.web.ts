/**
 * Web secrets (TEST BUILD ONLY, spec "The web version is for testing, not
 * for publishing"). A browser has no equivalent of the phone's secure vault:
 *
 * - Values go to their own IndexedDB database, each encrypted with AES-GCM
 *   under a random **non-extractable** WebCrypto key stored next to them.
 *   This keeps raw key bytes out of IndexedDB exports, disk images and
 *   scripts that copy storage, but any script running on the page can still
 *   ask the browser to decrypt: it is not protection against XSS, a malicious
 *   extension or someone using this browser profile.
 * - Without WebCrypto (plain http on a LAN address), values are stored
 *   unencrypted (`web-plain`).
 * - Without IndexedDB (private window, blocked site data), they live in
 *   memory only and the identity is lost when the page closes.
 *
 * The app labels all three as test-only. A passcode-derived key was not
 * chosen: it would add a prompt to every page load of a build that must not
 * hold real secrets anyway.
 */
import type { SecretKey, SecretStore } from './secretStore.types';

const DB_NAME = 'triangulair-secrets';
const STORE = 'secrets';
const WRAP_KEY = '__wrap-key';

function openIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) return resolve(null);
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    } catch (e) {
      reject(e);
    }
  });
}

function memoryStore(): SecretStore {
  const m = new Map<SecretKey, string>();
  return {
    kind: 'memory',
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}

async function wrapKey(db: IDBDatabase, subtle: SubtleCrypto): Promise<CryptoKey | null> {
  try {
    const existing = await request<unknown>(db, 'readonly', (s) => s.get(WRAP_KEY));
    if (existing && typeof existing === 'object' && 'type' in existing) return existing as CryptoKey;
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await request(db, 'readwrite', (s) => s.put(key, WRAP_KEY));
    return key;
  } catch {
    return null;
  }
}

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

export async function openSecretStore(): Promise<SecretStore> {
  const db = await openIdb();
  if (!db) return memoryStore();
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  const key = subtle ? await wrapKey(db, subtle) : null;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  if (!subtle || !key) {
    return {
      kind: 'web-plain',
      get: async (k) => {
        const v = await request<unknown>(db, 'readonly', (s) => s.get(k));
        return typeof v === 'string' ? v : null;
      },
      set: async (k, v) => void (await request(db, 'readwrite', (s) => s.put(v, k))),
      remove: async (k) => void (await request(db, 'readwrite', (s) => s.delete(k))),
    };
  }
  return {
    kind: 'web-wrapped',
    async get(k) {
      const v = await request<Sealed | string | undefined>(db, 'readonly', (s) => s.get(k));
      if (!v || typeof v === 'string') return null;
      // The key name is the associated data: a value cannot be moved to another entry.
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv: v.iv, additionalData: enc.encode(k) }, key, v.ct);
      return dec.decode(plain);
    },
    async set(k, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(k) }, key, enc.encode(value));
      await request(db, 'readwrite', (s) => s.put({ iv, ct } satisfies Sealed, k));
    },
    async remove(k) {
      await request(db, 'readwrite', (s) => s.delete(k));
    },
  };
}
