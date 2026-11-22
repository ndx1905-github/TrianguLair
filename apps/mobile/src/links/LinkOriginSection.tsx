import { useState } from 'react';

import { Banner, Button } from '../components/ui';
import { useI18n } from '../i18n';
import { LinkOriginField } from './LinkOriginField';
import { linkOrigin, linkOriginIsPlaceholder, parseLinkOrigin, saveLinkOrigin } from './origin';

/** Settings: change the address of the links this device hands out. */
export function LinkOriginSection() {
  const { t } = useI18n();
  const [value, setValue] = useState(() => (linkOriginIsPlaceholder() ? '' : linkOrigin()));
  const [saved, setSaved] = useState(false);
  const invalid = value.trim() !== '' && parseLinkOrigin(value) === null;
  return (
    <>
      <LinkOriginField
        value={value}
        onChange={(v) => {
          setValue(v);
          setSaved(false);
        }}
        invalid={invalid}
      />
      <Button
        kind="secondary"
        label={t('linkOrigin.save')}
        disabled={invalid}
        onPress={() => {
          saveLinkOrigin(parseLinkOrigin(value));
          setSaved(true);
        }}
        testID="link-origin-save"
      />
      {saved && <Banner testID="link-origin-saved">{t('linkOrigin.saved')}</Banner>}
      {!saved && linkOriginIsPlaceholder() && <Banner tone="warning">{t('linkOrigin.placeholderWarning')}</Banner>}
    </>
  );
}
