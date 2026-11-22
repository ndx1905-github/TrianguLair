import { beforeAll, describe, expect, it } from 'vitest';
import { fromB64Url, ready } from '@triangulair/crypto';

import { buildInvitationLink, buildReturnLink, findLink, invitePrefix, LinkKindError, returnLinkBytes, returnPrefix, shareMessage } from './links';
import { linkProblemOf } from './problems';

beforeAll(async () => {
  await ready();
});

describe('links', () => {
  it('builds the canonical invitation and return links', () => {
    expect(buildInvitationLink('SQUAbc_-')).toBe('https://example.org/i#SQUAbc_-');
    expect(() => buildInvitationLink('not base64!')).toThrow();
    const bytes = Uint8Array.of(0x52, 4, 1, 2, 255);
    const link = buildReturnLink(bytes);
    expect(link.startsWith(returnPrefix())).toBe(true);
    expect(returnLinkBytes(link)).toEqual(bytes);
  });

  it('finds the link inside a pasted message, a scheme link or with trailing text', () => {
    const msg = shareMessage('Marie invites you to see her places on TrianguLair:', `${invitePrefix()}SQUAAA`);
    expect(findLink(msg)).toEqual({ kind: 'invitation', fragment: 'SQUAAA', link: 'https://example.org/i#SQUAAA' });
    expect(findLink('triangulair://r#UgQx.')!.link).toBe('https://example.org/r#UgQx');
    expect(findLink('see HTTPS://www.TrianguLair.app/l/#abc then')!.kind).toBe('list');
    expect(findLink('https://example.org/x#SQUAAA')).toBeNull();
    expect(findLink('see https://cloud.example.net/triangulair/i#SQUAAA here')?.fragment).toBe('SQUAAA');
    expect(findLink('')).toBeNull();
    expect(findLink('https://example.org/i')).toBeNull();
  });

  it('refuses another kind of link where an answer is expected, and oversized fragments', () => {
    expect(() => returnLinkBytes(`${invitePrefix()}SQUAAA`)).toThrow(LinkKindError);
    expect(linkProblemOf(captured(() => returnLinkBytes(`${invitePrefix()}SQUAAA`)))).toBe('wrong-kind');
    expect(linkProblemOf(captured(() => returnLinkBytes('hello')))).toBe('malformed');
    expect(linkProblemOf(captured(() => returnLinkBytes(returnPrefix() + 'A'.repeat(13_000))))).toBe('malformed');
  });

  it('decodes base64url strictly', () => {
    expect(() => fromB64Url('A', 'x')).toThrow();
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}
