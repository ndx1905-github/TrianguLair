/**
 * ContactsService: the invitation and access flows of T-208 / T-209, over a `SyncPort` (the sync
 * engine) and a few device-local values (names, verified marks, see local.ts). The screens only
 * talk to this interface; the SyncProvider integration is `engineSyncPort` (port.ts).
 *
 * Inviter: createInvitation (publishes the index that lists it BEFORE the link is handed out) →
 * pending list → receiveAnswer (a return link, any text holding one) → answers (warnings: several,
 * late after acceptance, opened after expiry, no address to check) → acceptAnswer (choose what
 * they see; the invitation stops being a recipient and the packs are re-sealed with new pack keys
 * at the publication that follows).
 *
 * Invitee: openInvitation (reads the inviter's index only at the link's address, checks that it
 * lists the link: `checkInvitationIndex`) → answerInvitation (device-signed return link; the
 * inviter becomes a contact I follow, read with the invitation key until my answer is accepted).
 *
 * Contacts: the two switches ("I see their places", "they see my places" with all / some lists /
 * nothing), the safety code (12 × 5 digits or QR) with a local "I compared it" mark, removal
 * (wraps gone and pack keys renewed at the next publication), key-change notices.
 */
import {
  checkInvitationIndex,
  collectInvitationAnswers,
  createInvitation as cryptoCreateInvitation,
  createInvitationResponse,
  ExpiredError,
  indexAnchor,
  invitationFromRecord,
  invitationRecord,
  invitationStatus,
  matchSafetyQr,
  openInvitationResponse,
  parseInvitationLink,
  safetyCode,
  safetyQrPayload,
  type InvitationResponse,
  type KeyPair,
  type OwnerInvitation,
  type ReceivedInvitation as CryptoReceived,
  type SignedIndex,
  type VaultContact,
  type VaultRecords,
} from '@triangulair/crypto';

import { buildInvitationLink, buildReturnLink, findLink, LinkKindError, returnLinkBytes } from './links';
import { cleanName, LocalContacts, parseReceived, type LocalKV, type ReceivedInvitation, type SecretKV } from './local';
import {
  answerSet,
  invitationPhase,
  keyNotices,
  policyOf,
  scopeOf,
  type AnswerSetView,
  type InvitationPhase,
  type KeyNotice,
  type OpenedSummary,
  type ShareScope,
} from './model';
import { LinkProblemError } from './problems';
import type { SyncPort } from './port';

const MAX_ANSWERS = 16;

export interface ContactView {
  owner: string;
  /** The name I gave them ('' if none yet). */
  name: string;
  /** "I compared the safety code" (this device only). */
  verified: boolean;
  /** They publish (a certified read address): their index can be checked and their places read. */
  checkable: boolean;
  /** "I see their places". */
  follow: boolean;
  /** "They see my places". */
  share: ShareScope;
  rotation: number;
  lastSuccess: number | null;
}

export interface InvitationView {
  id: string;
  name: string;
  created: number;
  expires: number;
  phase: InvitationPhase;
  responders: number;
  accepted?: string;
  faceToFace: boolean;
}

export interface AnswerDetail extends AnswerSetView {
  invitation: InvitationView;
  /** Per responder: safety code groups (to compare with them). */
  safety: Record<string, string[]>;
  /** Suggested names: the invitation's name, or the one already given to a known person. */
  names: Record<string, string>;
  /** Responders already in my contacts. */
  known: Record<string, boolean>;
}

export interface OpenedInvitation extends OpenedSummary {
  /** Handle for answerInvitation (the token of the link). */
  token: string;
  /** Safety code between us (12 × 5 digits). */
  safety: string[];
  /** Name I already gave them, if known. */
  name: string;
  faceToFace: boolean;
}

export interface AcceptChoice {
  name: string;
  share: ShareScope;
  follow: boolean;
  /** Face to face, or after comparing the safety code. */
  verified?: boolean;
}

export interface AnswerChoice {
  name: string;
  /** Let them see my places too (needs a storage). */
  shareBack: boolean;
  verified?: boolean;
}

export interface ContactsService {
  readonly owner: string;
  /** A storage is connected: inviting is possible. */
  canInvite(): boolean;
  subscribe(listener: () => void): () => void;
  /** Bumped after every change (for React memoization). */
  version(): number;

  // Inviter.
  createInvitation(opts?: { name?: string; faceToFace?: boolean }): Promise<{ id: string; link: string; expires: number }>;
  invitations(): InvitationView[];
  cancelInvitation(id: string): Promise<void>;
  receiveAnswer(text: string, opts?: { faceToFace?: boolean }): Promise<{ invitationId: string; responder: string }>;
  answers(invitationId: string): AnswerDetail | null;
  acceptAnswer(invitationId: string, responder: string, choice: AcceptChoice): Promise<void>;
  /** The responder whose answer was scanned face to face for this invitation (verified automatically). */
  faceToFaceOwner(invitationId: string): string | undefined;

  // Invitee.
  openInvitation(text: string, opts?: { faceToFace?: boolean }): Promise<OpenedInvitation>;
  answerInvitation(token: string, choice: AnswerChoice): Promise<{ link: string }>;
  /** Invitation keys that still read `owner`'s places (until my answer is accepted or the link expires). */
  invitationKeysFor(owner: string): KeyPair[];
  /** The name I gave an invitation of mine (for the sync's "Your pending invitations were cancelled"). */
  invitationName(id: string): string | undefined;

  // Contacts.
  contacts(): ContactView[];
  contact(owner: string): ContactView | undefined;
  rename(owner: string, name: string): void;
  setFollow(owner: string, on: boolean): Promise<void>;
  setShare(owner: string, scope: ShareScope): Promise<void>;
  setVerified(owner: string, on: boolean): void;
  removeContact(owner: string): Promise<void>;
  safetyCode(owner: string): string[];
  safetyQr(owner: string): string;
  matchSafetyQr(owner: string, scanned: string): boolean;
  notices(): KeyNotice[];
  dismissNotice(owner: string): void;
  /** Re-reads the vault for key changes (call on focus and after a sync pass). */
  refresh(): void;
  /** The vault changed outside the service (a sync pass): re-render the screens. */
  changed(): void;
}

export interface ContactsServiceOptions {
  port: SyncPort;
  local: LocalKV;
  secrets: SecretKV;
  now?: () => number;
  /** A contact got a name (people table, so their places show it). */
  onName?: (owner: string, name: string) => void;
}

/** Loads the received invitations from the secret store, then builds the service. */
export async function createContactsService(o: ContactsServiceOptions): Promise<ContactsService> {
  const now = o.now ?? (() => Date.now());
  const received = parseReceived(await o.secrets.get('invitations-received'), now());
  return new Service(o, received, now);
}

/**
 * The invitation keys of links I answered that still read `owner`'s places (not expired). Also used
 * by the SyncProvider straight from the secret store (`invitations-received`), so that every pass
 * reads with them, even before this service exists.
 */
export function receivedKeysFor(received: readonly ReceivedInvitation[], owner: string, now: number): KeyPair[] {
  const out: KeyPair[] = [];
  for (const r of received) {
    if (r.owner !== owner || r.expires <= now) continue;
    try {
      out.push(parseInvitationLink(r.link, { now: new Date(now) }).keyPair);
    } catch {
      // Expired or damaged: dropped at the next save.
    }
  }
  return out;
}

/** Opened invitations waiting for an answer (memory only: the confirmed object is needed). */
interface Pending {
  received: CryptoReceived;
  index: SignedIndex;
  link: string;
  faceToFace: boolean;
}

class Service implements ContactsService {
  private readonly local: LocalContacts;
  private readonly listeners = new Set<() => void>();
  private v = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly o: ContactsServiceOptions,
    private received: ReceivedInvitation[],
    private readonly now: () => number,
  ) {
    this.local = new LocalContacts(o.local);
    this.refresh();
  }

  private get port(): SyncPort {
    return this.o.port;
  }

  get owner(): string {
    return this.port.owner;
  }

  canInvite(): boolean {
    return this.port.canPublish();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  version(): number {
    return this.v;
  }

  private emit(): void {
    this.v++;
    for (const l of [...this.listeners]) l();
  }

  private date(): Date {
    return new Date(this.now());
  }

  private name(owner: string): string {
    return this.local.state.names[owner] ?? '';
  }

  private setName(owner: string, name: string): void {
    const n = cleanName(name);
    if (!n) return;
    this.local.update((s) => {
      s.names[owner] = n;
    });
    this.o.onName?.(owner, n);
  }

  // ------------------------------------------------------------------ inviter

  async createInvitation(opts: { name?: string; faceToFace?: boolean } = {}): Promise<{ id: string; link: string; expires: number }> {
    if (!this.port.canPublish()) throw new LinkProblemError('needs-storage');
    const { invitation, fragment } = cryptoCreateInvitation(this.port.device(), this.port.sharingCert(), { now: this.date() });
    this.port.addInvitation(invitation);
    try {
      // Spec: the index that lists the invitation is published before the link is shared.
      await this.port.publish();
    } catch (e) {
      this.dropInvitation(invitation.id);
      throw e;
    }
    this.local.update((s) => {
      s.labels[invitation.id] = { name: cleanName(opts.name ?? ''), ...(opts.faceToFace && { faceToFace: true }) };
    });
    this.emit();
    return { id: invitation.id, link: buildInvitationLink(fragment), expires: Date.parse(invitation.expires) };
  }

  private records(): VaultRecords {
    return this.port.records();
  }

  private opened(): { invitation: OwnerInvitation; answers: Uint8Array[]; accepted?: string }[] {
    const out: { invitation: OwnerInvitation; answers: Uint8Array[]; accepted?: string }[] = [];
    for (const rec of this.records().invitations) {
      try {
        out.push(invitationFromRecord(rec, this.owner));
      } catch {
        // Invalid record (planted, damaged): never listed by signIndex, not shown.
      }
    }
    return out;
  }

  private collect(x: { invitation: OwnerInvitation; answers: Uint8Array[]; accepted?: string }): { answers: InvitationResponse[]; rejected: number; over: boolean } {
    try {
      const r = collectInvitationAnswers(x.invitation, x.answers, { now: this.date(), ...(x.accepted !== undefined && { acceptedOwner: x.accepted }) });
      return { answers: r.answers, rejected: r.rejected, over: false };
    } catch (e) {
      if (e instanceof ExpiredError) return { answers: [], rejected: 0, over: true };
      return { answers: [], rejected: x.answers.length, over: false };
    }
  }

  private view(x: { invitation: OwnerInvitation; answers: Uint8Array[]; accepted?: string }, answers: InvitationResponse[]): InvitationView {
    const inv = x.invitation;
    const label = this.local.state.labels[inv.id];
    let status: ReturnType<typeof invitationStatus>;
    try {
      status = invitationStatus(inv, this.port.sharingCert(), this.date());
    } catch {
      status = 'invalid';
    }
    const expires = Date.parse(inv.expires);
    const others = answers.filter((a) => a.owner !== x.accepted).length;
    const phase = invitationPhase({ status, expires, now: this.now(), accepted: x.accepted, responders: answers.length, others });
    return {
      id: inv.id,
      name: label?.name ?? '',
      created: Date.parse(inv.created),
      expires,
      phase,
      responders: answers.length,
      ...(x.accepted !== undefined && { accepted: x.accepted }),
      faceToFace: !!label?.faceToFace,
    };
  }

  invitations(): InvitationView[] {
    return this.opened()
      .map((x) => this.view(x, this.collect(x).answers))
      .sort((a, b) => b.created - a.created);
  }

  private dropInvitation(id: string): void {
    this.port.updateRecords((r) => ({ ...r, invitations: r.invitations.filter((i) => i.id !== id) }));
  }

  async cancelInvitation(id: string): Promise<void> {
    // Withdrawn: no longer listed, so the link stops working, and no longer a recipient (the
    // packs it could open are re-sealed for the others at this publication).
    this.dropInvitation(id);
    this.local.update((s) => {
      delete s.labels[id];
    });
    this.emit();
    if (this.port.canPublish()) await this.port.publish();
  }

  async receiveAnswer(text: string, opts: { faceToFace?: boolean } = {}): Promise<{ invitationId: string; responder: string }> {
    const bytes = returnLinkBytes(text);
    let expired = false;
    for (const x of this.opened()) {
      let resp: InvitationResponse;
      try {
        resp = openInvitationResponse(bytes, x.invitation, { now: this.date() });
      } catch (e) {
        if (e instanceof ExpiredError) expired = true;
        continue;
      }
      if (resp.owner === this.owner) throw new LinkProblemError('own-link');
      const id = x.invitation.id;
      this.port.updateRecords((r) => ({
        ...r,
        invitations: r.invitations.map((rec) => {
          if (rec.id !== id) return rec;
          const all = [...x.answers, bytes];
          const kept = all.length > MAX_ANSWERS ? all.slice(all.length - MAX_ANSWERS) : all;
          return invitationRecord(x.invitation, { answers: kept, ...(x.accepted !== undefined && { accepted: x.accepted }) });
        }),
      }));
      if (opts.faceToFace) {
        this.local.update((s) => {
          s.labels[id] = { ...(s.labels[id] ?? { name: '' }), faceToFace: true, faceToFaceOwner: resp.owner };
        });
      }
      this.emit();
      // Spec: answers live in the recovery vault, so that every device of mine sees them.
      if (this.port.canPublish()) {
        try {
          await this.port.publish();
        } catch {
          // Kept locally; the next sync pushes the vault.
        }
      }
      return { invitationId: id, responder: resp.owner };
    }
    throw new LinkProblemError(expired ? 'expired' : 'not-mine');
  }

  answers(invitationId: string): AnswerDetail | null {
    const x = this.opened().find((i) => i.invitation.id === invitationId);
    if (!x) return null;
    const c = this.collect(x);
    const set = answerSet(
      c.answers.map((a) => ({ owner: a.owner, created: Date.parse(a.created), openedAfterExpiry: a.openedAfterExpiry, location: a.location })),
      x.accepted,
      c.rejected,
    );
    const label = this.local.state.labels[invitationId];
    const safety: Record<string, string[]> = {};
    const names: Record<string, string> = {};
    const known: Record<string, boolean> = {};
    const contacts = new Set(this.port.contacts().map((k) => k.owner));
    for (const a of c.answers) {
      safety[a.owner] = safetyCode(this.owner, a.owner);
      // The invitation's name fits only a single answer: with several, it would name strangers too.
      names[a.owner] = this.name(a.owner) || (c.answers.length === 1 ? label?.name ?? '' : '');
      known[a.owner] = contacts.has(a.owner);
    }
    return { ...set, invitation: this.view(x, c.answers), safety, names, known };
  }

  /** Was this answer received face to face (scanned from their screen)? */
  faceToFaceOwner(invitationId: string): string | undefined {
    return this.local.state.labels[invitationId]?.faceToFaceOwner;
  }

  async acceptAnswer(invitationId: string, responder: string, choice: AcceptChoice): Promise<void> {
    const x = this.opened().find((i) => i.invitation.id === invitationId);
    if (!x) throw new LinkProblemError('no-longer-works');
    const answer = this.collect(x).answers.find((a) => a.owner === responder);
    if (!answer) throw new LinkProblemError('not-mine');
    const existing = this.port.contacts().find((c) => c.owner === responder);
    const verified = !!choice.verified || this.local.state.labels[invitationId]?.faceToFaceOwner === responder;
    if (answer.location !== undefined) {
      // Their index at their certified address: freshness of the certificate in the answer, and
      // the device that signed it is not revoked there. Never resets an existing contact's anchor.
      const index = await this.port.fetchIndex(answer.location, responder, existing?.anchor);
      checkInvitationIndex(answer, index, { now: this.date(), ...(existing?.anchor && { lastSeen: existing.anchor }) });
      this.port.addContact(index, { share: policyOf(choice.share), follow: choice.follow, verified });
    } else {
      // No storage yet: nothing to check their device against (shown "cannot be checked" until
      // the safety code is compared, crypto THREATS.md). Their key is kept as a contact without anchor.
      if (!existing) {
        const rec: VaultContact = { owner: responder, sharing_cert: answer.cert, verified };
        this.port.updateRecords((r) => ({ ...r, contacts: [...r.contacts.filter((c) => c.owner !== responder), rec].sort((a, b) => (a.owner < b.owner ? -1 : 1)) }));
      }
      this.port.setPolicy(responder, { share: policyOf(choice.share), follow: false });
    }
    this.port.updateRecords((r) => ({
      ...r,
      invitations: r.invitations.map((rec) => (rec.id === invitationId ? invitationRecord(x.invitation, { answers: x.answers, accepted: responder }) : rec)),
    }));
    this.setName(responder, choice.name);
    if (verified) this.markVerified(responder, true);
    this.emit();
    // The invitation key stops being a recipient; their key becomes one: new pack keys.
    await this.port.publish();
  }

  // ------------------------------------------------------------------ invitee

  async openInvitation(text: string, opts: { faceToFace?: boolean } = {}): Promise<OpenedInvitation> {
    const f = findLink(text);
    if (!f || f.kind !== 'invitation') throw new LinkKindError(f?.kind ?? null, 'invitation');
    const received = parseInvitationLink(f.link, { now: this.date() });
    if (received.owner === this.owner) throw new LinkProblemError('own-link');
    const existing = this.port.contacts().find((c) => c.owner === received.owner);
    const index = await this.port.fetchIndex(received.location, received.owner, existing?.anchor);
    checkInvitationIndex(received, index, { now: this.date(), ...(existing?.anchor && { lastSeen: existing.anchor }) });
    this.pending.set(received.token, { received, index, link: f.link, faceToFace: !!opts.faceToFace });
    return {
      token: received.token,
      owner: received.owner,
      expires: Date.parse(received.expires),
      known: !!existing,
      safety: safetyCode(this.owner, received.owner),
      name: this.name(received.owner),
      faceToFace: !!opts.faceToFace,
    };
  }

  async answerInvitation(token: string, choice: AnswerChoice): Promise<{ link: string }> {
    const p = this.pending.get(token);
    if (!p) throw new LinkProblemError('no-longer-works');
    const bytes = createInvitationResponse(p.received, this.port.device(), this.port.sharingCert(), { now: this.date() });
    const owner = p.received.owner;
    const shareBack = choice.shareBack && this.port.canPublish();
    const verified = !!choice.verified || p.faceToFace;
    this.port.addContact(p.index, { follow: true, ...(shareBack && { share: true }), verified });
    this.setName(owner, choice.name);
    if (verified) this.markVerified(owner, true);
    // Keep the invitation key (secret store) to read their places until they accept my answer.
    const expires = Date.parse(p.received.expires);
    this.received = [...this.received.filter((r) => r.link !== p.link), { link: p.link, owner, expires }];
    await this.o.secrets.set('invitations-received', JSON.stringify(this.received));
    this.pending.delete(token);
    this.emit();
    // Their places right away (spec: "sees my content"), best effort: the next sync retries.
    try {
      await this.port.readFriend({ owner, location: p.index.sharing_cert.location!, anchor: indexAnchor(p.index), extraKeys: this.invitationKeysFor(owner) });
    } catch {
      // Unreachable now: shown at the next sync.
    }
    // The return link carries my certified address when I have a storage: the inviter checks my
    // index there before accepting, so it must exist (and, with shareBack, wrap to them).
    if (this.port.canPublish()) {
      try {
        await this.port.publish();
      } catch {
        // The next sync publishes; the inviter sees "unreachable" and retries meanwhile.
      }
    }
    this.emit();
    return { link: buildReturnLink(bytes) };
  }

  invitationKeysFor(owner: string): KeyPair[] {
    return receivedKeysFor(this.received, owner, this.now());
  }

  invitationName(id: string): string | undefined {
    return this.local.state.labels[id]?.name || undefined;
  }

  // ------------------------------------------------------------------ contacts

  contacts(): ContactView[] {
    const loc = this.local.state;
    return this.port
      .contacts()
      .map((c) => ({
        owner: c.owner,
        name: loc.names[c.owner] ?? '',
        verified: !!loc.verified[c.owner],
        checkable: c.sharingCert.location !== undefined,
        follow: c.policy.follow,
        share: scopeOf(c.policy.share),
        rotation: c.sharingCert.rotation,
        lastSuccess: this.port.lastSuccess(c.owner),
      }))
      .sort((a, b) => (a.name || '￿').localeCompare(b.name || '￿') || (a.owner < b.owner ? -1 : 1));
  }

  contact(owner: string): ContactView | undefined {
    return this.contacts().find((c) => c.owner === owner);
  }

  rename(owner: string, name: string): void {
    this.setName(owner, name);
    this.emit();
  }

  async setFollow(owner: string, on: boolean): Promise<void> {
    this.port.setPolicy(owner, { follow: on });
    this.emit();
    if (on) {
      const c = this.port.contacts().find((k) => k.owner === owner);
      if (c?.sharingCert.location) {
        try {
          await this.port.readFriend({ owner, location: c.sharingCert.location, anchor: c.anchor, extraKeys: this.invitationKeysFor(owner) });
        } catch {
          // Read at the next sync.
        }
        this.emit();
      }
    }
  }

  async setShare(owner: string, scope: ShareScope): Promise<void> {
    this.port.setPolicy(owner, { share: policyOf(scope) });
    this.emit();
    // Less access: their wraps go and the pack keys they held are renewed at this publication.
    if (this.port.canPublish()) await this.port.publish();
  }

  private markVerified(owner: string, on: boolean): void {
    this.local.update((s) => {
      if (on) s.verified[owner] = true;
      else delete s.verified[owner];
    });
  }

  setVerified(owner: string, on: boolean): void {
    this.markVerified(owner, on);
    this.emit();
  }

  async removeContact(owner: string): Promise<void> {
    this.port.removeContact(owner);
    this.markVerified(owner, false);
    this.received = this.received.filter((r) => r.owner !== owner);
    await this.o.secrets.set('invitations-received', JSON.stringify(this.received));
    this.emit();
    if (this.port.canPublish()) await this.port.publish();
  }

  safetyCode(owner: string): string[] {
    return safetyCode(this.owner, owner);
  }

  safetyQr(owner: string): string {
    return safetyQrPayload(this.owner, owner);
  }

  matchSafetyQr(owner: string, scanned: string): boolean {
    try {
      return matchSafetyQr(scanned.trim(), this.owner, owner);
    } catch {
      return false;
    }
  }

  notices(): KeyNotice[] {
    return this.local.state.notices;
  }

  dismissNotice(owner: string): void {
    this.local.update((s) => {
      s.notices = s.notices.filter((n) => n.owner !== owner);
    });
    this.emit();
  }

  changed(): void {
    this.refresh();
    this.emit();
  }

  refresh(): void {
    const contacts = this.port.contacts().map((c) => ({ owner: c.owner, rotation: c.sharingCert.rotation }));
    const r = keyNotices(this.local.state.keys, contacts, this.records().retired_owners, this.now());
    const changed = JSON.stringify(r.next) !== JSON.stringify(this.local.state.keys) || r.notices.length > 0;
    if (!changed) return;
    this.local.update((s) => {
      s.keys = r.next;
      for (const n of r.notices) {
        s.notices = [...s.notices.filter((m) => !(m.owner === n.owner && m.kind === n.kind)), n];
        // Spec: "If a verified contact's identity changes, the mark is removed and the badge comes back."
        if (n.kind === 'identity-moved') delete s.verified[n.owner];
      }
    });
    if (r.notices.length) this.emit();
  }
}

export type { KeyNotice, ShareScope };
