import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError, S3Adapter, probeConditionalWrites, type S3Options } from '../src/index.ts';
import { runAdapterConformance } from '../src/testing/conformance.ts';
import { deadUrl } from './support/http.ts';
import { startS3Mock, type S3MockOptions } from './support/s3-mock.ts';

const creds = { bucket: 'tl-bucket', region: 'eu-west-3', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret/KEY+1' };

async function setup(mock: Partial<S3MockOptions> = {}, adapter: Partial<S3Options> = {}) {
  const srv = await startS3Mock({ ...creds, publicRead: true, maxKeys: 2, ...mock });
  const a = new S3Adapter({
    endpoint: srv.url,
    ...creds,
    prefix: 'triangulair/alice',
    publicBaseUrl: `${srv.url}/${creds.bucket}/triangulair/alice/`,
    ...adapter,
  });
  return { srv, adapter: a };
}

// Against the HAND-WRITTEN mock (see test/support/s3-mock.ts), not real S3.
runAdapterConformance('S3 (mock)', async () => {
  const { srv, adapter } = await setup();
  return { adapter, publicUrlFetchable: true, cleanup: srv.close };
});

// Provider that ignores If-Match / If-None-Match: adapter emulates (racy).
runAdapterConformance('S3 (mock, emulated conditionals)', async () => {
  const { srv, adapter } = await setup({ ignoreConditionals: true }, { conditionalWrites: false });
  return { adapter, cleanup: srv.close };
});

describe('S3 specifics', () => {
  it('stores keys under the prefix and signs requests (mock verifies SigV4)', async () => {
    const { srv, adapter } = await setup();
    try {
      await adapter.put('packs/a b.bin', new Uint8Array([1, 2, 3]));
      expect([...srv.objects.keys()]).toEqual(['triangulair/alice/packs/a b.bin']);
    } finally {
      await srv.close();
    }
  });

  it('maps wrong secret to AuthError', async () => {
    const { srv, adapter } = await setup({}, { secretAccessKey: 'wrong' });
    try {
      await expect(adapter.put('index.json', new Uint8Array([1]))).rejects.toBeInstanceOf(AuthError);
      await expect(adapter.list('')).rejects.toBeInstanceOf(AuthError);
    } finally {
      await srv.close();
    }
  });

  it('maps connection failure to NetworkError', async () => {
    const a = new S3Adapter({ endpoint: await deadUrl(), ...creds });
    await expect(a.head('index.json')).rejects.toBeInstanceOf(NetworkError);
  });

  it('probe detects a provider that silently ignores conditional headers', async () => {
    const bad = await setup({ ignoreConditionals: true });
    const good = await setup();
    try {
      expect(await probeConditionalWrites(bad.adapter)).toBe(false);
      expect(await probeConditionalWrites(good.adapter)).toBe(true);
    } finally {
      await bad.srv.close();
      await good.srv.close();
    }
  });
});
