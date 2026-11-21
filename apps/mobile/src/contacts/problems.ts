/**
 * What went wrong with a link, in the user's words (spec "Error cases": "This link no longer
 * works", with a suggestion to ask for a new link). Crypto error codes stay local: they are never
 * shown or sent to anyone (packages/crypto errors.ts), only mapped to one of these kinds.
 */
import { TLCryptoError } from '@triangulair/crypto';
import { NetworkError, NotFound, StorageError, TooLarge } from '@triangulair/storage';

import { LinkKindError } from './links';
import { IndexMissingError, PublishError } from './port';

export type LinkProblem =
  /** Not a TrianguLair link at all, or damaged (truncated when copied). */
  | 'malformed'
  /** An invitation pasted where an answer was expected, or the reverse. */
  | 'wrong-kind'
  /** Past its expiry (invitation), or answers are no longer opened (7 days after it). */
  | 'expired'
  /** The owner's index does not list it: cancelled, withdrawn, cancelled by a key change, or forged. */
  | 'no-longer-works'
  /** Signed by another key than the link names, or by a device declared lost. */
  | 'not-genuine'
  /** The owner's storage did not answer (network, server down, no index yet). */
  | 'unreachable'
  /** Made by a newer version of the app. */
  | 'update-app'
  /** An answer that is not for any of my open invitations. */
  | 'not-mine'
  /** An older index than one already seen (rollback). */
  | 'stale'
  /** My own link (I opened my invitation, or my own answer). */
  | 'own-link'
  /** From someone I blocked (gap #6): refused. */
  | 'blocked'
  /** Inviting needs a storage (an index to vouch for the link). */
  | 'needs-storage'
  /** My storage refused or did not take the publication. */
  | 'publish-failed'
  | 'unknown';

export function linkProblemOf(e: unknown): LinkProblem {
  if (e instanceof LinkProblemError) return e.problem;
  if (e instanceof PublishError) return 'publish-failed';
  if (e instanceof IndexMissingError) return 'unreachable';
  if (e instanceof LinkKindError) return e.reason === 'too-long' ? 'malformed' : e.found === null ? 'malformed' : 'wrong-kind';
  if (e instanceof TLCryptoError) {
    switch (e.code) {
      case 'EXPIRED':
        return 'expired';
      case 'NOT_LISTED':
        return 'no-longer-works';
      case 'OWNER_MISMATCH':
      case 'REVOKED':
      case 'SIGNATURE':
      case 'IDENTITY_MOVED':
        return 'not-genuine';
      case 'UNSUPPORTED_VERSION':
        return 'update-app';
      case 'ROLLBACK':
        return 'stale';
      case 'DECRYPT':
      case 'NO_MATCHING_KEY':
        return 'not-mine';
      case 'FORMAT':
      case 'INVALID_KEY':
        return 'malformed';
      default:
        return 'unknown';
    }
  }
  if (e instanceof NotFound || e instanceof NetworkError || e instanceof TooLarge) return 'unreachable';
  if (e instanceof StorageError) return 'unreachable';
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return 'unreachable';
  return 'unknown';
}

/** Thrown by the contacts service for problems it detects itself. */
export class LinkProblemError extends Error {
  constructor(readonly problem: LinkProblem, message?: string) {
    super(message ?? problem);
    this.name = 'LinkProblemError';
  }
}

/** Problems the user can fix by retrying later (versus asking for a new link). */
export function isRetryable(p: LinkProblem): boolean {
  return p === 'unreachable' || p === 'publish-failed' || p === 'unknown';
}
