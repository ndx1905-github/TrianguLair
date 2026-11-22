/** Settings and names of the example places (src/data/demo.ts), shared by DataProvider and useExamples. */
import type { useI18n } from '../i18n';
import type { TagId } from '../theme/tags';
import { DEMO_FRIEND } from './demo';

/** Asked for on the first launch, before the store may be open: DataProvider adds them once it is. */
export const EXAMPLES_WANTED_KEY = 'examples-wanted';
/** "Hide" on the banner (Settings still has the delete action). */
export const EXAMPLES_BANNER_KEY = 'examples-banner';

export function exampleOptions(t: ReturnType<typeof useI18n>['t']) {
  return {
    friendName: t('examples.friendName', { name: DEMO_FRIEND.displayName }),
    tagName: (id: TagId) => t(`demoTag.${id}`),
  };
}

