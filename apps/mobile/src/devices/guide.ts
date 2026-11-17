/**
 * After a declaration of loss (spec "Loss and theft", step 4): change the storage access so the
 * lost phone can no longer write, on the current storage AND on every previous storage that still
 * holds a redirect (an older certificate certifies the older address, and the lost device can still
 * sign indexes of that older rotation). Pure: which storages, which steps and links per protocol;
 * the wording is in i18n (`lost.guide.*`). Unit-tested.
 */
import { protocolOf, type StorageConfig } from '../storage/config';
import type { StorageState } from '../storage/state';

export type GuideProtocol = 'nextcloud' | 'webdav' | 's3' | 'https';

export interface GuideItem {
  role: 'current' | 'previous';
  protocol: GuideProtocol;
  /** Where the user recognizes it (write address or read address, no credential). */
  address: string;
  /** i18n keys of the steps, in order. */
  steps: string[];
  /** Pages to open (the provider's own), when one is known. */
  links: { label: string; url: string }[];
  /** The app can take the new credentials for this one (current storage only). */
  canUpdateHere: boolean;
  /** Until when the redirect is kept (previous storages). */
  keepUntil?: number;
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isAws(endpoint: string): boolean {
  return /(^|\.)amazonaws\.com$/i.test(origin(endpoint)?.replace(/^https?:\/\//, '') ?? '');
}

export function guideFor(config: StorageConfig, role: GuideItem['role'], keepUntil?: number): GuideItem {
  const protocol = protocolOf(config);
  const base = { role, protocol, canUpdateHere: role === 'current' && config.kind !== 'https', ...(keepUntil !== undefined && { keepUntil }) };
  if (config.kind === 'webdav' && config.flavor === 'nextcloud') {
    const server = config.nextcloud?.server ?? origin(config.url) ?? '';
    return {
      ...base,
      address: config.url,
      steps: ['lost.guide.nc.revoke', 'lost.guide.nc.create', role === 'current' ? 'lost.guide.updateHere' : 'lost.guide.previousKeep'],
      links: server ? [{ label: 'lost.guide.nc.link', url: `${server.replace(/\/+$/, '')}/index.php/settings/user/security` }] : [],
    };
  }
  if (config.kind === 'webdav') {
    return { ...base, address: config.url, steps: ['lost.guide.dav.password', 'lost.guide.dav.sessions', role === 'current' ? 'lost.guide.updateHere' : 'lost.guide.previousKeep'], links: [] };
  }
  if (config.kind === 's3') {
    return {
      ...base,
      address: `${config.endpoint} · ${config.bucket}${config.prefix ? `/${config.prefix}` : ''}`,
      steps: ['lost.guide.s3.deactivate', 'lost.guide.s3.create', role === 'current' ? 'lost.guide.updateHere' : 'lost.guide.previousKeep'],
      links: isAws(config.endpoint) ? [{ label: 'lost.guide.s3.link', url: 'https://console.aws.amazon.com/iam/home#/security_credentials' }] : [],
    };
  }
  return { ...base, address: config.readUrl, steps: ['lost.guide.https.publish', 'lost.guide.domain'], links: [] };
}

/** The current storage first, then every previous one still holding a redirect (newest first). */
export function credentialGuide(state: StorageState, now: number): GuideItem[] {
  const out: GuideItem[] = [];
  if (state.current) out.push(guideFor(state.current, 'current'));
  for (const p of state.previous) if (p.keepUntil > now) out.push(guideFor(p.config, 'previous', p.keepUntil));
  return out;
}
