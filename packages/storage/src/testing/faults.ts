/**
 * Fault-injection HTTP proxy for tests (Node only: `@triangulair/storage/testing/faults`).
 *
 * Sits in front of any HTTP storage server (in-process mock or real server)
 * and, for the requests matching a rule, injects a failure at the wire level:
 *
 * - `status`: answers with an HTTP status (507 quota, 401 refused credentials,
 *   503…) and an optional body, without reaching the server;
 * - `hang`: never answers (the client's timeout must fire); the request is not forwarded;
 * - `delay`: forwards after `ms`;
 * - `drop-upload`: forwards the request but cuts both connections after
 *   `afterBytes` bytes of the request body (a connection lost in the middle
 *   of an upload: the server sees a truncated body, the client a reset);
 * - `drop-download`: forwards, then cuts the connection after `afterBytes`
 *   bytes of the response body.
 *
 * The `Host` header is forwarded unchanged, so S3 SigV4 signatures (which
 * cover the proxy's host) still verify on servers that check them against
 * the `Host` they receive.
 */
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type FaultAction =
  | { kind: 'status'; status: number; body?: string; headers?: Record<string, string> }
  | { kind: 'hang' }
  | { kind: 'delay'; ms: number }
  | { kind: 'drop-upload'; afterBytes: number }
  | { kind: 'drop-download'; afterBytes: number };

export interface FaultRule {
  method?: string;
  /** Tested against the request path (with query). */
  path?: RegExp;
  /** How many matching requests it applies to (default: every one). */
  times?: number;
  action: FaultAction;
}

export interface FaultLogEntry {
  method: string;
  path: string;
  /** The action applied, or `pass`. */
  fault: FaultAction['kind'] | 'pass';
  /** Request body bytes forwarded to the server. */
  forwardedBytes: number;
}

export interface FaultProxy {
  /** Proxy base URL with the upstream's path appended (`http://127.0.0.1:<port>/<upstream path>`). */
  url: string;
  /** Proxy origin. */
  origin: string;
  /** Rules are tried in order; the first matching one with `times` left applies. */
  rules: FaultRule[];
  log: FaultLogEntry[];
  /** Adds a rule (chainable). */
  inject(rule: FaultRule): FaultProxy;
  /** Removes every rule. */
  clear(): void;
  close(): Promise<void>;
}

/** Starts a proxy to `upstream` (an http:// URL; its path is kept in `url`). */
export async function startFaultProxy(upstream: string): Promise<FaultProxy> {
  const up = new URL(upstream);
  if (up.protocol !== 'http:') throw new Error('fault proxy: upstream must be http://');
  const sockets = new Set<Socket>();
  const hung = new Set<ServerResponse>();
  const rules: FaultRule[] = [];
  const log: FaultLogEntry[] = [];

  const pick = (req: IncomingMessage): FaultAction | null => {
    for (const r of rules) {
      if (r.method && r.method.toUpperCase() !== req.method) continue;
      if (r.path && !r.path.test(req.url ?? '')) continue;
      if (r.times !== undefined) {
        if (r.times <= 0) continue;
        r.times--;
      }
      return r.action;
    }
    return null;
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const action = pick(req);
    const entry: FaultLogEntry = { method: req.method ?? 'GET', path: req.url ?? '/', fault: action?.kind ?? 'pass', forwardedBytes: 0 };
    log.push(entry);
    if (action?.kind === 'status') {
      req.resume();
      req.on('end', () => {
        res.writeHead(action.status, { 'content-type': 'text/plain', ...action.headers });
        res.end(req.method === 'HEAD' ? undefined : (action.body ?? ''));
      });
      return;
    }
    if (action?.kind === 'hang') {
      req.resume();
      hung.add(res);
      return;
    }
    const forward = () => {
      const upReq = httpRequest(
        { host: up.hostname, port: up.port || 80, method: req.method, path: req.url, headers: req.headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.headers);
          if (action?.kind === 'drop-download') {
            let sent = 0;
            upRes.on('data', (chunk: Buffer) => {
              if (sent >= action.afterBytes) return;
              const part = chunk.subarray(0, action.afterBytes - sent);
              sent += part.length;
              res.write(part);
              if (sent >= action.afterBytes) {
                upRes.destroy();
                res.socket?.destroy();
              }
            });
            upRes.on('end', () => res.socket?.destroy());
          } else {
            upRes.pipe(res);
          }
        },
      );
      upReq.on('error', () => res.socket?.destroy());
      if (action?.kind === 'drop-upload') {
        let sent = 0;
        let cut = false;
        req.on('data', (chunk: Buffer) => {
          if (cut) return;
          const part = chunk.subarray(0, Math.max(0, action.afterBytes - sent));
          sent += part.length;
          entry.forwardedBytes = sent;
          if (part.length) upReq.write(part);
          if (sent >= action.afterBytes) {
            cut = true;
            // Let the partial body reach the server, then cut both sides.
            setTimeout(() => {
              upReq.destroy();
              req.socket.destroy();
            }, 20);
          }
        });
        req.on('end', () => {
          if (!cut) upReq.end();
        });
      } else {
        req.on('data', (chunk: Buffer) => (entry.forwardedBytes += chunk.length));
        req.pipe(upReq);
      }
    };
    if (action?.kind === 'delay') setTimeout(forward, action.ms);
    else forward();
  };

  const server: Server = createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const proxy: FaultProxy = {
    origin,
    url: origin + up.pathname + up.search,
    rules,
    log,
    inject(rule) {
      rules.push({ ...rule });
      return proxy;
    },
    clear() {
      rules.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of hung) r.socket?.destroy();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  return proxy;
}
