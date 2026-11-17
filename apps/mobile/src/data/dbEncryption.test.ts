import { describe, expect, it } from 'vitest';

import { DatabaseKeyError, keyPragma, newDbKey, openLocalDatabase, PLAIN_DB, SEALED_DB, sqlString, type CipherDb, type DbFiles, type KeyVault } from './dbEncryption';

/**
 * A fake SQLCipher: each file has a key (null = plaintext) and rows. A handle reads only once the right key is set
 * (`PRAGMA key`), like SQLCipher's first page read.
 */
interface FakeFile {
  key: string | null;
  rows: string[];
  userVersion: number;
}

function fakeFs(opts: { cipher?: boolean; failExport?: boolean } = {}) {
  const disk = new Map<string, FakeFile>();
  const log: string[] = [];
  const open = (name: string): CipherDb => {
    if (name !== ':memory:' && !disk.has(name)) disk.set(name, { key: null, rows: [], userVersion: 0 });
    let given: string | null = null;
    let attached: { name: string; key: string } | null = null;
    const file = () => disk.get(name)!;
    const readable = () => file().key === given;
    return {
      exec(sql) {
        log.push(`${name}: ${sql}`);
        const k = /^PRAGMA key = "x'([0-9a-f]{64})'"$/.exec(sql);
        if (k) {
          given = k[1]!;
          // A new empty file takes the key it is given.
          if (file().rows.length === 0 && file().key === null) file().key = given;
          return;
        }
        const a = /^ATTACH DATABASE '(.*)' AS sealed KEY "x'([0-9a-f]{64})'"$/.exec(sql);
        if (a) {
          const target = a[1]!.split('/').pop()!;
          disk.set(target, { key: a[2]!, rows: [], userVersion: 0 });
          attached = { name: target, key: a[2]! };
          return;
        }
        const uv = /^PRAGMA sealed\.user_version = (\d+)$/.exec(sql);
        if (uv && attached) {
          disk.get(attached.name)!.userVersion = Number(uv[1]);
          return;
        }
        if (sql === 'DETACH DATABASE sealed') attached = null;
      },
      get<T>(sql: string): T | null {
        log.push(`${name}: ${sql}`);
        if (sql === 'PRAGMA cipher_version') return (opts.cipher === false ? null : { cipher_version: '4.6.1 community' }) as T;
        if (!readable()) throw new Error('file is not a database');
        if (sql === 'PRAGMA user_version') return { user_version: file().userVersion } as T;
        if (sql === "SELECT sqlcipher_export('sealed')") {
          if (opts.failExport) throw new Error('disk full');
          disk.get(attached!.name)!.rows = [...file().rows];
          return {} as T;
        }
        return { n: file().rows.length } as T;
      },
      close() {},
    };
  };
  const files: DbFiles = {
    exists: (n) => disk.has(n),
    remove: (n) => void disk.delete(n),
    open,
    path: (n) => `/data/SQLite/${n}`,
  };
  return { files, disk, log };
}

function vault(initial: string | null = null): KeyVault & { value: string | null } {
  const v = {
    value: initial,
    get: async () => v.value,
    set: async (k: string) => {
      v.value = k;
    },
  };
  return v;
}

let seed = 1;
const random = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed++) & 0xff);

describe('local database encryption (gap #7)', () => {
  it('formats the raw key and quotes paths', () => {
    const key = newDbKey(random);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(keyPragma(key)).toBe(`PRAGMA key = "x'${key}'"`);
    expect(() => keyPragma('nope"; DROP TABLE x; --')).toThrow();
    expect(sqlString("/var/it's/db")).toBe("'/var/it''s/db'");
  });

  it('first launch: a new key in the vault, an encrypted database', async () => {
    const { files, disk } = fakeFs();
    const v = vault();
    const r = await openLocalDatabase(files, v, random);
    expect(r).toMatchObject({ name: SEALED_DB, encryption: 'sqlcipher', migrated: false, reset: false });
    expect(v.value).toMatch(/^[0-9a-f]{64}$/);
    expect(disk.get(SEALED_DB)!.key).toBe(v.value);
    expect(disk.has(PLAIN_DB)).toBe(false);
  });

  it('migrates an existing unencrypted database, then deletes the plaintext file', async () => {
    const { files, disk } = fakeFs();
    disk.set(PLAIN_DB, { key: null, rows: ['Café A', 'Café B'], userVersion: 3 });
    const v = vault();
    const r = await openLocalDatabase(files, v, random);
    expect(r.migrated).toBe(true);
    expect(disk.has(PLAIN_DB)).toBe(false);
    expect(disk.get(SEALED_DB)).toEqual({ key: v.value, rows: ['Café A', 'Café B'], userVersion: 3 });
    // Next launch: opens with the same key, nothing to move.
    const again = await openLocalDatabase(files, v, random);
    expect(again).toMatchObject({ migrated: false, reset: false });
    expect(again.db.get<{ n: number }>('SELECT count(*) AS n FROM sqlite_master')).toEqual({ n: 2 });
  });

  it('an interrupted move keeps the plaintext file and starts again', async () => {
    const broken = fakeFs({ failExport: true });
    broken.disk.set(PLAIN_DB, { key: null, rows: ['Café A'], userVersion: 2 });
    const v = vault();
    await expect(openLocalDatabase(broken.files, v, random)).rejects.toThrow('disk full');
    expect(broken.disk.get(PLAIN_DB)!.rows).toEqual(['Café A']);
    expect(broken.disk.get(SEALED_DB)!.rows).toEqual([]); // partial copy
    // Retried with a working export (same disk, same key).
    const { files, disk } = fakeFs();
    for (const [k, f] of broken.disk) disk.set(k, f);
    const r = await openLocalDatabase(files, v, random);
    expect(r.migrated).toBe(true);
    expect(disk.get(SEALED_DB)!.rows).toEqual(['Café A']);
    expect(disk.has(PLAIN_DB)).toBe(false);
  });

  it('deleting the key makes the database unreadable: it is replaced by an empty one', async () => {
    const { files, disk } = fakeFs();
    const v = vault();
    await openLocalDatabase(files, v, random);
    disk.get(SEALED_DB)!.rows = ['secret place'];
    const oldKey = v.value;
    v.value = null; // remote wipe, "Delete all my content", or a system restore without the vault
    const r = await openLocalDatabase(files, v, random);
    expect(r.reset).toBe(true);
    expect(v.value).not.toBe(oldKey);
    expect(disk.get(SEALED_DB)!.rows).toEqual([]);
  });

  it('a wrong key is an error, never a reset; a locked vault leaves the file alone', async () => {
    const { files, disk } = fakeFs();
    disk.set(SEALED_DB, { key: 'a'.repeat(64), rows: ['x'], userVersion: 1 });
    await expect(openLocalDatabase(files, vault('b'.repeat(64)), random)).rejects.toBeInstanceOf(DatabaseKeyError);
    const locked: KeyVault = { get: async () => Promise.reject(new Error('device locked')), set: async () => {} };
    await expect(openLocalDatabase(files, locked, random)).rejects.toThrow('device locked');
    expect(disk.get(SEALED_DB)!.rows).toEqual(['x']);
  });

  it('a build without SQLCipher keeps the plaintext file, labelled', async () => {
    const { files, disk } = fakeFs({ cipher: false });
    const v = vault();
    const r = await openLocalDatabase(files, v, random);
    expect(r).toMatchObject({ name: PLAIN_DB, encryption: 'unavailable' });
    expect(v.value).toBeNull();
    expect(disk.has(SEALED_DB)).toBe(false);
  });
});
