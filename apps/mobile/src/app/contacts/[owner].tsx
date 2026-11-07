/**
 * One contact (T-209): the two switches ("I see their places", "they see my places" with
 * everything I share with friends or only some lists), the safety code (12 × 5 digits, or a QR
 * code to show and to scan) with the "I compared it" mark kept on this device, the name I gave
 * them, and removal (their wraps disappear and the pack keys they held are renewed).
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { DataGate } from '../../components/DataGate';
import { Banner, Button } from '../../components/ui';
import { useContacts } from '../../contacts/ContactsProvider';
import type { ShareScope } from '../../contacts/model';
import { Scanner } from '../../contacts/Scanner';
import { Card, NameField, PasteField, QrCode, SafetyCodeGrid, ShareChoice, Strong, TrustBadge, shortKey } from '../../contacts/ui';
import { useData } from '../../data/DataProvider';
import { ToggleRow } from '../../firstLaunch/ToggleRow';
import { useLayout } from '../../hooks/useLayout';
import { useI18n } from '../../i18n';
import { Muted, Section, StorageScreen } from '../../storage/components';

function ContactScreen() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const svc = useContacts();
  const { repo } = useData();
  const { sizeClass } = useLayout();
  const params = useLocalSearchParams<{ owner?: string }>();
  const owner = typeof params.owner === 'string' ? decodeURIComponent(params.owner) : '';
  const c = svc?.contact(owner);
  const [name, setName] = useState(c?.name ?? '');
  useEffect(() => setName(c?.name ?? ''), [c?.name]);
  const [qr, setQr] = useState(false);
  const [scanText, setScanText] = useState('');
  const [match, setMatch] = useState<boolean | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!svc || !c) {
    return (
      <StorageScreen title={t('contacts.title')} testID="contact-screen">
        <Muted testID="contact-missing">{t('contacts.missing')}</Muted>
        <Button kind="secondary" label={t('contacts.open')} onPress={() => router.replace('/contacts')} />
      </StorageScreen>
    );
  }
  const label = c.name || shortKey(owner);
  const lists = repo.lists().map((l) => ({ id: l.id, name: l.name }));
  const shareOn = c.share.kind !== 'none';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setSaved(false);
    try {
      await fn();
      setSaved(true);
    } catch {
      setSaved(false);
    } finally {
      setBusy(false);
    }
  };

  const check = (scanned: string) => {
    const ok = svc.matchSafetyQr(owner, scanned);
    setMatch(ok);
    if (ok) svc.setVerified(owner, true);
  };

  return (
    <StorageScreen title={label} testID="contact-screen">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <TrustBadge verified={c.verified} checkable={c.checkable} testID="contact-badge" />
        {c.lastSuccess !== null && <Muted>{t('contacts.updated', { date: new Date(c.lastSuccess).toLocaleDateString(locale, { month: 'long', day: 'numeric' }) })}</Muted>}
      </View>
      {!c.checkable && <Banner tone="warning" testID="contact-uncheckable">{t('contacts.uncheckable', { name: label })}</Banner>}

      <Section title={t('contacts.nameTitle')}>
        <NameField label={t('contacts.nameLabel')} help={t('contacts.nameHelp')} value={name} onChange={setName} testID="contact-name" />
        {name.trim() !== c.name && <Button kind="secondary" label={t('contacts.rename')} onPress={() => svc.rename(owner, name)} testID="contact-rename" />}
      </Section>

      <Section title={t('contacts.access')}>
        <ToggleRow
          label={t('contacts.follow', { name: label })}
          help={c.checkable ? t('contacts.followHelp') : t('contacts.followNoStorage', { name: label })}
          value={c.follow}
          onChange={(on) => void run(() => svc.setFollow(owner, on))}
          disabled={busy || !c.checkable}
          testID="contact-follow"
        />
        <ToggleRow
          label={t('contacts.theySee', { name: label })}
          help={t('contacts.theySeeHelp')}
          value={shareOn}
          onChange={(on) => void run(() => svc.setShare(owner, on ? { kind: 'all' } : { kind: 'none' }))}
          disabled={busy}
          testID="contact-share"
        />
        {shareOn && <ShareChoice value={c.share} onChange={(s: ShareScope) => void run(() => svc.setShare(owner, s))} lists={lists} testID="contact-scope" />}
        {busy && <Muted testID="contact-publishing">{t('answers.publishing')}</Muted>}
        {saved && !busy && <Muted testID="contact-saved">{t('contacts.saved')}</Muted>}
      </Section>

      <Section title={t('contacts.safetyTitle')}>
        <Muted>{t('contacts.safetyHelp', { name: label })}</Muted>
        <SafetyCodeGrid groups={svc.safetyCode(owner)} wide={sizeClass !== 'compact'} testID="contact-code" />
        {qr ? (
          <Card testID="contact-qr-card">
            <QrCode value={svc.safetyQr(owner)} testID="contact-qr" label={t('contacts.safetyQrLabel')} />
            <Muted>{t('contacts.safetyQrHelp', { name: label })}</Muted>
            <Scanner onScanned={check} testID="contact-scanner" />
            <PasteField label={t('contacts.safetyPaste')} value={scanText} onChange={setScanText} onSubmit={() => check(scanText)} action={t('contacts.safetyCheck')} testID="contact-safety" />
            {match === true && <Banner testID="contact-match">{t('contacts.safetyMatch', { name: label })}</Banner>}
            {match === false && <Banner tone="warning" testID="contact-mismatch">{t('contacts.safetyMismatch', { name: label })}</Banner>}
          </Card>
        ) : (
          <Button kind="secondary" label={t('contacts.safetyQr')} onPress={() => setQr(true)} testID="contact-show-qr" />
        )}
        <ToggleRow label={t('contacts.compared')} help={t('contacts.comparedHelp')} value={c.verified} onChange={(on) => svc.setVerified(owner, on)} testID="contact-verified" />
      </Section>

      <Section title={t('contacts.removeTitle')}>
        {confirmRemove ? (
          <Card testID="contact-remove-confirm">
            <Strong>{t('contacts.removeConfirm', { name: label })}</Strong>
            <Muted>{t('contacts.removeHelp', { name: label })}</Muted>
            <Button
              kind="danger"
              label={t('contacts.remove')}
              onPress={() =>
                void run(async () => {
                  await svc.removeContact(owner);
                  router.replace('/contacts');
                })
              }
              disabled={busy}
              testID="contact-remove-go"
            />
            <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirmRemove(false)} />
          </Card>
        ) : (
          <Button kind="danger" label={t('contacts.remove')} onPress={() => setConfirmRemove(true)} testID="contact-remove" />
        )}
      </Section>
    </StorageScreen>
  );
}

export default function ContactRoute() {
  return (
    <DataGate>
      <ContactScreen />
    </DataGate>
  );
}
