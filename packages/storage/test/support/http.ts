import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Running {
  url: string;
  close: () => Promise<void>;
}

export async function listen(handler: RequestListener | Server): Promise<Running> {
  const server = typeof handler === 'function' ? createServer(handler) : handler;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** A URL nothing listens on (for NetworkError tests). */
export async function deadUrl(): Promise<string> {
  const r = await listen((_q, s) => s.end());
  await r.close();
  return r.url;
}
