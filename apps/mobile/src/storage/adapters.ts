/**
 * Storage config → `@triangulair/storage` adapter. The rest of the app (and the sync engine)
 * only sees `StorageAdapter`.
 */
import { HttpsReadOnlyAdapter, S3Adapter, WebDavAdapter, type FetchLike, type StorageAdapter } from '@triangulair/storage';

import type { StorageConfig } from './config';

export interface AdapterOptions {
  fetch?: FetchLike;
  /** Override the probe result (the connection test asks the server to enforce conditions). */
  conditionalWrites?: boolean;
}

/** The owner's adapter: read and write with credentials (HTTPS mode: read-only). */
export function writeAdapter(c: StorageConfig, opts: AdapterOptions = {}): StorageAdapter {
  const f = opts.fetch;
  if (c.kind === 'webdav') {
    return new WebDavAdapter({
      baseUrl: c.url,
      auth: { username: c.username, password: c.password },
      publicBaseUrl: c.readUrl,
      conditionalWrites: opts.conditionalWrites ?? c.conditionalWrites,
      ...(f ? { fetch: f } : {}),
    });
  }
  if (c.kind === 's3') {
    return new S3Adapter({
      endpoint: c.endpoint,
      bucket: c.bucket,
      region: c.region,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      prefix: c.prefix,
      pathStyle: c.pathStyle,
      publicBaseUrl: c.readUrl,
      conditionalWrites: opts.conditionalWrites ?? c.conditionalWrites,
      ...(f ? { fetch: f } : {}),
    });
  }
  return readAdapter(c, opts);
}

/** What friends use: anonymous HTTPS GET/HEAD at the read address. */
export function readAdapter(c: StorageConfig, opts: AdapterOptions = {}): StorageAdapter {
  return new HttpsReadOnlyAdapter({ baseUrl: c.readUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}
