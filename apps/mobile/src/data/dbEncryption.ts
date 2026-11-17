/**
 * Local database encryption (gap #7, spec "Loss and theft", protections on the device: "The local database
 * (including the friends' cache) is encrypted with a key stored in that same vault: deleting this key is enough to
 * make the whole database instantly unreadable").
 *
 * Native builds use expo-sqlite with SQLCipher (`useSQLCipher` in app.json). The key is 32 random bytes kept in the
 * secret store (`db-key`: Keychain / Keystore, this device only, readable while unlocked) and given to SQLCipher as a
 * raw key (`PRAGMA key = "x'…'"`, no passphrase derivation). The encrypted file has its own name
 * (`triangulair-sealed.db`), so an older unencrypted `triangulair.db` is recognised and moved over once with
 * `sqlcipher_export` (the plaintext file is deleted only after the encrypted copy opened with the key; an interrupted
 * move starts again from the plaintext file). The remote wipe and "Delete all my content" erase `db-key` first.
 *
 * Pure orchestration over small interfaces, so the steps are unit-tested without SQLCipher; the native glue is
 * `openStore.native.ts`. The web test build (sql.js) is not encrypted, and says so in the settings.
 */

export const PLAIN_DB = 'triangulair.db';
export const SEALED_DB = 'triangulair-sealed.db';

/** A database handle as the steps need it (expo-sqlite's `SQLiteDatabase` fits). */
export interface CipherDb {
  exec(sql: string): void;
  get<T>(sql: string): T | null;
  close(): void;
}

export interface DbFiles {
  exists(name: string): boolean;
  remove(name: string): void;
  open(name: string): CipherDb;
  /** Absolute path of a database file (for ATTACH). */
  path(name: string): string;
}

export interface KeyVault {
  /** Throws when the vault cannot be read (device locked): the database is then left alone. */
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
}

export type DbEncryption = 'sqlcipher' | 'unavailable';

export interface OpenedDb {
  db: CipherDb;
  name: string;
  encryption: DbEncryption;
  /** An unencrypted database was moved into the encrypted one. */
  migrated: boolean;
  /** An encrypted database whose key was gone was deleted (it could not be read anyway). */
  reset: boolean;
}

/** The key does not open the encrypted database (it never should: the key and the file live on this device). */
export class DatabaseKeyError extends Error {
  constructor() {
    super('the local database does not open with its key');
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/;

export function newDbKey(random: (n: number) => Uint8Array): string {
  const b = random(32);
  if (b.length !== 32) throw new Error('db key: 32 random bytes expected');
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** SQLCipher raw key literal: `x'<64 hex>'` inside double quotes. */
function rawKey(key: string): string {
  if (!HEX_KEY.test(key)) throw new Error('db key: 64 lowercase hex digits expected');
  return `"x'${key}'"`;
}

export function keyPragma(key: string): string {
  return `PRAGMA key = ${rawKey(key)}`;
}

export function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Is this build's SQLite SQLCipher? (`PRAGMA cipher_version` answers a row only there.) */
export function hasSqlCipher(files: DbFiles): boolean {
  const probe = files.open(':memory:');
  try {
    const v = probe.get<{ cipher_version?: string | null }>('PRAGMA cipher_version');
    return !!v?.cipher_version;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

/** Copies the plaintext database into a new encrypted file (schema, rows and `user_version`). */
export function exportToSealed(files: DbFiles, key: string): void {
  const src = files.open(PLAIN_DB);
  try {
    const uv = Number(src.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0) | 0;
    src.exec(`ATTACH DATABASE ${sqlString(files.path(SEALED_DB))} AS sealed KEY ${rawKey(key)}`);
    try {
      src.get(`SELECT sqlcipher_export('sealed')`);
      src.exec(`PRAGMA sealed.user_version = ${uv}`);
    } finally {
      src.exec('DETACH DATABASE sealed');
    }
  } finally {
    src.close();
  }
}

function openWithKey(files: DbFiles, key: string): CipherDb {
  const db = files.open(SEALED_DB);
  try {
    db.exec(keyPragma(key));
    // The first read decrypts page 1: a wrong key fails here ("file is not a database").
    db.get('SELECT count(*) AS n FROM sqlite_master');
    return db;
  } catch {
    db.close();
    throw new DatabaseKeyError();
  }
}

/** Opens (creating, migrating or resetting as needed) the local database. */
export async function openLocalDatabase(files: DbFiles, vault: KeyVault, random: (n: number) => Uint8Array): Promise<OpenedDb> {
  if (!hasSqlCipher(files)) {
    // A build without the config plugin flag: the old, unencrypted file (labelled in the settings).
    return { db: files.open(PLAIN_DB), name: PLAIN_DB, encryption: 'unavailable', migrated: false, reset: false };
  }
  const plain = files.exists(PLAIN_DB);
  let key = await vault.get();
  let reset = false;
  if (!key) {
    // Without its key an encrypted file is unreadable: it goes (the places come back from my storage with the kit).
    if (!plain && files.exists(SEALED_DB)) {
      files.remove(SEALED_DB);
      reset = true;
    }
    key = newDbKey(random);
    await vault.set(key);
    if ((await vault.get()) !== key) throw new Error('db key: the secret store did not keep the key');
  }
  if (plain) {
    // A partial copy from an interrupted move is started again.
    if (files.exists(SEALED_DB)) files.remove(SEALED_DB);
    exportToSealed(files, key);
  }
  const db = openWithKey(files, key);
  if (plain) files.remove(PLAIN_DB);
  return { db, name: SEALED_DB, encryption: 'sqlcipher', migrated: plain, reset };
}
