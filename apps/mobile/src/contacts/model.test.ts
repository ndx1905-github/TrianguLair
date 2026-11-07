import { describe, expect, it } from 'vitest';

import { cleanName, parseLocal, parseReceived } from './local';
import {
  answerSet,
  ANSWER_GRACE_MS,
  DAY_MS,
  daysLeft,
  invitationPhase,
  inviteReducer,
  isPending,
  keyNotices,
  needsAttention,
  policyOf,
  receiveReducer,
  safetyRows,
  scopeOf,
  type PhaseInput,
  type ReceiveState,
} from './model';

const T0 = Date.parse('2026-10-23T16:30:00Z');
const base: PhaseInput = { status: 'listed', expires: T0 + 7 * DAY_MS, now: T0, accepted: undefined, responders: 0, others: 0 };

describe('invitation phase', () => {
  it('follows the life of an invitation', () => {
    expect(invitationPhase(base)).toBe('waiting');
    expect(invitationPhase({ ...base, responders: 1 })).toBe('answered');
    expect(invitationPhase({ ...base, responders: 2 })).toBe('several');
    expect(invitationPhase({ ...base, responders: 1, accepted: 'ed25519:b' })).toBe('accepted');
    expect(invitationPhase({ ...base, responders: 2, others: 1, accepted: 'ed25519:b' })).toBe('accepted-late');
    // Expired, nobody accepted: the grace period keeps answers coming (flagged).
    expect(invitationPhase({ ...base, status: 'expired', now: base.expires + DAY_MS })).toBe('expired');
    expect(invitationPhase({ ...base, status: 'expired', now: base.expires + DAY_MS, responders: 1 })).toBe('answered');
    expect(invitationPhase({ ...base, status: 'expired', now: base.expires + ANSWER_GRACE_MS })).toBe('over');
  });

  it('a key change cancels it; a lost device makes it invalid', () => {
    expect(invitationPhase({ ...base, status: 'superseded' })).toBe('cancelled');
    expect(invitationPhase({ ...base, status: 'superseded', accepted: 'ed25519:b', responders: 1 })).toBe('accepted');
    expect(invitationPhase({ ...base, status: 'revoked' })).toBe('invalid');
    expect(invitationPhase({ ...base, status: 'invalid' })).toBe('invalid');
    expect(invitationPhase({ ...base, status: 'not-yet' })).toBe('not-yet');
  });

  it('pending and attention', () => {
    expect(isPending('waiting')).toBe(true);
    expect(isPending('accepted')).toBe(false);
    expect(isPending('over')).toBe(false);
    expect(needsAttention('several')).toBe(true);
    expect(needsAttention('waiting')).toBe(false);
    expect(daysLeft(T0 + 7 * DAY_MS, T0)).toBe(7);
    expect(daysLeft(T0 + 1, T0)).toBe(1);
    expect(daysLeft(T0, T0)).toBe(0);
  });
});

describe('answers', () => {
  const a = { owner: 'ed25519:a', created: T0 + 1000, openedAfterExpiry: false, location: 'https://a.example/' };
  const b = { owner: 'ed25519:b', created: T0 + 2000, openedAfterExpiry: false, location: undefined };

  it('one answer: no warning, no extra confirmation', () => {
    const s = answerSet([a], undefined);
    expect(s.warnings).toEqual([]);
    expect(s.rows[0]).toMatchObject({ accepted: false, confirm: false, warnings: [] });
  });

  it('several answers: none accepted, all shown with a warning, each needs a confirmation', () => {
    const s = answerSet([b, a], undefined, 1);
    expect(s.warnings).toEqual(['several']);
    expect(s.rows.map((r) => r.owner)).toEqual(['ed25519:a', 'ed25519:b']);
    expect(s.rows.every((r) => r.confirm && r.warnings.includes('several'))).toBe(true);
    expect(s.rows[1]!.warnings).toContain('uncheckable');
    expect(s.rejected).toBe(1);
  });

  it('a second person after acceptance: the first may have been an impostor', () => {
    const s = answerSet([a, b], 'ed25519:b');
    expect(s.warnings).toEqual(['late-after-accept']);
    expect(s.rows[0]).toMatchObject({ owner: 'ed25519:b', accepted: true, confirm: false });
    expect(s.rows[1]).toMatchObject({ owner: 'ed25519:a', confirm: true, warnings: ['late-after-accept'] });
  });

  it('opened after expiry: flagged and never accepted without asking, even alone', () => {
    const s = answerSet([{ ...a, openedAfterExpiry: true }], undefined);
    expect(s.warnings).toEqual(['after-expiry']);
    expect(s.rows[0]).toMatchObject({ confirm: true, warnings: ['after-expiry'] });
  });
});

describe('flows', () => {
  it('receive: check, answer, done; a problem can be retried with another link', () => {
    let s: ReceiveState = { step: 'idle' };
    s = receiveReducer(s, { type: 'submit', link: 'L1' });
    expect(s).toEqual({ step: 'checking', link: 'L1' });
    expect(receiveReducer(s, { type: 'submit', link: 'L2' })).toBe(s); // one check at a time
    const failed = receiveReducer(s, { type: 'failed', problem: 'no-longer-works' });
    expect(failed).toEqual({ step: 'problem', link: 'L1', problem: 'no-longer-works' });
    expect(receiveReducer(failed, { type: 'submit', link: 'L2' }).step).toBe('checking');
    const opened = { owner: 'ed25519:m', expires: T0, known: false };
    s = receiveReducer(s, { type: 'checked', opened });
    expect(s.step).toBe('verified');
    expect(receiveReducer(s, { type: 'answered', returnLink: 'R' })).toBe(s); // not answering yet
    s = receiveReducer(s, { type: 'answer' });
    expect(receiveReducer(s, { type: 'failed', problem: 'unreachable' }).step).toBe('verified');
    s = receiveReducer(s, { type: 'answered', returnLink: 'R' });
    expect(s).toEqual({ step: 'answered', link: 'L1', opened, returnLink: 'R' });
    expect(receiveReducer(s, { type: 'reset' })).toEqual({ step: 'idle' });
  });

  it('invite: create once, ready or problem', () => {
    let s = inviteReducer({ step: 'idle' }, { type: 'create' });
    expect(inviteReducer(s, { type: 'create' })).toBe(s);
    expect(inviteReducer(s, { type: 'failed', problem: 'publish-failed' })).toEqual({ step: 'problem', problem: 'publish-failed' });
    s = inviteReducer(s, { type: 'created', id: 'x', link: 'L', expires: 1 });
    expect(s).toEqual({ step: 'ready', id: 'x', link: 'L', expires: 1 });
    expect(inviteReducer(s, { type: 'failed', problem: 'unknown' })).toBe(s);
  });
});

describe('key notices', () => {
  it('first sight is not a change; a higher rotation is; a moved identity drops its mark', () => {
    let r = keyNotices({ rotations: {} }, [{ owner: 'm', rotation: 1 }], [], T0);
    expect(r.notices).toEqual([]);
    r = keyNotices(r.next, [{ owner: 'm', rotation: 1 }], [], T0);
    expect(r.notices).toEqual([]);
    r = keyNotices(r.next, [{ owner: 'm', rotation: 2 }], [], T0);
    expect(r.notices).toEqual([{ owner: 'm', kind: 'key-changed', at: T0 }]);
    r = keyNotices(r.next, [], ['m', 'never-known'], T0);
    expect(r.notices).toEqual([{ owner: 'm', kind: 'identity-moved', at: T0 }]);
    expect(r.next.rotations).toEqual({});
  });
});

describe('share scope and local values', () => {
  it('maps to the sync package policy and back', () => {
    expect(policyOf({ kind: 'all' })).toBe(true);
    expect(policyOf({ kind: 'none' })).toBe(false);
    expect(policyOf({ kind: 'lists', lists: ['b', 'a', 'a'] })).toEqual({ lists: ['a', 'b'] });
    expect(policyOf({ kind: 'lists', lists: [] })).toBe(false);
    expect(scopeOf(true)).toEqual({ kind: 'all' });
    expect(scopeOf({ lists: [] })).toEqual({ kind: 'none' });
    expect(scopeOf({ lists: ['x'] })).toEqual({ kind: 'lists', lists: ['x'] });
  });

  it('parses the device values defensively', () => {
    expect(parseLocal(null).names).toEqual({});
    expect(parseLocal('{oops').v).toBe(1);
    const s = parseLocal(JSON.stringify({ v: 1, names: { a: 'Léa', b: 3 }, verified: { a: true, b: 'yes' }, labels: { i: { name: 'Paul', faceToFace: true }, j: 4 }, keys: { rotations: { a: 2, b: -1 } }, notices: [{ owner: 'a', kind: 'key-changed', at: 1 }, { owner: 'b', kind: 'x', at: 1 }] }));
    expect(s).toEqual({ v: 1, names: { a: 'Léa' }, verified: { a: true }, labels: { i: { name: 'Paul', faceToFace: true } }, keys: { rotations: { a: 2 } }, notices: [{ owner: 'a', kind: 'key-changed', at: 1 }] });
    expect(parseReceived(JSON.stringify([{ link: 'l', owner: 'o', expires: T0 + 1 }, { link: 'old', owner: 'o', expires: T0 - 1 }, 3]), T0)).toEqual([{ link: 'l', owner: 'o', expires: T0 + 1 }]);
    expect(cleanName('  Léa‮ \n Martin  ')).toBe('Léa Martin');
    expect(safetyRows(['1', '2', '3', '4', '5'], 2)).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });
});
