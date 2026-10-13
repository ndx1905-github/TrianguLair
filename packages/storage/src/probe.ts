import { PreconditionFailed } from './errors.ts';
import type { StorageAdapter } from './types.ts';

/**
 * Check at account-setup time that the server really enforces conditional
 * writes (some S3-compatible providers / WebDAV servers silently ignore
 * If-Match). Writes and deletes a scratch object `.triangulair-probe-<rand>`.
 */
export async function probeConditionalWrites(adapter: StorageAdapter): Promise<boolean> {
  const path = `.triangulair-probe-${Math.random().toString(36).slice(2)}`;
  const { etag } = await adapter.put(path, new Uint8Array([1]));
  try {
    try {
      await adapter.put(path, new Uint8Array([2]), { ifNoneMatch: '*' });
      return false;
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
    }
    try {
      await adapter.put(path, new Uint8Array([3]), { ifMatch: `"x${etag.replace(/"/g, '')}x"` });
      return false;
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
    }
    return true;
  } finally {
    await adapter.delete(path).catch(() => {});
  }
}
