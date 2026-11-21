/**
 * AWS Signature Version 4 (header form) in pure JavaScript, for S3.
 *
 * Why not aws4fetch: it signs with WebCrypto `crypto.subtle`, which Hermes
 * (React Native) does not have, so S3 failed on phones. This signer uses
 * `@noble/hashes` (audited, pure JS, no WASM, no WebCrypto) for SHA-256 and
 * HMAC-SHA256, and is otherwise equivalent to aws4fetch's `AwsV4Signer` for
 * the requests the S3 adapter sends:
 *
 * - `host` and `x-amz-date` are always signed, plus every header passed in
 *   except the ones aws4fetch also leaves unsigned (`content-type`,
 *   `content-length`, `range`, `user-agent`…) unless `allHeaders` is set;
 * - `x-amz-content-sha256` is the hex SHA-256 of the body, or
 *   `UNSIGNED-PAYLOAD` when there is no body and none is given;
 * - S3 path canonicalisation: the URL path is decoded once and re-encoded
 *   per RFC 3986 (no double encoding, no `//` collapsing);
 * - the query is RFC 3986-encoded and sorted, the first value of a repeated
 *   key wins (S3), empty keys are dropped;
 * - header values have runs of whitespace collapsed to one space.
 *
 * Checked against the worked examples of the AWS documentation (test/sigv4.test.ts)
 * and against aws4fetch on random requests.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const enc = new TextEncoder();

/** Headers aws4fetch never signs (they may be changed by proxies or the fetch implementation). */
export const UNSIGNABLE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
  'expect',
  'x-amzn-trace-id',
  'range',
  'connection',
]);

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  url: string;
  /** Header names are matched case-insensitively. */
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface SigV4Options extends SigV4Credentials {
  region: string;
  /** Default `s3`. Only the S3 path canonicalisation is implemented. */
  service?: string;
  /** `YYYYMMDDTHHMMSSZ`; default: now. */
  datetime?: string;
  /** Also sign the headers aws4fetch leaves unsigned (the AWS documentation examples sign `range` and `date`). */
  allHeaders?: boolean;
}

export interface SignedRequest {
  method: string;
  url: string;
  /** Lower-case names; includes `authorization`, `x-amz-date`, `x-amz-content-sha256`. */
  headers: Record<string, string>;
  /** Intermediate values, for tests and debugging (never logged by the adapter). */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i]! < 16 ? '0' : '') + bytes[i]!.toString(16);
  return out;
}

export function sha256Hex(data: Uint8Array | string): string {
  return hex(sha256(typeof data === 'string' ? enc.encode(data) : data));
}

function hmacSha256(key: Uint8Array, msg: string): Uint8Array {
  return hmac(sha256, key, enc.encode(msg));
}

/** `kSigning = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service), "aws4_request")`. */
export function signingKey(secretAccessKey: string, date: string, region: string, service: string): Uint8Array {
  const kDate = hmacSha256(enc.encode(`AWS4${secretAccessKey}`), date);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

const rfcChars = (s: string): string => s.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const rfc3986 = (s: string): string => rfcChars(encodeURIComponent(s));

/** S3 canonical URI: decode once, then encode each segment (slashes kept). */
export function canonicalPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.replace(/\+/g, ' '));
  } catch {
    decoded = pathname;
  }
  return rfc3986(decoded).replace(/%2F/g, '/');
}

export function canonicalQuery(search: URLSearchParams): string {
  const seen = new Set<string>();
  return [...search]
    .filter(([k]) => {
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function amzDate(d: Date = new Date()): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** Signs a request (Authorization header). Synchronous: no WebCrypto. */
export function signV4(req: SigV4Request, opts: SigV4Options): SignedRequest {
  const service = opts.service ?? 's3';
  const url = new URL(req.url);
  const datetime = opts.datetime ?? amzDate();
  if (!/^\d{8}T\d{6}Z$/.test(datetime)) throw new TypeError(`SigV4: bad datetime ${datetime}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const name = k.toLowerCase();
    if (name === 'host' || name === 'authorization') continue;
    headers[name] = v;
  }
  if (headers['x-amz-content-sha256'] === undefined) {
    headers['x-amz-content-sha256'] = req.body ? sha256Hex(req.body) : service === 's3' ? UNSIGNED_PAYLOAD : sha256Hex('');
  }
  headers['x-amz-date'] = datetime;
  if (opts.sessionToken) headers['x-amz-security-token'] = opts.sessionToken;

  const signable = ['host', ...Object.keys(headers)].filter((h) => opts.allHeaders || !UNSIGNABLE_HEADERS.has(h)).sort();
  const signedHeaders = signable.join(';');
  const canonicalHeaders = signable
    .map((h) => `${h}:${h === 'host' ? url.host : headers[h]!.trim().replace(/\s+/g, ' ')}`)
    .join('\n');
  // Other services: the already-encoded path is encoded again (aws4fetch, AWS SigV4 test suite).
  const path = service === 's3' ? canonicalPath(url.pathname) : rfcChars(encodeURIComponent(url.pathname.replace(/\/+/g, '/')).replace(/%2F/g, '/'));
  const canonicalRequest = [
    req.method.toUpperCase(),
    path,
    canonicalQuery(url.searchParams),
    `${canonicalHeaders}\n`,
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');
  const scope = `${datetime.slice(0, 8)}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(hmac(sha256, signingKey(opts.secretAccessKey, datetime.slice(0, 8), opts.region, service), enc.encode(stringToSign)));
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { method: req.method, url: url.href, headers, canonicalRequest, stringToSign, signature };
}
