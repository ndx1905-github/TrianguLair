import {
  checkInvitationIndex,
  createInvitation,
  createInvitationResponse,
  invitationRecord,
  packEntry,
  parseInvitationLink,
  publicEntry,
  sealPack,
  serialize,
  signIndex,
  verifyIndex,
  type OwnerInvitation,
  type ReceivedInvitation,
  type SignedIndex,
} from '../../src/index';
import { utf8 } from '../../src/encoding';
import { NOW, T0, plus, world, type World, HOUR } from './fixtures';

/** Artifacts used by several vector files. */
export interface Shared {
  w: World;
  inv1: OwnerInvitation;
  /** Link fragment of inv1. */
  f1: string;
  packA: Uint8Array;
  mediaA: Uint8Array;
  publicFile: Uint8Array;
  /** Alice, seq 1, rotation 0, signed by d1 at T0: packA, mediaA, public file, lists inv1. */
  i1: SignedIndex;
  /** Same content, seq 2. */
  i2: SignedIndex;
  /** Rotation 1 (d2 revoked), seq 1, nothing listed (inv1 is superseded). */
  iRot1: SignedIndex;
  /** Bob's index, seq 1, rotation 0. */
  bobIndex: SignedIndex;
  received: ReceivedInvitation;
  /** Return links of Bob and Carol for inv1. */
  r1: Uint8Array;
  r2: Uint8Array;
  /** Vault record of inv1 (canonical JSON text). */
  rec1: string;
}

export function shared(w: World): Shared {
  const { alice, bob, carol } = w;
  const { invitation: inv1, fragment: f1 } = createInvitation(alice.s1, alice.cert0, { now: T0 });
  const packA = sealPack(alice.id.owner, utf8('{"features":[],"type":"FeatureCollection"}'), [bob.sharing.publicKey]);
  const mediaA = sealPack(alice.id.owner, utf8('photo bytes'), [bob.sharing.publicKey], { type: 'media', pad: 'none' });
  const publicFile = utf8('{"features":[],"type":"FeatureCollection"}');
  const content = {
    sharingCert: alice.cert0,
    packs: [packEntry(packA), packEntry(mediaA, 'media')],
    public: publicEntry(publicFile, 'lists'),
    invitations: [inv1],
    vaultDataKey: alice.vdk,
  };
  const i1 = signIndex(alice.s1, { ...content, seq: 1, now: T0 });
  const i2 = signIndex(alice.s1, { ...content, seq: 2, now: plus(T0, HOUR / 2), previous: i1 });
  const iRot1 = signIndex(alice.s1, { seq: 1, sharingCert: w.aliceCert1, packs: [], invitations: [inv1], vaultDataKey: alice.vdk, now: plus(T0, (2 * HOUR) / 3), previous: i2 });
  const bobIndex = signIndex(bob.s1, { seq: 1, sharingCert: bob.cert0, packs: [], vaultDataKey: bob.vdk, now: T0 });
  const received = parseInvitationLink(f1, { now: NOW });
  checkInvitationIndex(received, verifyIndex(serialize(i1), { expectedOwner: received.owner, location: received.location, now: NOW }), { now: NOW });
  const r1 = createInvitationResponse(received, bob.s1, bob.cert0, { now: NOW });
  const r2 = createInvitationResponse(received, carol.s1, carol.cert0, { now: plus(NOW, HOUR) });
  return { w, inv1, f1, packA, mediaA, publicFile, i1, i2, iRot1, bobIndex, received, r1, r2, rec1: serialize(invitationRecord(inv1)) };
}
