/*
 * Generates every known-answer vector file of docs/format/vectors/ deterministically: the fixtures
 * (identities, devices, keys) and each file are produced under their own seeded randomness
 * (seeded.ts), with fixed clocks. `npm run vectors` (packages/crypto) rewrites the files;
 * test/vectors.test.ts checks the library against them and that regeneration is byte-identical.
 */
import type { VectorFile } from './builder';
import { encodingVectors, identityVectors, keyExportVectors, safetyVectors, sharingKeyVectors, signatureVectors, transferVectors } from './gen-basic';
import { deviceCertVectors, identityMoveVectors, sharingCertVectors } from './gen-certs';
import { indexVectors } from './gen-index';
import { invitationLinkVectors, invitationRecordVectors, returnLinkVectors, vaultVectors } from './gen-invitation';
import { groupKeyVectors, packVectors } from './gen-pack';
import { world } from './fixtures';
import { seeded } from './seeded';
import { shared } from './shared';

export const VECTOR_FILES: [string, (sh: ReturnType<typeof shared>) => VectorFile][] = [
  ['encoding', () => encodingVectors()],
  ['signatures', signatureVectors],
  ['identity', identityVectors],
  ['sharing-key', sharingKeyVectors],
  ['sharing-cert', sharingCertVectors],
  ['device-cert', deviceCertVectors],
  ['identity-move', identityMoveVectors],
  ['signed-index', indexVectors],
  ['pack', packVectors],
  ['group-key', groupKeyVectors],
  ['invitation-link', invitationLinkVectors],
  ['return-link', returnLinkVectors],
  ['invitation-record', invitationRecordVectors],
  ['vault', vaultVectors],
  ['transfer', transferVectors],
  ['key-export', keyExportVectors],
  ['safety-code', safetyVectors],
];

/** All vector files, by file name (without ".json"). */
export function generateVectors(): Record<string, VectorFile> {
  const w = seeded('world', world);
  const sh = seeded('shared', () => shared(w));
  const out: Record<string, VectorFile> = {};
  for (const [name, gen] of VECTOR_FILES) out[name] = seeded(name, () => gen(sh));
  return out;
}

/** The text written to docs/format/vectors/<name>.json (1-space indentation, final newline). */
export function vectorFileText(file: VectorFile): string {
  return `${JSON.stringify(file, null, 1)}\n`;
}
