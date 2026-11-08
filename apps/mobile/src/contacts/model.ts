/**
 * Pure rules of the invitation and access screens (no React, no I/O), tested in model.test.ts:
 *
 * - `invitationPhase`: where one of my invitations stands (waiting, answered, several answers,
 *   accepted, accepted with a later answer, expired but still in the 7-day grace, cancelled by a
 *   key change…), from the crypto verdict (`invitationStatus`) and the answers collected;
 * - `answerSet`: the answers to show for one invitation with their warnings (spec "One answer per
 *   invitation", "Late answers"); nothing is ever accepted automatically;
 * - `receiveReducer` / `inviteReducer`: the two flows' state machines;
 * - `keyNotices`: "Marie changed her key", "Marie changed her identity" (the verified mark goes);
 * - share scope ↔ the sync package's `SharePolicy`.
 */
import type { InvitationSkipReason } from '@triangulair/crypto';
import type { SharePolicy } from '@triangulair/sync';

import type { LinkProblem } from './problems';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Answers are opened until 7 days after expiry (crypto INVITATION_ANSWER_GRACE_MS). */
export const ANSWER_GRACE_MS = 7 * DAY_MS;

// ------------------------------------------------------------------ what a contact can see

/** "They see my places": everything I share with friends, only some of my lists, or nothing. */
export type ShareScope = { kind: 'all' } | { kind: 'lists'; lists: string[] } | { kind: 'none' };

export function scopeOf(p: SharePolicy): ShareScope {
  if (p === true) return { kind: 'all' };
  if (p === false) return { kind: 'none' };
  return p.lists.length ? { kind: 'lists', lists: [...p.lists] } : { kind: 'none' };
}

export function policyOf(s: ShareScope): SharePolicy {
  if (s.kind === 'all') return true;
  if (s.kind === 'none' || s.lists.length === 0) return false;
  return { lists: [...new Set(s.lists)].sort() };
}

/** Spec: "choose what they can see (by default: everything I share with friends)". */
export const DEFAULT_SCOPE: ShareScope = { kind: 'all' };

// ------------------------------------------------------------------ my invitations

export type InvitationPhase =
  /** Listed in my index, nobody answered yet. */
  | 'waiting'
  /** One person answered: to review and accept. */
  | 'answered'
  /** Several people answered: none is accepted, I choose (the link may have been forwarded). */
  | 'several'
  /** Accepted; still listed until expiry so that a second answer would be noticed. */
  | 'accepted'
  /** Accepted, and someone else answered too: the first one may have been an impostor. */
  | 'accepted-late'
  /** Expired, nobody accepted; answers made before expiry are still opened for 7 days (flagged). */
  | 'expired'
  /** Created under an older sharing certificate (storage move, key change, declaration of loss). */
  | 'cancelled'
  /** Not listed yet (another device's clock is ahead, or this device has not caught up). */
  | 'not-yet'
  /** Created by a device since declared lost, or a damaged record: never listed. */
  | 'invalid'
  /** More than 7 days after expiry: answers are no longer opened; the record can go. */
  | 'over';

export interface PhaseInput {
  /** `invitationStatus(invitation, myCert, now)`. */
  status: 'listed' | InvitationSkipReason;
  expires: number;
  now: number;
  accepted: string | undefined;
  /** Distinct responders whose answer opened and verified. */
  responders: number;
  /** Responders other than the accepted one. */
  others: number;
}

export function invitationPhase(i: PhaseInput): InvitationPhase {
  if (i.status === 'invalid' || i.status === 'revoked') return 'invalid';
  if (i.now >= i.expires + ANSWER_GRACE_MS) return 'over';
  if (i.accepted !== undefined) return i.others > 0 ? 'accepted-late' : 'accepted';
  if (i.status === 'superseded') return 'cancelled';
  if (i.status === 'not-yet') return 'not-yet';
  if (i.responders > 1) return 'several';
  if (i.responders === 1) return 'answered';
  return i.status === 'expired' || i.now >= i.expires ? 'expired' : 'waiting';
}

/** Phases that still deserve a place in "Pending invitations". */
export function isPending(p: InvitationPhase): boolean {
  return p === 'waiting' || p === 'answered' || p === 'several' || p === 'not-yet' || p === 'accepted-late' || p === 'expired' || p === 'cancelled';
}

/** Phases that need the user (an answer to look at, a warning). */
export function needsAttention(p: InvitationPhase): boolean {
  return p === 'answered' || p === 'several' || p === 'accepted-late';
}

/** Whole days left (rounded up), 0 once expired. */
export function daysLeft(expires: number, now: number): number {
  return expires <= now ? 0 : Math.ceil((expires - now) / DAY_MS);
}

// ------------------------------------------------------------------ answers

export interface AnswerInput {
  owner: string;
  created: number;
  openedAfterExpiry: boolean;
  /** Certified read address of the responder (absent when they have no storage yet). */
  location: string | undefined;
}

export type AnswerWarning =
  /** Several people answered and none is accepted: the link may have been forwarded or intercepted. */
  | 'several'
  /** Someone else answered after I accepted a first answer: that one may have been an impostor. */
  | 'late-after-accept'
  /** The answer was opened after the invitation expired: never granted without asking. */
  | 'after-expiry'
  /** No read address: their device cannot be checked against their own index (safety code). */
  | 'uncheckable';

export interface AnswerRow extends AnswerInput {
  accepted: boolean;
  warnings: AnswerWarning[];
  /** Accepting needs a second confirmation (late, several, or after expiry). */
  confirm: boolean;
}

export interface AnswerSetView {
  rows: AnswerRow[];
  /** Warnings about the invitation as a whole (shown on top). */
  warnings: AnswerWarning[];
  rejected: number;
}

/** The answers of one invitation, as the screen shows them. Nothing here accepts anything. */
export function answerSet(answers: readonly AnswerInput[], accepted: string | undefined, rejected = 0): AnswerSetView {
  const several = accepted === undefined && answers.length > 1;
  const late = accepted !== undefined && answers.some((a) => a.owner !== accepted);
  const rows = answers
    .map((a): AnswerRow => {
      const isAccepted = a.owner === accepted;
      const w: AnswerWarning[] = [];
      if (several) w.push('several');
      if (!isAccepted && accepted !== undefined) w.push('late-after-accept');
      if (a.openedAfterExpiry) w.push('after-expiry');
      if (a.location === undefined) w.push('uncheckable');
      return { ...a, accepted: isAccepted, warnings: w, confirm: !isAccepted && (several || accepted !== undefined || a.openedAfterExpiry) };
    })
    // Accepted first, then by arrival (created).
    .sort((x, y) => Number(y.accepted) - Number(x.accepted) || x.created - y.created);
  const warnings: AnswerWarning[] = [];
  if (several) warnings.push('several');
  if (late) warnings.push('late-after-accept');
  if (rows.some((r) => r.openedAfterExpiry && !r.accepted)) warnings.push('after-expiry');
  return { rows, warnings, rejected };
}

// ------------------------------------------------------------------ the invitee's flow

export interface OpenedSummary {
  owner: string;
  expires: number;
  /** I already know this person (the link never resets what the app knows about them). */
  known: boolean;
}

export type ReceiveState =
  | { step: 'idle' }
  | { step: 'checking'; link: string }
  | { step: 'problem'; link: string; problem: LinkProblem }
  | { step: 'verified'; link: string; opened: OpenedSummary }
  | { step: 'answering'; link: string; opened: OpenedSummary }
  | { step: 'answered'; link: string; opened: OpenedSummary; returnLink: string };

export type ReceiveEvent =
  | { type: 'submit'; link: string }
  | { type: 'checked'; opened: OpenedSummary }
  | { type: 'failed'; problem: LinkProblem }
  | { type: 'answer' }
  | { type: 'answered'; returnLink: string }
  | { type: 'reset' };

export function receiveReducer(s: ReceiveState, e: ReceiveEvent): ReceiveState {
  switch (e.type) {
    case 'reset':
      return { step: 'idle' };
    case 'submit':
      return s.step === 'checking' || s.step === 'answering' ? s : { step: 'checking', link: e.link };
    case 'checked':
      return s.step === 'checking' ? { step: 'verified', link: s.link, opened: e.opened } : s;
    case 'failed':
      if (s.step === 'checking') return { step: 'problem', link: s.link, problem: e.problem };
      // A failed answer goes back to the verified step (retry), with the problem kept by the screen.
      if (s.step === 'answering') return { step: 'verified', link: s.link, opened: s.opened };
      return s;
    case 'answer':
      return s.step === 'verified' ? { step: 'answering', link: s.link, opened: s.opened } : s;
    case 'answered':
      return s.step === 'answering' ? { step: 'answered', link: s.link, opened: s.opened, returnLink: e.returnLink } : s;
  }
}

// ------------------------------------------------------------------ the inviter's flow

export type InviteState =
  | { step: 'idle' }
  | { step: 'creating' }
  | { step: 'ready'; id: string; link: string; expires: number }
  | { step: 'problem'; problem: LinkProblem };

export type InviteEvent =
  | { type: 'create' }
  | { type: 'created'; id: string; link: string; expires: number }
  | { type: 'failed'; problem: LinkProblem }
  | { type: 'reset' };

export function inviteReducer(s: InviteState, e: InviteEvent): InviteState {
  switch (e.type) {
    case 'reset':
      return { step: 'idle' };
    case 'create':
      return s.step === 'creating' ? s : { step: 'creating' };
    case 'created':
      return s.step === 'creating' ? { step: 'ready', id: e.id, link: e.link, expires: e.expires } : s;
    case 'failed':
      return s.step === 'creating' ? { step: 'problem', problem: e.problem } : s;
  }
}

// ------------------------------------------------------------------ key changes

export interface KeySnapshot {
  /** Sharing-certificate rotation last seen per contact. */
  rotations: Record<string, number>;
}

export type KeyNoticeKind = 'key-changed' | 'identity-moved';

export interface KeyNotice {
  owner: string;
  kind: KeyNoticeKind;
  /** When the app noticed it (ms). */
  at: number;
}

/**
 * Compares what I knew about each contact with what the vault holds now: a higher rotation is
 * "Marie changed her key" (a declaration of loss, a storage move: accepted automatically, spec
 * "Loss and theft"); an identity that moved away (`retired`) is "Marie changed her identity", and
 * its verified mark must be removed. First sight of a contact is not a change.
 */
export function keyNotices(
  prev: KeySnapshot,
  contacts: readonly { owner: string; rotation: number }[],
  retired: readonly string[],
  now: number,
): { notices: KeyNotice[]; next: KeySnapshot } {
  const notices: KeyNotice[] = [];
  const rotations: Record<string, number> = { ...prev.rotations };
  for (const c of contacts) {
    const before = prev.rotations[c.owner];
    if (before !== undefined && c.rotation > before) notices.push({ owner: c.owner, kind: 'key-changed', at: now });
    rotations[c.owner] = Math.max(before ?? c.rotation, c.rotation);
  }
  for (const owner of retired) {
    if (prev.rotations[owner] !== undefined) {
      notices.push({ owner, kind: 'identity-moved', at: now });
      delete rotations[owner];
    }
  }
  return { notices, next: { rotations } };
}

/** Groups of the 60-digit safety code, as rows of `perRow` (4 × 3 on phones, 6 × 2 on tablets). */
export function safetyRows(groups: readonly string[], perRow: number): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < groups.length; i += perRow) rows.push(groups.slice(i, i + perRow));
  return rows;
}
