import { utf8 } from './encoding';
import { FormatError } from './errors';

/** Longest accepted read address, in UTF-8 bytes. */
export const MAX_LOCATION = 512;

function isLocalIPv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** The 8 hextets of a WHATWG-serialized IPv6 literal (compressed, lowercase, no dotted IPv4), or null. */
function hextets(h: string): number[] | null {
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = parse(halves[0] as string);
  const tail = halves.length === 2 ? parse(halves[1] as string) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const out = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return out.some((x) => !Number.isFinite(x)) ? null : out;
}

function isLocalIPv6(h: string): boolean {
  const x = hextets(h);
  if (!x) return true; // unparseable: refuse
  const [x0, x1, x2, x3, x4, x5, x6, x7] = x as [number, number, number, number, number, number, number, number];
  const v4 = (hi: number, _lo: number) => isLocalIPv4(hi >> 8, hi & 0xff);
  // ::/96 (unspecified, loopback, deprecated IPv4-compatible): never a public storage.
  if (x0 === 0 && x1 === 0 && x2 === 0 && x3 === 0 && x4 === 0 && x5 === 0) return true;
  // ::ffff:0:0/96 IPv4-mapped.
  if (x0 === 0 && x1 === 0 && x2 === 0 && x3 === 0 && x4 === 0 && x5 === 0xffff) return v4(x6, x7);
  // 64:ff9b::/96 NAT64 well-known prefix (RFC 6052): apply the IPv4 rules to the embedded address.
  if (x0 === 0x64 && x1 === 0xff9b && x2 === 0 && x3 === 0 && x4 === 0 && x5 === 0) return v4(x6, x7);
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215).
  if (x0 === 0x64 && x1 === 0xff9b && x2 === 1) return true;
  // 2002::/16 6to4: IPv4 address in hextets 1-2.
  if (x0 === 0x2002) return v4(x1, x2);
  // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
  return (x0 & 0xffc0) === 0xfe80 || (x0 & 0xfe00) === 0xfc00 || (x0 & 0xff00) === 0xff00;
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.startsWith('[')) return isLocalIPv6(host.slice(1, -1));
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  return m ? isLocalIPv4(Number(m[1]), Number(m[2])) : false;
}

/**
 * Read address check: https only, canonical WHATWG form (`new URL(l).href === l`, so no backslash
 * or other parser-dependent spelling), no credentials, no fragment, at most 512 bytes, and no
 * local-network host (localhost, *.local, *.internal, loopback / private / link-local / CGNAT /
 * multicast IP literals, including IPv4 addresses embedded in IPv6 literals: mapped, NAT64, 6to4):
 * the app fetches this address (R-10, V3-09). The HTTP layer must still refuse public names that
 * resolve to private addresses (DNS rebinding).
 */
export function checkLocation(location: string, what = 'location'): void {
  const bad = () =>
    new FormatError(`${what}: must be a canonical https:// URL on a public host, without credentials or fragment (max ${MAX_LOCATION} bytes)`);
  if (typeof location !== 'string' || utf8(location).length > MAX_LOCATION || !location.startsWith('https://')) throw bad();
  if (/[\s\u0000-\u001f\u007f#\\]/.test(location)) throw bad();
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    throw bad();
  }
  if (u.href !== location || u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hostname === '') throw bad();
  if (isLocalHost(u.hostname)) throw bad();
}
