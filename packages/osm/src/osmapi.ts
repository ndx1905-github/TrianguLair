/**
 * Minimal read access to the OSM editing API, used only to confirm that an
 * element Overpass no longer returns was really deleted (410 Gone), and when.
 *
 * The OSM API usage policy reserves it for editing and asks read-only users
 * to stay light: the closed-place check calls it only for elements missing
 * from Overpass (rare), one at a time, at most 1 request per second.
 */
import type { HttpClient } from './http/client.ts';
import type { OsmElement, OsmRef, RequestOptions } from './types.ts';

interface OsmApiResponse {
  version?: string;
  elements?: OsmElement[];
}

export type OsmApiLookup =
  | { status: 'present'; element: OsmElement }
  | { status: 'deleted'; deletedAt?: string; lastVersion?: OsmElement }
  | { status: 'not_found' };

export interface OsmApiClientOptions {
  http: HttpClient;
  baseUrl: string;
  /** Default 1 day. */
  ttlMs?: number;
}

export class OsmApiClient {
  private readonly ttlMs: number;
  constructor(private readonly o: OsmApiClientOptions) {
    this.ttlMs = o.ttlMs ?? 24 * 3600_000;
  }

  private url(ref: OsmRef, suffix = ''): string {
    return `${this.o.baseUrl}/api/0.6/${ref.type}/${ref.id}${suffix}.json`;
  }

  /** Current state of an element. With `withHistory`, a deletion comes with its date and last tags. */
  async lookup(ref: OsmRef, opts: RequestOptions & { withHistory?: boolean } = {}): Promise<OsmApiLookup> {
    const r = await this.o.http.request<OsmApiResponse>(
      { service: 'osmApi', url: this.url(ref), ttlMs: this.ttlMs, acceptStatus: [404, 410] },
      opts,
    );
    if (r.status === 404) return { status: 'not_found' };
    if (r.status === 410) {
      if (!opts.withHistory) return { status: 'deleted' };
      const history = await this.history(ref, opts);
      const last = history[history.length - 1];
      const before = history.filter((v) => v.visible !== false).pop();
      return {
        status: 'deleted',
        ...(last?.visible === false && last.timestamp ? { deletedAt: last.timestamp } : {}),
        ...(before ? { lastVersion: before } : {}),
      };
    }
    const element = r.data?.elements?.[0];
    return element ? { status: 'present', element } : { status: 'not_found' };
  }

  /** All versions, oldest first. */
  async history(ref: OsmRef, opts: RequestOptions = {}): Promise<OsmElement[]> {
    const r = await this.o.http.request<OsmApiResponse>(
      { service: 'osmApi', url: this.url(ref, '/history'), ttlMs: this.ttlMs, acceptStatus: [404] },
      opts,
    );
    return (r.data?.elements ?? []).slice().sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
  }
}
