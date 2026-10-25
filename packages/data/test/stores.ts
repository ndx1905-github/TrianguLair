// SPDX-License-Identifier: MPL-2.0
import { NodeSqliteDriver } from '../src/driver/node.ts';
import { DataStore, type OpenStoreOptions } from '../src/store.ts';
import type { Capabilities } from '../src/sqlite/schema.ts';
import { fakeClock, ME, seqIds } from './helpers.ts';

export function openStore(
  opts: Partial<OpenStoreOptions> & { disable?: readonly (keyof Capabilities)[] } = {},
): DataStore {
  const clock = fakeClock();
  return DataStore.open({
    driver: opts.driver ?? new NodeSqliteDriver(':memory:'),
    meId: opts.meId ?? ME,
    now: opts.now ?? clock.now,
    newId: opts.newId ?? seqIds('id'),
    ...(opts.actor && { actor: opts.actor }),
    ...(opts.disable && { disable: opts.disable }),
    ...(opts.compactEvery && { compactEvery: opts.compactEvery }),
  });
}

