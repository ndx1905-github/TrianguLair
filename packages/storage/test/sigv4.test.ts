/**
 * SigV4 without WebCrypto (Hermes has no `crypto.subtle`):
 * - the worked examples of the AWS documentation ("Signature Calculations for
 *   the Authorization Header: Transferring Payload in a Single Chunk", S3 API
 *   reference; "Deriving the signing key", SigV4 general reference);
 * - the same signature as aws4fetch (the previous signer) on varied requests;
 * - the S3 adapter works with `crypto.subtle` removed.
 */
import { randomBytes } from 'node:crypto';
import { AwsV4Signer } from 'aws4fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Adapter } from '../src/index.ts';
import { canonicalQuery, hex, sha256Hex, signingKey, signV4 } from '../src/sigv4.ts';
import { startS3Mock } from './support/s3-mock.ts';

// The example credentials of the AWS S3 documentation.
const DOC = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
  datetime: '20130524T000000Z',
  allHeaders: true,
};
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('SigV4: AWS documentation examples', () => {
  it('derives the signing key (SigV4 reference: 20120215 / us-east-1 / iam)', () => {
    const k = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
    expect(hex(k)).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });

  it('SHA-256 of the empty payload', () => {
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_SHA);
  });

  it('GET Object (Range header signed)', () => {
    const s = signV4(
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA } },
      DOC,
    );
    expect(s.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY_SHA}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA,
      ].join('\n'),
    );
    expect(s.stringToSign).toBe(
      'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    );
    expect(s.headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT Object (payload hash, "$" in the key, Date and storage class signed)', () => {
    const body = new TextEncoder().encode('Welcome to Amazon S3.');
    const s = signV4(
      {
        method: 'PUT',
        url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
        headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
        body,
      },
      DOC,
    );
    expect(s.headers['x-amz-content-sha256']).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(s.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(s.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET Bucket Lifecycle (query parameter without value)', () => {
    const s = signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle', headers: { 'x-amz-content-sha256': EMPTY_SHA } }, DOC);
    expect(s.canonicalRequest.split('\n')[2]).toBe('lifecycle=');
    expect(s.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('GET Bucket / list objects (sorted query)', () => {
    const s = signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', headers: { 'x-amz-content-sha256': EMPTY_SHA } }, DOC);
    expect(s.canonicalRequest.split('\n')[2]).toBe('max-keys=2&prefix=J');
    expect(s.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('canonical query: RFC 3986 encoding, first value of a repeated key, empty keys dropped', () => {
    expect(canonicalQuery(new URLSearchParams('b=2&a=x y&a=z&=v&c=*'))).toBe('a=x%20y&b=2&c=%2A');
  });

  it('session token is signed', () => {
    const s = signV4({ method: 'GET', url: 'https://b.s3.amazonaws.com/k' }, { ...DOC, allHeaders: false, sessionToken: 'tok' });
    expect(s.headers['x-amz-security-token']).toBe('tok');
    expect(s.headers['authorization']).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,');
  });
});

describe('SigV4: same signatures as aws4fetch', () => {
  const keys = ['index.json', 'packs/a b.bin', 'packs/ünï(c)!*.bin', "x/'quote'/~tilde+plus", 'p/%41/semi;colon'];
  const urls = [
    ...keys.map((k) => `http://127.0.0.1:9000/bucket/tl/alice/${k.split('/').map(encodeURIComponent).join('/')}`),
    'https://bucket.s3.eu-west-3.amazonaws.com/?list-type=2&prefix=tl%2Falice%2Fpacks%2F&continuation-token=a%2Bb%3D%3D',
    'https://s3.fr-par.scw.cloud:8443/b/?list-type=2&prefix=a%20b',
  ];
  for (const url of urls) {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      it(`${method} ${url}`, async () => {
        const body = method === 'PUT' ? new Uint8Array(randomBytes(37)) : undefined;
        const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'if-match': '"abc"' };
        if (body) headers['x-amz-content-sha256'] = sha256Hex(body);
        const opts = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret/KEY+1', region: 'eu-west-3', service: 's3', datetime: '20261117T101112Z' };
        const ours = signV4({ method, url, headers, ...(body ? { body } : {}) }, opts);
        const theirs = await new AwsV4Signer({ method, url, headers, ...opts, ...(body ? { body } : {}) }).sign();
        expect(ours.headers['authorization']).toBe(theirs.headers.get('authorization'));
        expect(ours.headers['x-amz-content-sha256']).toBe(theirs.headers.get('x-amz-content-sha256'));
      });
    }
  }
});

describe('S3 adapter without WebCrypto (Hermes)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs every request without touching crypto.subtle (checked by the mock with aws4fetch)', async () => {
    const creds = { bucket: 'tl-bucket', region: 'eu-west-3', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret/KEY+1' };
    const srv = await startS3Mock({ ...creds, maxKeys: 1 });
    const realCrypto = globalThis.crypto;
    let clientCalls = 0;
    // The client side runs with `crypto` gone; the mock (same process) gets it back to verify.
    const fetchNoCrypto: typeof fetch = async (input, init) => {
      clientCalls++;
      vi.unstubAllGlobals();
      try {
        return await fetch(input, init);
      } finally {
        vi.stubGlobal('crypto', undefined);
      }
    };
    try {
      const a = new S3Adapter({ endpoint: srv.url, ...creds, prefix: 'tl/', fetch: fetchNoCrypto });
      vi.stubGlobal('crypto', undefined);
      expect(globalThis.crypto).toBeUndefined();
      const { etag } = await a.put('packs/x y.bin', new Uint8Array([1, 2, 3]), { ifNoneMatch: '*' });
      await a.put('index.json', new Uint8Array([4]), { ifNoneMatch: '*' });
      expect((await a.get('packs/x y.bin'))?.etag).toBe(etag);
      expect((await a.list('')).map((e) => e.path)).toEqual(['index.json', 'packs/x y.bin']);
      await a.delete('packs/x y.bin', { ifMatch: etag });
      expect(await a.head('packs/x y.bin')).toBeNull();
      expect(clientCalls).toBeGreaterThan(5);
    } finally {
      vi.unstubAllGlobals();
      expect(globalThis.crypto).toBe(realCrypto);
      await srv.close();
    }
  });
});
