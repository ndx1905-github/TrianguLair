/** Labels of filter values (i18n), shared by the expanded bar and the collapsed summary. Pure. */
import type { CategoryGroup, CategoryId } from '@triangulair/osm';

import { categoryLabel, cuisineLabel, type Translator } from '../places/card';
import type { SubDimension } from '../places/filters';
import type { AppTag } from '../places/model';
import { tagPath } from '../tags/tree';
import type { ActivePill } from './pills';

function readable(value: string): string {
  const s = value.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function groupLabel(g: CategoryGroup, tr: Translator): string {
  return tr.t(`group.${g}`);
}

export function subLabel(dim: SubDimension, value: string, tr: Translator): string {
  switch (dim) {
    case 'kinds':
      return categoryLabel(value as CategoryId, tr);
    case 'cuisines':
      return cuisineLabel(value, tr);
    case 'museums':
      return tr.has(`museumType.${value}`) ? tr.t(`museumType.${value}`) : readable(value);
    case 'shops':
      return tr.has(`shopType.${value}`) ? tr.t(`shopType.${value}`) : readable(value);
  }
}

export const euros = (n: number) => '€'.repeat(n);

export interface PillLabelContext {
  tagById: ReadonlyMap<string, AppTag>;
  friendTag: (key: string) => { name: string; color: string | null; personName: string } | undefined;
}

/** Label (and dot color) of a pill of the collapsed summary. */
export function pillLabel(p: ActivePill, ctx: PillLabelContext, tr: Translator): { label: string; color?: string } {
  switch (p.kind) {
    case 'tag': {
      const tag = ctx.tagById.get(p.value);
      return tag ? { label: tagPath(tag.id, ctx.tagById), color: tag.color } : { label: '?' };
    }
    case 'friendTag': {
      const f = ctx.friendTag(p.value);
      return f ? { label: tr.t('fb.friendTag', { name: f.name, person: f.personName }), ...(f.color ? { color: f.color } : {}) } : { label: '?' };
    }
    case 'category':
      return { label: groupLabel(p.value as CategoryGroup, tr) };
    case 'kind':
      return { label: subLabel('kinds', p.value, tr) };
    case 'cuisine':
      return { label: subLabel('cuisines', p.value, tr) };
    case 'museum':
      return { label: subLabel('museums', p.value, tr) };
    case 'shop':
      return { label: subLabel('shops', p.value, tr) };
    case 'criterion':
      return { label: tr.t(`criterion.${p.value}`) };
    case 'diet':
      return { label: tr.t(`dietFilter.${p.value}`) };
    case 'charge':
      return { label: tr.t('fb.charge', { max: p.value }) };
    case 'status':
      return { label: tr.t(`status.${p.value}`) };
    case 'placeStatus':
      return { label: tr.t(`placeStatus.${p.value}`) };
    case 'visibility':
      return { label: tr.t(`visibilityFilter.${p.value}`) };
    case 'price':
      return { label: euros(Number(p.value)) };
    case 'text':
      return { label: tr.t('fb.textPill', { text: p.value }) };
  }
}
