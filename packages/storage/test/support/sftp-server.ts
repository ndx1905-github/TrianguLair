/**
 * Minimal in-process SFTP server (test-only) built on ssh2's Server, backed
 * by a real temp directory. Implements the requests the adapter uses with
 * OpenSSH-like semantics (notably RENAME fails if the target exists).
 * Limitation: ssh2's server does not advertise extensions, so
 * posix-rename@openssh.com is unavailable and the adapter's fallback path
 * (unlink + rename) is what gets exercised here.
 */
import * as fs from 'node:fs';
import { posix, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import type { Attributes, SFTPWrapper } from 'ssh2';

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;

export interface SftpServer {
  port: number;
  hostKey: string;
  close: () => Promise<void>;
}

function attrsOf(st: fs.Stats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function statusOf(e: unknown): number {
  const c = (e as NodeJS.ErrnoException)?.code;
  if (c === 'ENOENT') return STATUS.NO_SUCH_FILE;
  if (c === 'EACCES' || c === 'EPERM') return STATUS.PERMISSION_DENIED;
  return STATUS.FAILURE;
}

export async function startSftpServer(opts: {
  root: string;
  username: string;
  password: string;
}): Promise<SftpServer> {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  // Client paths are absolute "virtual" paths; map them under opts.root.
  const real = (p: string) => join(opts.root, posix.resolve('/', p));

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === opts.username && ctx.password === opts.password)
        ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => serve(acceptSftp()));
      });
    });
  });

  function serve(sftp: SFTPWrapper) {
    let next = 0;
    const handles = new Map<number, { fd?: number; dir?: string[]; dirPath?: string }>();
    const mk = (h: { fd?: number; dir?: string[]; dirPath?: string }) => {
      const id = next++;
      handles.set(id, h);
      const b = Buffer.alloc(4);
      b.writeUInt32BE(id);
      return b;
    };
    const get = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
    const guard = (reqid: number, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        sftp.status(reqid, statusOf(e));
      }
    };

    sftp.on('OPEN', (reqid, filename, flags) =>
      guard(reqid, () => {
        const mode = utils.sftp.flagsToString(flags);
        if (!mode) return sftp.status(reqid, STATUS.FAILURE);
        sftp.handle(reqid, mk({ fd: fs.openSync(real(filename), mode) }));
      }),
    );
    sftp.on('READ', (reqid, handle, offset, length) =>
      guard(reqid, () => {
        const h = get(handle);
        if (h?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
        const buf = Buffer.alloc(length);
        const n = fs.readSync(h.fd, buf, 0, length, offset);
        if (n === 0) return sftp.status(reqid, STATUS.EOF);
        sftp.data(reqid, buf.subarray(0, n));
      }),
    );
    sftp.on('WRITE', (reqid, handle, offset, data) =>
      guard(reqid, () => {
        const h = get(handle);
        if (h?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
        fs.writeSync(h.fd, data, 0, data.length, offset);
        sftp.status(reqid, STATUS.OK);
      }),
    );
    sftp.on('FSTAT', (reqid, handle) =>
      guard(reqid, () => {
        const h = get(handle);
        if (h?.fd === undefined) return sftp.status(reqid, STATUS.FAILURE);
        sftp.attrs(reqid, attrsOf(fs.fstatSync(h.fd)));
      }),
    );
    sftp.on('CLOSE', (reqid, handle) =>
      guard(reqid, () => {
        const h = get(handle);
        if (!h) return sftp.status(reqid, STATUS.FAILURE);
        if (h.fd !== undefined) fs.closeSync(h.fd);
        handles.delete(handle.readUInt32BE(0));
        sftp.status(reqid, STATUS.OK);
      }),
    );
    const onStat = (reqid: number, p: string) => guard(reqid, () => sftp.attrs(reqid, attrsOf(fs.statSync(real(p)))));
    sftp.on('STAT', onStat);
    sftp.on('LSTAT', onStat);
    sftp.on('OPENDIR', (reqid, p) =>
      guard(reqid, () => {
        const dirPath = real(p);
        sftp.handle(reqid, mk({ dir: fs.readdirSync(dirPath), dirPath }));
      }),
    );
    sftp.on('READDIR', (reqid, handle) =>
      guard(reqid, () => {
        const h = get(handle);
        if (!h?.dir || !h.dirPath) return sftp.status(reqid, STATUS.FAILURE);
        if (h.dir.length === 0) return sftp.status(reqid, STATUS.EOF);
        const names = h.dir.splice(0, h.dir.length).map((filename) => ({
          filename,
          longname: filename,
          attrs: attrsOf(fs.statSync(join(h.dirPath!, filename))),
        }));
        sftp.name(reqid, names);
      }),
    );
    sftp.on('MKDIR', (reqid, p) => guard(reqid, () => (fs.mkdirSync(real(p)), sftp.status(reqid, STATUS.OK))));
    sftp.on('RMDIR', (reqid, p) => guard(reqid, () => (fs.rmdirSync(real(p)), sftp.status(reqid, STATUS.OK))));
    sftp.on('REMOVE', (reqid, p) => guard(reqid, () => (fs.unlinkSync(real(p)), sftp.status(reqid, STATUS.OK))));
    // OpenSSH: link()+unlink(), so RENAME fails when the target exists.
    sftp.on('RENAME', (reqid, from, to) =>
      guard(reqid, () => {
        fs.linkSync(real(from), real(to));
        fs.unlinkSync(real(from));
        sftp.status(reqid, STATUS.OK);
      }),
    );
    sftp.on('REALPATH', (reqid, p) =>
      sftp.name(reqid, [{ filename: posix.resolve('/', p), longname: '', attrs: {} as Attributes }]),
    );
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hostKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
