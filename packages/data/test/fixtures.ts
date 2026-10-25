// SPDX-License-Identifier: MPL-2.0
/** Builders writing directly through the repository (no Automerge), for T-101 tests. */
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { saveIdFor } from '../src/ids.ts';
import { normalizeSnapshot, type PlaceSnapshotInput } from '../src/place.ts';
import { Repository } from '../src/sqlite/repository.ts';
import type { Capabilities } from '../src/sqlite/schema.ts';
import type { SaveRecord, TagRecord } from '../src/types.ts';
import { ME } from './helpers.ts';

export function openRepo(disable: readonly (keyof Capabilities)[] = []): Repository {
  return Repository.open(new NodeSqliteDriver(':memory:'), { meId: ME, disable });
}

export const ALL_MODES: { name: string; disable: (keyof Capabilities)[] }[] = [
  { name: 'rtree+fts5', disable: [] },
  { name: 'fallback (no rtree, no fts5)', disable: ['rtree', 'fts5'] },
];

export function writeMySave(
  repo: Repository,
  place: PlaceSnapshotInput,
  fields: Partial<Omit<SaveRecord, 'id' | 'ownerId' | 'placeId'>> = {},
): string {
  const snap = normalizeSnapshot(place);
  const id = saveIdFor(repo.meId, snap.id);
  const tagIds = fields.tagIds ?? [];
  repo.writeOwnSave(
    {
      id,
      ownerId: repo.meId,
      placeId: snap.id,
      comment: fields.comment ?? '',
      commentVisibility: fields.commentVisibility ?? 'friends',
      status: fields.status ?? null,
      priceLevel: fields.priceLevel ?? null,
      sharing: fields.sharing ?? 'friends',
      mainTagId: fields.mainTagId ?? tagIds[0] ?? null,
      tagIds,
      createdAt: fields.createdAt ?? 1,
      updatedAt: fields.updatedAt ?? 1,
      deletedAt: fields.deletedAt ?? null,
    },
    snap,
    [],
  );
  return id;
}

export function tagRec(
  id: string,
  name: string,
  parentId: string | null = null,
  extra: Partial<TagRecord & { active: boolean }> = {},
): TagRecord & { active: boolean } {
  return {
    id,
    ownerId: ME,
    parentId,
    name,
    color: null,
    icon: null,
    osmCategories: [],
    deletedAt: null,
    active: true,
    ...extra,
  };
}
