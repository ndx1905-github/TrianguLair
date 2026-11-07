/**
 * The links that travel between people (spec "Invitation link and return link"):
 *
 * - invitation link: `https://triangulair.app/i#<fragment>`, the crypto package's link version 5
 *   (docs/format/invitation-link.md), at most 200 characters for a read address up to 80;
 * - return link: `https://triangulair.app/r#<b64url of the return-link bytes>` (response
 *   version 4, docs/format/return-link.md). The bytes are the frozen format; the `/r#` wrapper is
 *   this app's (the format leaves the transport open), so the deep link opens the right screen;
 * - list link: `https://triangulair.app/l#…` is reserved for link-only lists (T-212).
 *
 * Everything after `#` is a URL fragment: never sent to a server, also when the link is opened in
 * a browser. People paste whole messages ("Marie invites you… https://…"), so `findLink` looks
 * for the link inside any text, and accepts the app scheme (`triangulair://i#…`) that some
 * messaging apps produce when a link is opened in the app.
 */
import { fromB64Url, toB64Url } from '@triangulair/crypto';

export const LINK_ORIGIN = 'https://triangulair.app';
export const INVITE_PREFIX = `${LINK_ORIGIN}/i#`;
export const RETURN_PREFIX = `${LINK_ORIGIN}/r#`;
export const LIST_PREFIX = `${LINK_ORIGIN}/l#`;

/** Spec: the invitation link stays under 200 characters for a read address up to 80 (QR version ≤ 10). */
export const MAX_INVITE_LINK_CHARS = 200;
/** Same bound as the crypto package (MAX_RESPONSE_BYTES = 9,600 bytes), in base64url characters. */
export const MAX_RETURN_FRAGMENT_CHARS = 12_800;

export type LinkKind = 'invitation' | 'return' | 'list';

export interface FoundLink {
  kind: LinkKind;
  /** Canonical `https://triangulair.app/<k>#<fragment>` form. */
  link: string;
  fragment: string;
}

const KIND_OF: Record<string, LinkKind> = { i: 'invitation', r: 'return', l: 'list' };
const PREFIX_OF: Record<LinkKind, string> = { invitation: INVITE_PREFIX, return: RETURN_PREFIX, list: LIST_PREFIX };
const B64U = /^[A-Za-z0-9_-]+$/;
// https://triangulair.app/i#…, triangulair://i#…, triangulair:///i#… (with or without "www.").
const LINK_RE = /(?:https?:\/\/(?:www\.)?triangulair\.app\/|triangulair:\/\/\/?)([irl])\/?#([A-Za-z0-9_-]+)/i;

export function buildInvitationLink(fragment: string): string {
  if (!B64U.test(fragment)) throw new Error('invitation fragment: base64url expected');
  return INVITE_PREFIX + fragment;
}

export function buildReturnLink(bytes: Uint8Array): string {
  return RETURN_PREFIX + toB64Url(bytes);
}

/**
 * The first TrianguLair link in `text` (a pasted message, a scanned QR code, a deep link), or
 * null. The fragment is cut at the first character outside base64url (a message may go on right
 * after the link).
 */
export function findLink(text: string): FoundLink | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m = LINK_RE.exec(text.length > 40_000 ? text.slice(0, 40_000) : text);
  if (!m) return null;
  const kind = KIND_OF[m[1]!.toLowerCase()]!;
  const fragment = m[2]!;
  return { kind, fragment, link: PREFIX_OF[kind] + fragment };
}

/** The bytes of a return link (any text holding one); throws on another kind or an oversized one. */
export function returnLinkBytes(text: string): Uint8Array {
  const f = findLink(text);
  if (!f || f.kind !== 'return') throw new LinkKindError(f?.kind ?? null, 'return');
  if (f.fragment.length > MAX_RETURN_FRAGMENT_CHARS) throw new LinkKindError('return', 'return', 'too-long');
  return fromB64Url(f.fragment, 'return link');
}

/** A link of another kind than the screen expects (an invitation pasted where an answer goes…). */
export class LinkKindError extends Error {
  constructor(
    readonly found: LinkKind | null,
    readonly expected: LinkKind,
    readonly reason: 'kind' | 'too-long' = 'kind',
  ) {
    super(`expected a ${expected} link, found ${found ?? 'none'}`);
    this.name = 'LinkKindError';
  }
}

/** The text proposed in the share sheet: a sentence, then the link alone on its line (easy to copy). */
export function shareMessage(sentence: string, link: string): string {
  return `${sentence}\n${link}`;
}
