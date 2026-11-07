/**
 * Checking an invitation link before any identity exists (first launch, "I received an invitation
 * link"): parse it, read the inviter's index only at the link's address, and check that it lists
 * the link. No key of mine is needed, so the welcome screen can say right away whether the link
 * works; the answer is made once my keys exist (ContactsService.openInvitation runs the same checks
 * again, then answerInvitation).
 */
import { HttpsReadOnlyAdapter, type StorageAdapter } from '@triangulair/storage';
import { checkInvitationIndex, parseInvitationLink } from '@triangulair/crypto';

import { findLink, LinkKindError } from './links';
import { fetchVerifiedIndex } from './port';

export const defaultReadAdapter = (location: string): StorageAdapter => new HttpsReadOnlyAdapter({ baseUrl: location });

export interface CheckedLink {
  link: string;
  owner: string;
  expires: number;
}

export async function checkInvitationText(text: string, opts: { readAdapter?: (location: string) => StorageAdapter; now?: Date } = {}): Promise<CheckedLink> {
  const f = findLink(text);
  if (!f || f.kind !== 'invitation') throw new LinkKindError(f?.kind ?? null, 'invitation');
  const received = parseInvitationLink(f.link, opts.now ? { now: opts.now } : {});
  const index = await fetchVerifiedIndex(opts.readAdapter ?? defaultReadAdapter, received.location, received.owner);
  checkInvitationIndex(received, index, opts.now ? { now: opts.now } : {});
  return { link: f.link, owner: received.owner, expires: Date.parse(received.expires) };
}
