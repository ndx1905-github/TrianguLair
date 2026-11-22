/**
 * Ready-to-copy fixes shown by the connection test (storage README: "Public read for friends",
 * "CORS"). Pure text builders, unit-tested; the wording around them is in the i18n files.
 */
import type { S3Config } from './config';

/** Bucket policy: anonymous GetObject on the prefix only, never ListBucket (friends go through the signed index). */
export function s3PublicReadPolicy(bucket: string, prefix: string): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'TrianguLairPublicRead',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/${prefix}*`],
        },
      ],
    },
    null,
    2,
  );
}

/** Access key policy for the app: this prefix only. */
export function s3AccessKeyPolicy(bucket: string, prefix: string): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${bucket}/${prefix}*`] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`], Condition: { StringLike: { 's3:prefix': [`${prefix}*`] } } },
      ],
    },
    null,
    2,
  );
}

/**
 * Bucket CORS rules (S3 `PutBucketCors` JSON, as the AWS console and most providers take it).
 * The owner's web build needs writes from its origin; friends on the web need GET/HEAD from anywhere.
 */
export function s3CorsRules(origin: string | null): string {
  const rules: object[] = [];
  if (origin) {
    rules.push({
      AllowedOrigins: [origin],
      AllowedMethods: ['GET', 'HEAD', 'PUT', 'DELETE'],
      AllowedHeaders: ['authorization', 'content-type', 'if-match', 'if-none-match', 'x-amz-*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    });
  }
  rules.push({ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: [], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 });
  return JSON.stringify(rules, null, 2);
}

/**
 * CORS for the owner's WebDAV endpoint (the web version's origin only, never `*`: the requests carry
 * the password). Same lists as docs/self-host-web.md and packages/storage/README.md. The app uses
 * GET, HEAD, PUT, DELETE, PROPFIND and MKCOL; MOVE, COPY, Destination and Overwrite are allowed for
 * WebDAV clients in general. The server must answer the preflight (OPTIONS) itself, without a
 * password: Nextcloud would answer 401.
 */
export const WEBDAV_CORS_METHODS = 'GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS';
export const WEBDAV_CORS_HEADERS = 'Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match';
export const WEBDAV_CORS_EXPOSE = 'ETag, OC-ETag, Content-Length, Last-Modified';
export const CORS_MAX_AGE_S = 3600;

/** Apache (mod_headers) rules for the WebDAV write endpoint, for the web version. */
export function webDavCorsApache(origin: string): string {
  return [
    `Header always set Access-Control-Allow-Origin "${origin}"`,
    `Header always set Access-Control-Allow-Methods "${WEBDAV_CORS_METHODS}"`,
    `Header always set Access-Control-Allow-Headers "${WEBDAV_CORS_HEADERS}"`,
    `Header always set Access-Control-Expose-Headers "${WEBDAV_CORS_EXPOSE}"`,
    `Header always set Access-Control-Max-Age "${CORS_MAX_AGE_S}"`,
    'Header always set Vary "Origin"',
    'RewriteEngine On',
    'RewriteCond %{REQUEST_METHOD} OPTIONS',
    'RewriteRule ^(.*)$ $1 [R=204,L]',
  ].join('\n');
}

/**
 * The same for nginx in front of Nextcloud or another WebDAV server (in the location that serves
 * WebDAV). On YunoHost, docs/self-host-web.md has a ready-made file that survives upgrades.
 */
export function webDavCorsNginx(origin: string): string {
  return [
    `add_header Access-Control-Allow-Origin "${origin}" always;`,
    `add_header Access-Control-Allow-Methods "${WEBDAV_CORS_METHODS}" always;`,
    `add_header Access-Control-Allow-Headers "${WEBDAV_CORS_HEADERS}" always;`,
    `add_header Access-Control-Expose-Headers "${WEBDAV_CORS_EXPOSE}" always;`,
    `add_header Access-Control-Max-Age ${CORS_MAX_AGE_S} always;`,
    'if ($request_method = OPTIONS) { return 204; }',
  ].join('\n');
}

/** Headers the read address must send so friends' web pages can read it (the content is encrypted). */
export function readCorsHeaders(): string {
  return ['Access-Control-Allow-Origin: *', 'Access-Control-Expose-Headers: ETag, Content-Length, Last-Modified'].join('\n');
}

export function s3Fixes(c: Pick<S3Config, 'bucket' | 'prefix'>) {
  return { policy: s3PublicReadPolicy(c.bucket, c.prefix), keyPolicy: s3AccessKeyPolicy(c.bucket, c.prefix) };
}
