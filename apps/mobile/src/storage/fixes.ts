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

/** Apache (mod_headers) rules for the WebDAV write endpoint, for the web test build. */
export function webDavCorsApache(origin: string): string {
  return [
    `Header always set Access-Control-Allow-Origin "${origin}"`,
    'Header always set Access-Control-Allow-Methods "GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, OPTIONS"',
    'Header always set Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match"',
    'Header always set Access-Control-Expose-Headers "ETag, OC-ETag, Content-Length"',
    'Header always set Vary "Origin"',
    'RewriteEngine On',
    'RewriteCond %{REQUEST_METHOD} OPTIONS',
    'RewriteRule ^(.*)$ $1 [R=204,L]',
  ].join('\n');
}

/** The same for nginx in front of Nextcloud or another WebDAV server. */
export function webDavCorsNginx(origin: string): string {
  return [
    `add_header Access-Control-Allow-Origin "${origin}" always;`,
    'add_header Access-Control-Allow-Methods "GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, OPTIONS" always;',
    'add_header Access-Control-Allow-Headers "Authorization, Content-Type, Depth, If-Match, If-None-Match" always;',
    'add_header Access-Control-Expose-Headers "ETag, OC-ETag, Content-Length" always;',
    'if ($request_method = OPTIONS) { return 204; }',
  ].join('\n');
}

/** Headers the read address must send so friends' web pages can read it (the content is encrypted). */
export function readCorsHeaders(): string {
  return ['Access-Control-Allow-Origin: *', 'Access-Control-Expose-Headers: ETag'].join('\n');
}

export function s3Fixes(c: Pick<S3Config, 'bucket' | 'prefix'>) {
  return { policy: s3PublicReadPolicy(c.bucket, c.prefix), keyPolicy: s3AccessKeyPolicy(c.bucket, c.prefix) };
}
