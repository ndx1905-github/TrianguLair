import { describe, expect, it } from 'vitest';
import { PhotoDownloadBlockedError } from '@triangulair/import';

import { fetchRemotePhoto } from './photoDownload';

const ok = (bytes: number[], headers: Record<string, string> = {}) =>
  (async () => new Response(new Uint8Array(bytes), { status: 200, headers })) as unknown as typeof fetch;

describe('downloading a photo of an import', () => {
  it('returns the bytes; sends no cookie; refuses http, errors and empty answers', async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: string, i?: RequestInit) => {
      init = i;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    expect(await fetchRemotePhoto('https://img.example.org/a.jpg', ac.signal, false, f)).toEqual(new Uint8Array([1, 2, 3]));
    expect(init).toMatchObject({ credentials: 'omit' });
    await expect(fetchRemotePhoto('http://img.example.org/a.jpg', ac.signal, false, ok([1]))).rejects.toThrow(/https/);
    await expect(fetchRemotePhoto('https://img.example.org/a.jpg', ac.signal, false, (async () => new Response('', { status: 403 })) as unknown as typeof fetch)).rejects.toThrow(/403/);
    await expect(fetchRemotePhoto('https://img.example.org/a.jpg', ac.signal, false, ok([]))).rejects.toThrow(/empty/);
    await expect(fetchRemotePhoto('https://img.example.org/a.jpg', ac.signal, false, ok([1], { 'content-length': String(500 * 1024 * 1024) }))).rejects.toThrow(/too large/);
  });

  it('web: a request refused before any answer (cross-origin) is "blocked"; on the phone it is a plain failure', async () => {
    const refused = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    await expect(fetchRemotePhoto('https://img.example.org/a.jpg', ac.signal, true, refused)).rejects.toBeInstanceOf(PhotoDownloadBlockedError);
    await expect(fetchRemotePhoto('https://img.example.org/a.jpg', ac.signal, false, refused)).rejects.toBeInstanceOf(TypeError);
  });
});
