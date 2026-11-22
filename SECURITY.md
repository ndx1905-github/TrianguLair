# Security policy

TrianguLair encrypts places end to end and keeps them on storage the user chooses. A security bug can expose where
people live, work and go, so reports are taken very seriously.

**Status: beta, not audited.** No external security audit has been done yet. The encrypted format (v4) went through
five internal reviews (`docs/reviews/`) by reviewers who did not write the code, and the sync, lists, devices and
photos code through one review each, but none of them is an independent professional audit. The specification plans
an external audit before the first public release. Until then, do not rely on TrianguLair to protect anyone at risk.

## Reporting a vulnerability

- **Do not open a public issue, discussion or pull request** about it.
- Report it privately through GitHub's private vulnerability reporting: the repository's **Security** tab ›
  **Report a vulnerability** (or
  [this link](https://github.com/ndx1905-github/TrianguLair/security/advisories/new)). Only the maintainers see the
  report, and the fix can be prepared in a private fork attached to it.
- If that button is not available to you (GitHub offers it on public repositories only, and the repository is still
  private during the beta), open an issue titled **"Security: private contact needed"** with **no details at all**;
  a maintainer will contact you privately.
- Include what you found, its impact, the version or commit, and how to reproduce it (a test vector or a failing test
  is ideal). Do not include real people's data.

There is no e-mail address for reports and no bug bounty.

## What happens next

- Acknowledgment within 7 days.
- An assessment, and a fix or a mitigation plan, shared with you through the private report.
- Coordinated publication within 90 days at most, sooner once a fix is released; you are credited unless you prefer
  not to be. Security fixes are released first, before other changes.

## Scope

In scope:

- the encrypted format and its reference implementation, `packages/crypto` (identity and keys, signed index, packs,
  wraps, invitation and return links, vault, transfer blob; specified in `docs/format/`);
- sync and sharing, `packages/sync` (publishing, reading friends, lists, devices, revocation, photos);
- storage adapters, `packages/storage` (WebDAV, S3, SFTP, HTTPS; credentials, redirects, size limits);
- the app, `apps/mobile` (key and credential storage, app lock, remote wipe, local database encryption, deep links,
  what is shown to whom);
- the release builds and workflows in `.github/workflows/`;
- disagreements between the code and the documented format or threat models (`docs/format/`, `THREATS.md`) that
  weaken a promise.

Out of scope: the storage servers themselves (Nextcloud, S3 providers, …), OpenStreetMap and the other open-data
services, and the sideloading tools used to install the iPhone beta (Sideloadly, AltStore). Report those to their
projects.

## Threat model

The known limits of the format are in [packages/crypto/THREATS.md](packages/crypto/THREATS.md) and those of sync in
[packages/sync/THREATS.md](packages/sync/THREATS.md). In short:

**Protected against:**

- the **storage host**, or anyone with access to the storage: reading the content, or modifying it without detection
  (encryption, signatures, anonymous wraps, padding, rollback checks);
- a **network observer**: content (HTTPS everywhere, and the content is encrypted anyway);
- **removed friends** and **holders of an old list link**: reading new or re-encrypted content;
- an **impersonator** sending a fake invitation or answer: one answer per invitation, warnings, the safety code;
- a **thief of an ordinary device**, once the device is declared lost: no new content, no new invitations in your
  name; the master key is not on ordinary devices;
- someone who intercepts an **invitation or transfer link**: short lifetimes, a single answer, a separate code.

**Not protected against (known and accepted):**

- what the storage host and the network can still see: data volume, update dates, which storages are read, readers'
  IP addresses, and so roughly who follows whom;
- what OSM, tile and search services see: the areas viewed and the searches, with an IP address;
- copies a friend made deliberately (screenshots, export, a modified app) before losing access;
- what a stolen device could read or do between the theft and "Declare a device lost";
- a user who accepts an invitation without comparing the safety code;
- a phone with spyware or rooted / jailbroken, a state-level adversary targeting a person, physical coercion, network
  anonymity (no Tor-style routing), and future quantum computers (v1).

A report showing that one of the "protected against" items does not hold is exactly what we are looking for.
Reports about the "not protected" items are welcome too when they show a cheaper attack than the one described.
