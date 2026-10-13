/**
 * HAND-WRITTEN S3 MOCK (test-only). Not a real S3 implementation: it covers
 * exactly the subset the adapter uses, following AWS documented behaviour:
 *
 *  - path-style GET / HEAD / PUT / DELETE object, ListObjectsV2 (with pagination)
 *  - SigV4 verification (re-signs with aws4fetch's signer and compares) and
 *    x-amz-content-sha256 payload check
 *  - PUT If-None-Match: * (412 if exists), PUT If-Match (412 mismatch, 404 missing)
 *  - DELETE If-Match (412 mismatch, 404 missing)
 *  - ETag = quoted MD5 of the content (single-part upload semantics)
 *  - optional anonymous GET/HEAD (public-read bucket policy)
 *  - optional `ignoreConditionals` to mimic providers that silently ignore them
 *
 * s3rver / MinIO were not used: s3rver is unmaintained and predates S3
 * conditional writes; MinIO needs a binary download (no general internet here).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AwsV4Signer } from 'aws4fetch';
import { listen, readBody, type Running } from './http.ts';

export interface S3MockOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicRead?: boolean;
  ignoreConditionals?: boolean;
  maxKeys?: number;
}

interface Obj {
  data: Buffer;
  etag: string;
  contentType: string;
}

const xmlEsc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function startS3Mock(opts: S3MockOptions): Promise<Running & { objects: Map<string, Obj> }> {
  const objects = new Map<string, Obj>();

  function error(res: ServerResponse, status: number, code: string, head = false) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/xml');
    res.end(head ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`);
  }

  async function verify(req: IncomingMessage, body: Buffer): Promise<boolean> {
    const auth = req.headers.authorization;
    if (!auth) return false;
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
    if (!m || m[1] !== opts.accessKeyId || m[3] !== opts.region) return false;
    const signedHeaders = m[4]!.split(';');
    const headers: Record<string, string> = {};
    for (const h of signedHeaders) {
      if (h === 'host') continue;
      const v = req.headers[h];
      if (typeof v !== 'string') return false;
      headers[h] = v;
    }
    const datetime = headers['x-amz-date'];
    if (!datetime) return false;
    const signer = new AwsV4Signer({
      method: req.method!,
      url: `http://${req.headers.host}${req.url}`,
      headers,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: opts.region,
      datetime,
    });
    if ((await signer.authHeader()) !== auth) return false;
    const sha = headers['x-amz-content-sha256'];
    if (sha && sha !== 'UNSIGNED-PAYLOAD' && sha !== createHash('sha256').update(body).digest('hex')) return false;
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, 'http://x');
    const body = await readBody(req);
    const method = req.method!;
    const isHead = method === 'HEAD';
    const [, bucket, ...rest] = url.pathname.split('/');
    if (decodeURIComponent(bucket ?? '') !== opts.bucket) return error(res, 404, 'NoSuchBucket', isHead);
    const key = rest.map(decodeURIComponent).join('/');

    const authed = await verify(req, body);
    const anonymousOk = opts.publicRead && (method === 'GET' || isHead) && key !== '';
    if (!authed && !anonymousOk) return error(res, 403, req.headers.authorization ? 'SignatureDoesNotMatch' : 'AccessDenied', isHead);

    if (key === '') {
      if (method !== 'GET' || url.searchParams.get('list-type') !== '2') return error(res, 400, 'InvalidRequest');
      const prefix = url.searchParams.get('prefix') ?? '';
      const start = url.searchParams.get('continuation-token') ?? '';
      const max = opts.maxKeys ?? 1000;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > start).sort();
      const page = keys.slice(0, max);
      const truncated = keys.length > max;
      res.setHeader('content-type', 'application/xml');
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<Name>${opts.bucket}</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${xmlEsc(page[page.length - 1]!)}</NextContinuationToken>` : '') +
          page
            .map((k) => {
              const o = objects.get(k)!;
              return `<Contents><Key>${xmlEsc(k)}</Key><ETag>${xmlEsc(o.etag)}</ETag><Size>${o.data.length}</Size></Contents>`;
            })
            .join('') +
          `</ListBucketResult>`,
      );
      return;
    }

    const cur = objects.get(key);
    const ifMatch = opts.ignoreConditionals ? undefined : req.headers['if-match'];
    const ifNoneMatch = opts.ignoreConditionals ? undefined : req.headers['if-none-match'];

    switch (method) {
      case 'GET':
      case 'HEAD': {
        if (!cur) return error(res, 404, 'NoSuchKey', isHead);
        res.setHeader('etag', cur.etag);
        res.setHeader('content-type', cur.contentType);
        res.setHeader('content-length', String(cur.data.length));
        res.end(isHead ? undefined : cur.data);
        return;
      }
      case 'PUT': {
        if (ifNoneMatch === '*' && cur) return error(res, 412, 'PreconditionFailed');
        if (ifMatch !== undefined) {
          if (!cur) return error(res, 404, 'NoSuchKey');
          if (ifMatch !== cur.etag) return error(res, 412, 'PreconditionFailed');
        }
        const etag = `"${createHash('md5').update(body).digest('hex')}"`;
        objects.set(key, { data: body, etag, contentType: req.headers['content-type'] ?? 'binary/octet-stream' });
        res.setHeader('etag', etag);
        res.end();
        return;
      }
      case 'DELETE': {
        if (ifMatch !== undefined) {
          if (!cur) return error(res, 404, 'NoSuchKey');
          if (ifMatch !== cur.etag) return error(res, 412, 'PreconditionFailed');
        }
        objects.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }
      default:
        return error(res, 405, 'MethodNotAllowed');
    }
  }

  const running = await listen((req, res) => {
    handle(req, res).catch((e) => {
      res.statusCode = 500;
      res.end(String(e));
    });
  });
  return { ...running, objects };
}
