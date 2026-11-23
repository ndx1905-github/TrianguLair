import { describe, expect, it } from 'vitest';

import { setSetting } from '../data/deviceSettings';
import { buildInvitationLink, findLink } from '../contacts/links';
import { adoptLinkOriginFrom, LINK_ORIGIN_SETTING, linkOrigin, linkOriginIsPlaceholder, parseLinkOrigin, saveLinkOrigin } from './origin';

describe('link address', () => {
  it('normalizes what the user types and refuses unusable addresses', () => {
    expect(parseLinkOrigin('triangulair.example.net')).toBe('https://triangulair.example.net');
    expect(parseLinkOrigin(' https://cloud.example.net/triangulair/ ')).toBe('https://cloud.example.net/triangulair');
    expect(parseLinkOrigin('http://localhost:8081')).toBe('http://localhost:8081');
    expect(parseLinkOrigin('http://example.net')).toBeNull();
    expect(parseLinkOrigin('https://example.net/?a=1')).toBeNull();
    expect(parseLinkOrigin('https://user:pw@example.net')).toBeNull();
    expect(parseLinkOrigin('not an address')).toBeNull();
    expect(parseLinkOrigin('')).toBeNull();
  });

  it('uses the placeholder until set, then the saved address for new links, which are still found', () => {
    setSetting(LINK_ORIGIN_SETTING, '');
    expect(linkOrigin()).toBe('https://example.org');
    expect(linkOriginIsPlaceholder()).toBe(true);
    saveLinkOrigin(parseLinkOrigin('links.example.net/app'));
    expect(linkOriginIsPlaceholder()).toBe(false);
    const link = buildInvitationLink('SQUAAA');
    expect(link).toBe('https://links.example.net/app/i#SQUAAA');
    expect(findLink(`Join me: ${link}`)?.fragment).toBe('SQUAAA');
    saveLinkOrigin(null);
    expect(linkOrigin()).toBe('https://example.org');
  });

  it('a phone added from the web app takes its address, unless one was chosen', () => {
    saveLinkOrigin(null);
    adoptLinkOriginFrom('https://example.org/d#AAAA');
    expect(linkOriginIsPlaceholder()).toBe(true);
    adoptLinkOriginFrom('https://cloud.example.net/app/d#AAAA');
    expect(linkOrigin()).toBe('https://cloud.example.net/app');
    adoptLinkOriginFrom('https://other.example.net/d#AAAA');
    expect(linkOrigin()).toBe('https://cloud.example.net/app');
    saveLinkOrigin(null);
  });
});
