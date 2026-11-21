/**
 * Nextcloud part of the storage wizard (T-202): "Connect in the browser" (Login Flow v2: server
 * address → the Nextcloud login page opens → the app polls → app password obtained), then, when
 * the user asks for it, the read-only public link of the TrianguLair folder made through the OCS
 * Share API. Both fill the same draft fields as the manual form, which stays below as fallback.
 */
import { useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';

import { Banner, Button } from '../components/ui';
import { useI18n } from '../i18n';
import { nextcloudBase, type StorageDraft } from './config';
import { Muted } from './components';
import { NextcloudError, ensurePublicShare, nextcloudUserId, startLoginFlow, waitForLogin, type NextcloudProblem } from './nextcloud';

type Phase = { k: 'idle' } | { k: 'starting' } | { k: 'waiting'; loginUrl: string } | { k: 'connected'; name: string } | { k: 'error'; problem: NextcloudProblem };
type SharePhase = { k: 'idle' } | { k: 'busy' } | { k: 'done'; created: boolean; expiration: string | null } | { k: 'error'; problem: NextcloudProblem };

const problemOf = (e: unknown): NextcloudProblem => (e instanceof NextcloudError ? e.problem : 'failed');

export function NextcloudConnect({ draft, set }: { draft: StorageDraft; set: (patch: Partial<StorageDraft>) => void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [share, setShare] = useState<SharePhase>({ k: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const connect = async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase({ k: 'starting' });
    try {
      const flow = await startLoginFlow(draft.ncServer);
      setPhase({ k: 'waiting', loginUrl: flow.loginUrl });
      await Linking.openURL(flow.loginUrl).catch(() => undefined);
      const login = await waitForLogin(flow, { signal: ctl.signal });
      const creds = { loginName: login.loginName, appPassword: login.appPassword };
      let userId = login.loginName;
      try {
        userId = await nextcloudUserId(login.server, creds);
      } catch {
        // Older servers or a blocked OCS endpoint: the login name is the id in most setups.
      }
      set({ ncServer: login.server, ncUser: login.loginName, ncPassword: login.appPassword, ncUserId: userId === login.loginName ? '' : userId });
      setPhase({ k: 'connected', name: login.loginName });
    } catch (e) {
      if (problemOf(e) === 'cancelled') setPhase({ k: 'idle' });
      else setPhase({ k: 'error', problem: problemOf(e) });
    }
  };

  const makeShare = async () => {
    setShare({ k: 'busy' });
    try {
      const creds = { loginName: draft.ncUser.trim(), appPassword: draft.ncPassword.trim() };
      const server = draft.ncServer.trim();
      const base = nextcloudBase(server) ?? server;
      const userId = draft.ncUserId.trim() || (await nextcloudUserId(base, creds).catch(() => creds.loginName));
      const s = await ensurePublicShare(base, userId, creds);
      set({ ncShareLink: s.url, readUrl: '' });
      setShare({ k: 'done', created: s.created, expiration: s.expiration });
    } catch (e) {
      setShare({ k: 'error', problem: problemOf(e) });
    }
  };

  const canConnect = draft.ncServer.trim() !== '' && phase.k !== 'starting' && phase.k !== 'waiting';
  const haveCreds = draft.ncServer.trim() !== '' && draft.ncUser.trim() !== '' && draft.ncPassword.trim() !== '';

  return (
    <View style={{ gap: 10 }}>
      <Muted>{t('storage.nc.loginHelp')}</Muted>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button label={t('storage.nc.login')} onPress={() => void connect()} disabled={!canConnect} testID="nc-login" />
        {phase.k === 'waiting' && <Button kind="secondary" label={t('storage.nc.cancel')} onPress={() => abort.current?.abort()} testID="nc-login-cancel" />}
      </View>
      {phase.k === 'waiting' && (
        <>
          <Banner testID="nc-login-waiting">{t('storage.nc.waiting')}</Banner>
          <View style={{ alignSelf: 'flex-start' }}>
            <Button kind="secondary" label={t('storage.nc.openAgain')} onPress={() => void Linking.openURL(phase.loginUrl).catch(() => undefined)} testID="nc-login-open" />
          </View>
        </>
      )}
      {phase.k === 'connected' && <Banner testID="nc-login-ok">{t('storage.nc.connected', { name: phase.name })}</Banner>}
      {phase.k === 'error' && (
        <Banner tone="warning" testID="nc-login-error">
          {t(`storage.nc.problem.${phase.problem}`)}
        </Banner>
      )}

      {haveCreds && !draft.ncShareLink.trim() && (
        <View style={{ gap: 8 }}>
          <Muted>{t('storage.nc.shareHelp')}</Muted>
          <View style={{ alignSelf: 'flex-start' }}>
            <Button kind="secondary" label={share.k === 'busy' ? t('storage.nc.shareBusy') : t('storage.nc.share')} onPress={() => void makeShare()} disabled={share.k === 'busy'} testID="nc-share" />
          </View>
        </View>
      )}
      {share.k === 'done' && (
        <Banner testID="nc-share-ok">
          {share.created ? t('storage.nc.shareCreated') : t('storage.nc.shareReused')}
          {share.expiration ? ` ${t('storage.nc.shareExpires', { date: share.expiration })}` : ''}
        </Banner>
      )}
      {share.k === 'error' && (
        <Banner tone="warning" testID="nc-share-error">
          {t(`storage.nc.problem.${share.problem}`)}
        </Banner>
      )}
      <Muted>{t('storage.nc.manual')}</Muted>
    </View>
  );
}
