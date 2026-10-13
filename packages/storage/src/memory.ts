import { PreconditionFailed, ReadOnly } from './errors.ts';
import type {
  Capabilities,
  DeleteOptions,
  GetResult,
  HeadResult,
  ListEntry,
  PutOptions,
  StorageAdapter,
} from './types.ts';
import { checkPath, checkPrefix, copyBytes, sortEntries } from './util.ts';

export interface MemoryAdapterOptions {
  readOnly?: boolean;
  /** Base URL used by `capabilities.publicUrl` (tests). */
  publicBaseUrl?: string;
}

interface Entry {
  data: Uint8Array;
  etag: string;
}

let counter = 0;

/** In-memory adapter: reference implementation of the semantics, used in tests. */
export class MemoryAdapter implements StorageAdapter {
  readonly capabilities: Capabilities;
  /** Exposed so tests / local HTTP fixtures can serve the same data. */
  readonly store = new Map<string, Entry>();

  constructor(opts: MemoryAdapterOptions = {}) {
    const base = opts.publicBaseUrl;
    this.capabilities = {
      readOnly: !!opts.readOnly,
      conditionalWrites: true,
      list: true,
      publicUrl: (path) => (base ? base.replace(/\/?$/, '/') + checkPath(path) : null),
    };
  }

  async get(path: string): Promise<GetResult | null> {
    const e = this.store.get(checkPath(path));
    return e ? { data: copyBytes(e.data), etag: e.etag } : null;
  }

  async head(path: string): Promise<HeadResult | null> {
    const e = this.store.get(checkPath(path));
    return e ? { etag: e.etag, size: e.data.byteLength } : null;
  }

  async put(path: string, data: Uint8Array, opts: PutOptions = {}): Promise<{ etag: string }> {
    checkPath(path);
    if (this.capabilities.readOnly) throw new ReadOnly(path);
    return this.putUnchecked(path, data, opts);
  }

  /** Write bypassing `readOnly` (used to seed read-only fixtures). */
  putUnchecked(path: string, data: Uint8Array, opts: PutOptions = {}): { etag: string } {
    const cur = this.store.get(checkPath(path));
    if (opts.ifNoneMatch === '*' && cur) throw new PreconditionFailed(path, { detail: 'exists' });
    if (opts.ifMatch !== undefined && cur?.etag !== opts.ifMatch) throw new PreconditionFailed(path);
    const etag = `"m${++counter}"`;
    this.store.set(path, { data: copyBytes(data), etag });
    return { etag };
  }

  async delete(path: string, opts: DeleteOptions = {}): Promise<void> {
    checkPath(path);
    if (this.capabilities.readOnly) throw new ReadOnly(path);
    const cur = this.store.get(path);
    if (opts.ifMatch !== undefined && cur?.etag !== opts.ifMatch) throw new PreconditionFailed(path);
    this.store.delete(path);
  }

  async list(prefix: string): Promise<ListEntry[]> {
    checkPrefix(prefix);
    const out: ListEntry[] = [];
    for (const [path, e] of this.store) {
      if (path.startsWith(prefix)) out.push({ path, etag: e.etag, size: e.data.byteLength });
    }
    return sortEntries(out);
  }
}
