/**
 * "Block" (gap #6, spec "Moderation"): confirmed, then the person stops being a contact (their wraps go at my next
 * publication, their places leave the app), their lists are unfollowed, and their invitations and answers are
 * refused from then on. Used on a contact's screen and when reporting a list.
 */
import { useState } from 'react';
import { View } from 'react-native';

import { Button } from '../components/ui';
import { useContacts } from '../contacts/ContactsProvider';
import { Card, Strong } from '../contacts/ui';
import { useI18n } from '../i18n';
import { Muted } from '../storage/components';
import { useSync } from '../sync/SyncProvider';

export function BlockSection({ owner, name, onBlocked }: { owner: string; name: string; onBlocked: () => void }) {
  const { t } = useI18n();
  const sync = useSync();
  const svc = useContacts();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      // Through the contacts service first: it also drops the invitation keys I kept for them and publishes.
      if (svc?.contact(owner)) await svc.removeContact(owner).catch(() => {});
      await sync.block(owner, name);
      onBlocked();
    } finally {
      setBusy(false);
    }
  };
  if (!confirm) return <Button kind="danger" label={t('block.action', { name })} onPress={() => setConfirm(true)} testID="block" />;
  return (
    <Card testID="block-confirm">
      <Strong>{t('block.confirm', { name })}</Strong>
      <Muted>{t('block.help', { name })}</Muted>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button kind="danger" label={t('block.go')} onPress={() => void go()} disabled={busy} testID="block-go" />
        <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirm(false)} />
      </View>
    </Card>
  );
}
