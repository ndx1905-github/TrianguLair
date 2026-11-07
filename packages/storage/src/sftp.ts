/**
 * SFTP adapter — NODE ONLY (desktop / CLI / tests).
 *
 * Built on `ssh2`, which needs Node's `net`/`crypto` and therefore cannot run
 * in React Native / Expo or the browser. On mobile SFTP would need a native
 * module (or be desktop-only): see README "Open questions".
 *
 * ETags are emulated (SFTP has none):
 *  - `etagMode: 'hash'` (default): `"sha256-<hex>"` of the content. Exact,
 *    but `head` / `list` must download each file.
 *  - `etagMode: 'mtime-size'`: `"<mtime>-<size>"` from stat. Cheap, but SFTP v3
 *    mtime has 1-second granularity, so two same-size writes within one second
 *    get the same ETag and a stale `ifMatch` could wrongly succeed.
 *
 * Conditional writes are emulated (`capabilities.conditionalWrites === false`):
 *  - `ifNoneMatch: '*'` is atomic: upload to a temp file, then plain SFTP
 *    RENAME, which OpenSSH implements as link()+unlink() and fails if the target exists.
 *  - `ifMatch` is check-then-replace (stat/hash, then posix-rename): there is
 *    a small race window between the check and the rename.
 * Every write goes to a temp file first and is renamed into place, so readers
 * never observe a partially written file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { Client, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2';
import {
  AuthError,
  NetworkError,
  PreconditionFailed,
  ProtocolError,
  StorageError,
  TooLarge,
} from './errors.ts';
import type {
  Capabilities,
  DeleteOptions,
  GetOptions,
  GetResult,
  HeadResult,
  ListEntry,
  PutOptions,
  StorageAdapter,
} from './types.ts';
import { checkMaxBytes, checkPath, checkPrefix, encodePath, sortEntries } from './util.ts';

export interface SftpOptions {
  /** ssh2 connect config: host, port, username, password / privateKey, hostVerifier... */
  connect: ConnectConfig;
  /** Absolute remote root directory, e.g. `/home/alice/triangulair`. Created if missing. */
  root: string;
  etagMode?: 'hash' | 'mtime-size';
  /** Public HTTPS base URL if the same directory is also served over HTTPS. */
  publicBaseUrl?: string;
}

const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

function code(e: unknown): unknown {
  return (e as { code?: unknown })?.code;
}

function isTempName(name: string): boolean {
  return name.startsWith('.tl-tmp-');
}

export class SftpAdapter implements StorageAdapter {
  readonly capabilities: Capabilities;
  private readonly opts: SftpOptions;
  private readonly root: string;
  private conn: Promise<{ client: Client; sftp: SFTPWrapper }> | undefined;
  /** Whether the server supports posix-rename@openssh.com (unknown until tried). */
  private posixRename: boolean | undefined;
  private readonly knownDirs = new Set<string>();

  constructor(opts: SftpOptions) {
    this.opts = opts;
    this.root = posix.resolve('/', opts.root);
    const pub = opts.publicBaseUrl ? opts.publicBaseUrl.replace(/\/?$/, '/') : undefined;
    this.capabilities = {
      readOnly: false,
      conditionalWrites: false,
      list: true,
      publicUrl: (path) => (pub ? pub + encodePath(checkPath(path)) : null),
    };
  }

  /** Close the SSH connection (reopened lazily on next call). */
  async close(): Promise<void> {
    const c = this.conn;
    this.conn = undefined;
    if (c) (await c.catch(() => undefined))?.client.end();
  }

  private sftp(): Promise<SFTPWrapper> {
    if (!this.conn) {
      const p = new Promise<{ client: Client; sftp: SFTPWrapper }>((resolve, reject) => {
        const client = new Client();
        client
          .on('ready', () => {
            // Request/response protocol: disable Nagle to avoid delayed-ACK stalls per round trip.
            client.setNoDelay(true);
            client.sftp((err, sftp) => {
              if (err) {
                client.end();
                reject(new ProtocolError(`SFTP subsystem unavailable: ${err.message}`, { cause: err }));
              } else resolve({ client, sftp });
            });
          })
          .on('error', (err: Error & { level?: string }) => {
            this.conn = undefined;
            reject(
              err.level === 'client-authentication'
                ? new AuthError(`SSH authentication failed: ${err.message}`, { cause: err })
                : new NetworkError(`SSH connection failed: ${err.message}`, { cause: err }),
            );
          })
          .on('close', () => {
            if (this.conn === p) this.conn = undefined;
          })
          .connect(this.opts.connect);
      });
      this.conn = p;
    }
    return this.conn.then((c) => c.sftp);
  }

  private abs(path: string): string {
    return path === '' ? this.root : posix.join(this.root, path);
  }

  private wrap(e: unknown, path: string): StorageError {
    if (e instanceof StorageError) return e;
    const c = code(e);
    const msg = (e as Error)?.message ?? String(e);
    if (c === PERMISSION_DENIED) return new AuthError(`SFTP permission denied: ${path}`, { path, cause: e });
    if (typeof c === 'number') return new ProtocolError(`SFTP error ${c} on ${path}: ${msg}`, { status: c, path, cause: e });
    return new NetworkError(`SFTP failure on ${path}: ${msg}`, { path, cause: e });
  }

  private async call<T>(path: string, fn: (s: SFTPWrapper, cb: (err: Error | undefined | null, v?: T) => void) => void): Promise<T> {
    const s = await this.sftp();
    return new Promise<T>((resolve, reject) => {
      fn(s, (err, v) => (err ? reject(err) : resolve(v as T)));
    }).catch((e) => {
      throw code(e) === NO_SUCH_FILE ? e : this.wrap(e, path);
    });
  }

  private async statOrNull(path: string): Promise<Stats | null> {
    try {
      return await this.call<Stats>(path, (s, cb) => s.stat(this.abs(path), cb));
    } catch (e) {
      if (code(e) === NO_SUCH_FILE) return null;
      throw this.wrap(e, path);
    }
  }

  private async readOrNull(path: string): Promise<Buffer | null> {
    try {
      return await this.call<Buffer>(path, (s, cb) => s.readFile(this.abs(path), cb));
    } catch (e) {
      if (code(e) === NO_SUCH_FILE) return null;
      throw this.wrap(e, path);
    }
  }

  /**
   * Reads at most `max` bytes through a file handle (32 KiB requests):
   * refuses a file whose stat size is over the limit, and stops as soon as
   * more than `max` bytes arrive (the file may grow between stat and read).
   */
  private async readLimitedOrNull(path: string, max: number): Promise<Buffer | null> {
    const abs = this.abs(path);
    let handle: Buffer;
    try {
      handle = await this.call<Buffer>(path, (s, cb) => s.open(abs, 'r', cb));
    } catch (e) {
      if (code(e) === NO_SUCH_FILE) return null;
      throw this.wrap(e, path);
    }
    try {
      const st = await this.call<Stats>(path, (s, cb) => s.fstat(handle, cb));
      if (st.size > max) throw new TooLarge(path, max, { size: st.size });
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const want = Math.min(32 * 1024, max + 1 - total);
        const buf = Buffer.alloc(want);
        const n = await this.call<number>(path, (s, cb) => s.read(handle, buf, 0, want, total, (err, bytes) => cb(err, bytes)));
        if (!n) break;
        total += n;
        if (total > max) throw new TooLarge(path, max);
        chunks.push(buf.subarray(0, n));
      }
      return Buffer.concat(chunks, total);
    } catch (e) {
      throw this.wrap(e, path);
    } finally {
      await this.call<void>(path, (s, cb) => s.close(handle, cb)).catch(() => undefined);
    }
  }

  private hashEtag(data: Uint8Array): string {
    return `"sha256-${createHash('sha256').update(data).digest('hex')}"`;
  }

  private statEtag(st: Stats): string {
    return `"${st.mtime}-${st.size}"`;
  }

  private async currentEtag(path: string): Promise<string | null> {
    if (this.opts.etagMode === 'mtime-size') {
      const st = await this.statOrNull(path);
      return st && st.isFile() ? this.statEtag(st) : null;
    }
    const data = await this.readOrNull(path);
    return data ? this.hashEtag(data) : null;
  }

  async get(path: string, opts: GetOptions = {}): Promise<GetResult | null> {
    checkPath(path);
    const max = checkMaxBytes(opts.maxBytes);
    const buf = max === undefined ? await this.readOrNull(path) : await this.readLimitedOrNull(path, max);
    if (!buf) return null;
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (this.opts.etagMode === 'mtime-size') {
      const st = await this.statOrNull(path);
      if (!st) return null;
      return { data, etag: this.statEtag(st) };
    }
    return { data, etag: this.hashEtag(data) };
  }

  async head(path: string): Promise<HeadResult | null> {
    checkPath(path);
    if (this.opts.etagMode === 'mtime-size') {
      const st = await this.statOrNull(path);
      return st && st.isFile() ? { etag: this.statEtag(st), size: st.size } : null;
    }
    const g = await this.get(path);
    return g ? { etag: g.etag, size: g.data.byteLength } : null;
  }

  /** Create the root and the parents of `path` (absolute remote paths), caching known dirs. */
  private async mkdirs(path: string): Promise<void> {
    const target = posix.dirname(this.abs(path));
    const segs = target.split('/').filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const dir = `/${segs.slice(0, i).join('/')}`;
      if (this.knownDirs.has(dir)) continue;
      const isDir = async () => {
        try {
          return (await this.call<Stats>(dir, (s, cb) => s.stat(dir, cb))).isDirectory();
        } catch (e) {
          if (code(e) === NO_SUCH_FILE) return false;
          throw this.wrap(e, dir);
        }
      };
      if (!(await isDir())) {
        try {
          await this.call<void>(dir, (s, cb) => s.mkdir(dir, cb));
        } catch (e) {
          // Lost a race with a concurrent mkdir: fine if it is a directory now.
          if (!(await isDir())) throw this.wrap(e, dir);
        }
      }
      this.knownDirs.add(dir);
    }
  }

  async put(path: string, data: Uint8Array, opts: PutOptions = {}): Promise<{ etag: string }> {
    checkPath(path);
    await this.mkdirs(path);
    if (opts.ifMatch !== undefined) {
      const cur = await this.currentEtag(path);
      if (cur !== opts.ifMatch) throw new PreconditionFailed(path, { detail: 'emulated' });
    }
    const dst = this.abs(path);
    const tmp = posix.join(posix.dirname(dst), `.tl-tmp-${randomBytes(8).toString('hex')}`);
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.call<void>(path, (s, cb) => s.writeFile(tmp, buf, { flag: 'wx' }, cb));
    try {
      if (opts.ifNoneMatch === '*') {
        try {
          // Plain RENAME fails if the target exists (OpenSSH: link()+unlink()).
          await this.call<void>(path, (s, cb) => s.rename(tmp, dst, cb));
        } catch (e) {
          if ((await this.statOrNull(path)) !== null) throw new PreconditionFailed(path, { detail: 'exists' });
          throw this.wrap(e, path);
        }
      } else {
        await this.replace(path, tmp, dst);
      }
    } catch (e) {
      await this.call<void>(path, (s, cb) => s.unlink(tmp, cb)).catch(() => {});
      throw e;
    }
    if (this.opts.etagMode === 'mtime-size') {
      const st = await this.statOrNull(path);
      if (!st) throw new ProtocolError(`PUT ${path} succeeded but file is missing`, { path });
      return { etag: this.statEtag(st) };
    }
    return { etag: this.hashEtag(data) };
  }

  /**
   * Atomically move tmp over dst with posix-rename@openssh.com. Servers without
   * that extension get a fallback: unlink(dst) + rename(tmp, dst), which leaves
   * a short window where dst is missing (readers see "not found", never partial data).
   */
  private async replace(path: string, tmp: string, dst: string): Promise<void> {
    if (this.posixRename !== false) {
      try {
        await this.call<void>(path, (s, cb) => s.ext_openssh_rename(tmp, dst, cb));
        this.posixRename = true;
        return;
      } catch (e) {
        if (!/does not support/i.test((e as Error)?.message ?? '')) throw e;
        this.posixRename = false;
      }
    }
    try {
      await this.call<void>(path, (s, cb) => s.unlink(dst, cb));
    } catch (e) {
      if (code(e) !== NO_SUCH_FILE) throw this.wrap(e, path);
    }
    await this.call<void>(path, (s, cb) => s.rename(tmp, dst, cb));
  }

  async delete(path: string, opts: DeleteOptions = {}): Promise<void> {
    checkPath(path);
    if (opts.ifMatch !== undefined) {
      const cur = await this.currentEtag(path);
      if (cur !== opts.ifMatch) throw new PreconditionFailed(path, { detail: 'emulated' });
    }
    try {
      await this.call<void>(path, (s, cb) => s.unlink(this.abs(path), cb));
    } catch (e) {
      if (code(e) === NO_SUCH_FILE) {
        if (opts.ifMatch !== undefined) throw new PreconditionFailed(path, { detail: 'missing' });
        return;
      }
      throw this.wrap(e, path);
    }
  }

  async list(prefix: string): Promise<ListEntry[]> {
    checkPrefix(prefix);
    const slash = prefix.lastIndexOf('/');
    const out: ListEntry[] = [];
    const queue = [slash >= 0 ? prefix.slice(0, slash) : ''];
    while (queue.length) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await this.call<{ filename: string; attrs: Stats }[]>(dir, (s, cb) => s.readdir(this.abs(dir), cb));
      } catch (e) {
        if (code(e) === NO_SUCH_FILE) continue;
        throw this.wrap(e, dir);
      }
      for (const { filename, attrs } of entries) {
        if (filename === '.' || filename === '..' || isTempName(filename)) continue;
        const rel = dir === '' ? filename : `${dir}/${filename}`;
        if (attrs.isDirectory()) {
          const d = `${rel}/`;
          if (d.startsWith(prefix) || prefix.startsWith(d)) queue.push(rel);
        } else if (attrs.isFile() && rel.startsWith(prefix)) {
          const etag =
            this.opts.etagMode === 'mtime-size' ? this.statEtag(attrs) : ((await this.currentEtag(rel)) ?? '');
          if (etag) out.push({ path: rel, etag, size: attrs.size });
        }
      }
    }
    return sortEntries(out);
  }
}
