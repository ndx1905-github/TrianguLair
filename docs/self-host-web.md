# Host the TrianguLair web app yourself (YunoHost)

The web version of TrianguLair is an **installable web app** (a "PWA"): you put a folder of files on
your own web server, your friends open its address, add it to their Home Screen, and it then opens
like an app, also **offline**. On an iPhone this avoids the free sideloading route (an app that stops
opening after 7 days and must be installed again).

This guide is written for a [YunoHost](https://yunohost.org) server and a Nextcloud used as the
storage. It uses two example addresses; replace them with yours everywhere:

| | Example | What runs there |
|---|---|---|
| **Server A** | `https://cloud.example.org` | Nextcloud, at the root of its domain: your storage |
| **Server B** | `https://triangulair.example.org` | the TrianguLair web app, at the root of its own (sub)domain |

Servers A and B can be two machines or one YunoHost with two domains: the steps are the same.

Contents:

1. [Which file to download](#1-which-file-to-download)
2. [Server B: install "My webapp" and upload TrianguLair](#2-server-b-install-my-webapp-and-upload-triangulair)
3. [Server A: let the web app talk to Nextcloud (CORS)](#3-server-a-let-the-web-app-talk-to-nextcloud-cors)
4. [Friends' storages](#4-friends-storages)
5. [Install the app on a phone](#5-install-the-app-on-a-phone)
6. [Update to a new version](#6-update-to-a-new-version)
7. [Other setups: a sub-path, or the same domain as Nextcloud](#7-other-setups-a-sub-path-or-the-same-domain-as-nextcloud)
8. [Limits of the web app on an iPhone](#8-limits-of-the-web-app-on-an-iphone)
9. [Troubleshooting](#9-troubleshooting)
10. [Building it yourself](#10-building-it-yourself)

## What you need to know first

- **HTTPS is required.** Browsers only run the part that makes the app work offline (the
  *service worker*) on `https://` addresses. YunoHost gives every domain a free Let's Encrypt
  certificate: make sure server B's domain has one (webadmin › Domains › your domain ›
  Certificate).
- **The web app keeps your data in the browser.** Your keys and places live in that browser (or that
  Home Screen app) only, and are less protected than in the phone apps: the local database is not
  encrypted, and a browser can clear its data. **Keep your recovery kit (the 12 words) safe**: it is
  the only way back if the browser loses its data. Settings › *Storage in this browser* shows
  whether the browser promised to keep it.
- **The web app can only use storages that allow its address** (step 3). That is your own storage,
  and also **each friend's storage**, since the app reads your friends' places from their servers
  (step 4). The phone apps are not affected by any of this.

## 1. Which file to download

Each release (the repository's **Releases** page) has two web zips:

| File | For an address like |
|---|---|
| `TrianguLair-web-<version>-root.zip` | `https://triangulair.example.org/` (the root of a domain): **this guide** |
| `TrianguLair-web-<version>.zip` | `https://cloud.example.org/triangulair/` (the sub-path `/triangulair/`; see [section 7](#7-other-setups-a-sub-path-or-the-same-domain-as-nextcloud)) |

The address is built into the files: a "root" build does not work under a sub-path, and the other
way round. Check the download against `SHA256SUMS.txt` of the same release:

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Unzip it: you get one folder, `TrianguLair-web-<version>-root/`. Its **contents** go on the server.

## 2. Server B: install "My webapp" and upload TrianguLair

[My webapp](https://apps.yunohost.org/app/my_webapp) (`my_webapp`) is YunoHost's app for "a folder
of web pages that I upload myself". TrianguLair needs nothing else: no PHP, no database.

### 2.1 The domain

If `triangulair.example.org` is not on your YunoHost yet: webadmin › **Domains** › **Add domain**,
set its DNS records as YunoHost suggests (webadmin › Domains › the domain › DNS), then install a
**Let's Encrypt certificate** for it (same page › Certificate).

### 2.2 Install My webapp

Webadmin › **Applications** › **Install** › search "My webapp", then:

- **Domain**: `triangulair.example.org`; **path**: `/`;
- **Who can access**: **Visitors** (everyone). The files are the same for everybody and hold no
  data: your places stay in each person's browser and, encrypted, on your storage. If you restrict
  it to YunoHost users, the Home Screen app and its offline files cannot be fetched without the
  YunoHost login, and your friends need a YunoHost account;
- **SFTP**: enabled, with a password you choose (you can change it later in webadmin ›
  Applications › My webapp › My Webapp configuration);
- **PHP version**: "none" if it is offered (TrianguLair does not use PHP); **database**: none.

Or on the command line (as root on server B; answer the questions it asks):

```sh
yunohost app install my_webapp
```

When it is installed, open `https://triangulair.example.org/`: the default page shows the SFTP
user name (`my_webapp` for the first instance, `my_webapp__2` for a second one…), host and port.

### 2.3 Upload the files by SFTP

With [FileZilla](https://filezilla-project.org) (or any SFTP client):

1. Connect: protocol **SFTP**, host `triangulair.example.org`, port **22** (or your SSH port), user
   `my_webapp`, the password from 2.2.
2. Open the **`www`** folder. Delete the default `index.html` that is there.
3. Upload **everything inside** `TrianguLair-web-<version>-root/` into `www/` (not the folder
   itself): you should see `www/index.html`, `www/sw.js`, `www/manifest.webmanifest`, `www/_expo/`,
   `www/assets/`, `www/icons/`, `www/error/`, …

From a terminal instead:

```sh
cd TrianguLair-web-<version>-root
sftp my_webapp@triangulair.example.org
sftp> cd www
sftp> rm index.html
sftp> put -r .
sftp> bye
```

Open `https://triangulair.example.org/`: TrianguLair starts.

Links such as `https://triangulair.example.org/l#…` and reloading any screen work without changing
the server's configuration: the zip has a copy of the app for every screen, and `www/error/404.html`
(the page My webapp shows for an unknown address) is the app too.

## 3. Server A: let the web app talk to Nextcloud (CORS)

The app at `https://triangulair.example.org` sends requests to `https://cloud.example.org`. Browsers
allow this only if the server answers with the right **CORS headers** (Cross-Origin Resource
Sharing): which page may talk to it, with which methods and headers, and which answer headers that
page may read. Nextcloud does not send them for WebDAV, and it answers the browser's "may I?"
question (the *preflight*, an `OPTIONS` request without a password) with `401`. So nginx on server A
must answer the preflight itself and add the headers.

What the rule allows, for **your web app's address only** (never `*`: these requests carry your
Nextcloud app password):

| | Value |
|---|---|
| `Access-Control-Allow-Origin` | `https://triangulair.example.org` (exactly the address bar's scheme and host, no path, no trailing `/`) |
| `Access-Control-Allow-Methods` | `GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, POST, OPTIONS` (`POST`: the Nextcloud browser login and share link) |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match, OCS-APIRequest, Accept` |
| `Access-Control-Expose-Headers` | `ETag, OC-ETag, Content-Length, Last-Modified` (without it the app cannot see `ETag`, which it needs to write safely) |
| `Access-Control-Max-Age` | `3600` (the browser asks again at most once an hour) |
| `Access-Control-Allow-Credentials` | not sent: the app sends the password itself (`Authorization`), never Nextcloud's cookies |

Where it applies:

- `/remote.php/dav/…`: your TrianguLair folder (WebDAV);
- `/ocs/v2.php/…`, `/index.php/login/v2…`: the account check, the automatic share link and "Sign in
  with Nextcloud" in the storage settings (without them, fill in the app password and share link by
  hand);
- `/public.php/dav/…`: your **public share link**, through which friends read your encrypted files.
  Readable from **any** address (`Access-Control-Allow-Origin: *`, read only: `GET` and `HEAD`), so
  that friends who use the web app, on any server, can read it. Everything there is encrypted.

### 3.1 Add the rule

YunoHost includes every `.conf` file of `/etc/nginx/conf.d/<domain>.d/` in that domain's server
block. YunoHost and app upgrades do not touch files they did not create there, so the rule stays
through upgrades (YunoHost's own files and Nextcloud's `nextcloud.conf` in the same folder are
rewritten; leave them alone).

On server A, as root:

```sh
nano /etc/nginx/conf.d/cloud.example.org.d/triangulair-cors.conf
```

Paste this, and change the address on the first `set` line to your web app's:

```nginx
# TrianguLair web app -> this Nextcloud: CORS. See docs/self-host-web.md in TrianguLair.
# The web app's address, exactly as in the browser's address bar (scheme + host, no path):
set $tl_app_origin "https://triangulair.example.org";

set $tl_cors "";
if ($http_origin = $tl_app_origin) {
    set $tl_cors "app";
}
# The owner's WebDAV folder, the account check and share link (OCS), the browser login (Login Flow v2).
if ($uri ~ "^/(remote\.php/dav|ocs/v[12]\.php|index\.php/login/v2|login/v2)(/|$)") {
    set $tl_cors "${tl_cors}+owner";
}
# Public share links (friends read the owner's encrypted files): readable from any web page.
if ($uri ~ "^/public\.php/dav/") {
    set $tl_cors "${tl_cors}+public";
}

set $tl_allow_origin "";
set $tl_allow_methods "";
set $tl_allow_headers "";
set $tl_expose "";
set $tl_max_age "";
if ($tl_cors = "app+owner") {
    set $tl_allow_origin $http_origin;
    set $tl_allow_methods "GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, POST, OPTIONS";
    set $tl_allow_headers "Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match, OCS-APIRequest, Accept";
    set $tl_expose "ETag, OC-ETag, Content-Length, Last-Modified";
    set $tl_max_age "3600";
}
if ($tl_cors ~ "\+public$") {
    set $tl_allow_origin "*";
    set $tl_allow_methods "GET, HEAD, OPTIONS";
    set $tl_expose "ETag, Content-Length, Last-Modified";
    set $tl_max_age "3600";
}

# Preflight (OPTIONS) from the app: answered here, before Nextcloud, which would answer 401.
set $tl_preflight "${tl_cors}:${request_method}";
if ($tl_preflight = "app+owner:OPTIONS") {
    return 204;
}
if ($tl_preflight ~ "\+public:OPTIONS$") {
    return 204;
}

# Empty values add nothing: every other request is left as it was.
more_set_headers "Access-Control-Allow-Origin: $tl_allow_origin";
more_set_headers "Access-Control-Allow-Methods: $tl_allow_methods";
more_set_headers "Access-Control-Allow-Headers: $tl_allow_headers";
more_set_headers "Access-Control-Expose-Headers: $tl_expose";
more_set_headers "Access-Control-Max-Age: $tl_max_age";
```

Then check the configuration and reload nginx:

```sh
nginx -t && systemctl reload nginx
```

If `nginx -t` reports an error, fix or remove the file before reloading: nginx keeps running with
the previous configuration until then.

Notes:

- `more_set_headers` (rather than nginx's `add_header`) is what YunoHost's own configuration uses.
  It adds the headers to every answer, errors included, and they are not lost in Nextcloud's own
  `location` blocks.
- **Nextcloud under a sub-path** (`https://cloud.example.org/nextcloud/`): put the sub-path in both
  `$uri` lines, e.g. `"^/nextcloud/(remote\.php/dav|ocs/v[12]\.php|index\.php/login/v2|login/v2)(/|$)"`
  and `"^/nextcloud/public\.php/dav/"`.
- **Several addresses** of the web app (say, also a test one): copy the first `if` block with the
  other address, each setting `$tl_cors "app"`.
- Not on YunoHost: the same lines work in any nginx `server { }` block that has the
  [headers-more](https://github.com/openresty/headers-more-nginx-module) module (Debian and Ubuntu:
  `libnginx-mod-http-headers-more-filter`). For Apache, the app's storage test shows a snippet.

### 3.2 Check it

From any computer, ask like the browser does (replace both addresses and `alice` with your
Nextcloud user name):

```sh
curl -si -X OPTIONS 'https://cloud.example.org/remote.php/dav/files/alice/TrianguLair/' \
  -H 'Origin: https://triangulair.example.org' \
  -H 'Access-Control-Request-Method: PROPFIND' \
  -H 'Access-Control-Request-Headers: authorization,depth,if-match'
```

Expected: `HTTP/2 204` (not `401`), with these lines among the headers:

```text
access-control-allow-origin: https://triangulair.example.org
access-control-allow-methods: GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, POST, OPTIONS
access-control-allow-headers: Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match, OCS-APIRequest, Accept
access-control-expose-headers: ETag, OC-ETag, Content-Length, Last-Modified
access-control-max-age: 3600
```

A real request, with your Nextcloud user name and an **app password** (Nextcloud › Settings ›
Security › Devices & sessions):

```sh
curl -si -X PROPFIND 'https://cloud.example.org/remote.php/dav/files/alice/' \
  -u 'alice:app-password' -H 'Depth: 0' -H 'Origin: https://triangulair.example.org' | head -20
```

Expected: `HTTP/2 207` with the same `access-control-allow-origin` line. With another `Origin` (try
`https://example.net`), no `access-control-…` line at all: other sites still cannot use your
Nextcloud.

Your public share link (the part after `/s/` in `https://cloud.example.org/s/AbCdEf…`), as a friend's
web app would read it:

```sh
curl -sI 'https://cloud.example.org/public.php/dav/files/AbCdEf/' -H 'Origin: https://example.net'
```

Expected: `access-control-allow-origin: *` and `access-control-expose-headers: ETag, …` (the status
itself may be `200`, `207`, `404` or `405`, depending on what is in the folder).

Then in the web app: Settings › Storage › Storage settings, connect your Nextcloud, and run the
**connection test**: every step should be green. A step that says "it does not allow the web
version's address (CORS)" means the rule does not apply yet: check the address in `$tl_app_origin`
(scheme, no trailing `/`) and that nginx was reloaded.

## 4. Friends' storages

The app reads each friend's places from **their** storage, at the read address they gave (for
Nextcloud, their public share link). The phone apps can read any address; the **web app** can only
read storages that allow it:

- a friend on **Nextcloud** adds the same rule on their server. They need only the "public" part if
  they use the phone apps themselves, but the whole file does no harm (with `$tl_app_origin` set to
  the address of the web app *they* use, if any);
- a friend on **S3** adds the bucket CORS rules that the app's storage test shows (`GET`, `HEAD` from
  `*`, `ETag` exposed);
- a friend on a **plain HTTPS** folder (static hosting) needs `Access-Control-Allow-Origin: *` and
  `Access-Control-Expose-Headers: ETag` on it.

Until they do, their places do not load in the web app: Settings › Sync status shows "Their storage
could not be reached yet" for them, with a hint about this, while the same friend's places load fine
in the phone apps.

## 5. Install the app on a phone

### iPhone and iPad (Safari)

1. Open `https://triangulair.example.org/` in **Safari**.
2. Tap **Share** (the square with an arrow) › **Add to Home Screen** › **Add**. (Since iOS 16.4,
   Chrome and Edge on the iPhone offer the same in their Share menu.)
3. **Open TrianguLair from the Home Screen icon** and set it up there: create your identity, restore
   it with your 12 words, or add it as a new device of your identity. The Home Screen app has its
   **own storage, separate from Safari**: what you set up in a Safari tab is not in the Home Screen
   app, and the other way round.
4. Settings › *Storage in this browser* should say "Kept". Save your recovery kit if you have not
   yet.

### Android (Chrome, Edge, Samsung Internet, Firefox)

Open `https://triangulair.example.org/`, then the browser's menu › **Install app** (or **Add to Home
screen**). Chrome may also offer it in a banner. The app then has its own icon and window, and
appears in the list of apps. On Android, the TrianguLair APK (phone app) is usually the better
choice: it can open invitation links directly, and keeps its data in the system's protected storage.

### Computer

Chrome and Edge show an **Install** icon at the right of the address bar. Firefox and Safari on a
Mac use the site like a normal page (Safari 17+: File › Add to Dock).

## 6. Update to a new version

1. Download the new `TrianguLair-web-<version>-root.zip` (check it with `SHA256SUMS.txt`) and unzip it.
2. Upload its contents into `www/` again, replacing the files (SFTP: `put -r .` in `www`). You can
   delete the old `www/_expo/` folder first; leftover old files do no harm.
   For a clean switch, upload `index.html` and `sw.js` **last**.
3. That's all. The next time someone opens the app (or within an hour if it stays open), it
   downloads the new version in the background and shows **"A new version of TrianguLair is ready ·
   Reload"**. *Reload* saves and restarts on the new version; *Later* keeps the current one until
   the app is next closed and opened.

Your data is not touched by an update: it stays in each browser, and on your storage.

Nothing to change on server A, unless the release notes say so.

## 7. Other setups: a sub-path, or the same domain as Nextcloud

### The web app under a sub-path

Use `TrianguLair-web-<version>.zip` (built for `/triangulair/`) and install My webapp with **path**
`/triangulair`. The app is then at `https://<domain>/triangulair/`. For another sub-path, build it
yourself with `TL_WEB_BASE=/your-path` ([section 10](#10-building-it-yourself)).

### On the same domain as Nextcloud (no CORS)

If the web app is on the **same domain** as your Nextcloud, the browser sees one site and asks no
CORS question: section 3 is not needed for your own storage (friends' storages still need it).

- **Nextcloud at the root** (`https://cloud.example.org/`): install My webapp on
  `cloud.example.org` with path **`/triangulair`**, and upload the sub-path zip. YunoHost serves
  `/triangulair/` from My webapp and everything else from Nextcloud.
- **Nextcloud under a sub-path** (`https://cloud.example.org/nextcloud/`): the same, My webapp at
  `/triangulair` with the sub-path zip. (The root zip at `/` would also work, but a sub-path keeps
  the two apps clearly apart.)

The app's offline part only ever answers for its own folder (`/triangulair/`), so it never gets in
the way of Nextcloud.

**But think twice**: on one domain, every page of that domain can read the web app's data in the
browser, including your keys. A security hole in Nextcloud or in any Nextcloud app (a page that
runs a hostile script) would then reach TrianguLair's keys too. A separate (sub)domain, as in this
guide, keeps them apart; that is why it is the recommended setup.

## 8. Limits of the web app on an iPhone

- **Data lives in the Home Screen app.** Deleting the icon deletes the app's data (places, keys).
  Keep the recovery kit. A site used only in a Safari tab can lose its data after 7 days without a
  visit; the Home Screen app is exempt from that rule, and the app asks for persistent storage when it starts.
- **Links do not open the Home Screen app.** An invitation or list link opens Safari, which has a
  separate storage: copy the link and paste it in the app (Invite › received invitation, or Follow
  a list). The same holds on Android for the web app (the APK opens links directly).
- **Sync only while the app is open.** iOS suspends web apps in the background: no sync, no
  notifications in the background. Changes made offline are sent the next time the app is opened
  online.
- **Less protection than the phone apps.** No Face ID / Keychain: the app lock uses a code of your
  own; the local database is not encrypted; keys are encrypted with a browser key that scripts of
  the same site could use. A dedicated domain (section 2) limits who those scripts can be.
- **No install button.** Safari never offers the installation itself: the user goes through Share ›
  Add to Home Screen.
- **Storage space** is limited by iOS (a share of the free disk space), shared by the database, the
  photo cache and the app's files (about 7 MB).
- **Updates** are applied when the app is opened, after "Reload"; iOS may keep an old version
  running in the background until the app is closed from the app switcher.
- **Camera, location, files**: each asks for permission inside the web app, and iOS may ask again
  more often than for a store app.

## 9. Troubleshooting

| What you see | What to check |
|---|---|
| A blank page, or "You need to enable JavaScript" | Wrong zip for the address (root vs sub-path): see [section 1](#1-which-file-to-download). The browser's console says which file it could not load. |
| No "Add to Home Screen" as an app / no install offer, the app does not open offline | The address must be `https://` with a valid certificate. The app files must be public ("Visitors" in My webapp's permissions). |
| The storage test says CORS | [Section 3.2](#32-check-it): run the `curl` checks; check `$tl_app_origin`; `nginx -t && systemctl reload nginx`. |
| A friend's places never load in the web app, but do on phones | Their storage needs the rule of [section 4](#4-friends-storages). |
| "Reload" never appears after an update | Close every tab or window of the app and open it again. Check that `sw.js` on the server is the new one (`curl -s https://triangulair.example.org/sw.js \| head -c 120` shows the version). |
| Settings › Storage in this browser says "Not guaranteed" | Install the app on the Home Screen (iPhone) or with *Install app* (Android, computer), open it from there, and tap *Ask the browser to keep my data*. |

## 10. Building it yourself

From a clone of the repository, in `apps/mobile` (Node.js 22):

```sh
npm ci --workspaces=false
npm run export:web:pwa                             # root of a domain: dist-web/
TL_WEB_BASE=/triangulair npm run export:web:pwa    # under /triangulair/: dist-web/
node scripts/check-pwa.mjs dist-web /triangulair   # optional: checks the manifest and service worker
```

Upload the contents of `dist-web/` as in section 2.3. `npm run export:web:pwa:fixtures` makes the
test build that the end-to-end tests use (`e2e/pwa.spec.ts`).

How it works: `expo export` builds the app (`TL_WEB_BASE` sets expo-router's base path), then
`scripts/pwa.mjs` writes `manifest.webmanifest`, the icons' and iOS tags into `index.html`, `sw.js`
(from `web/service-worker.js`, with the list of the build's files and a version derived from their
contents) and a copy of the app for every screen. The service worker caches only the app's own files,
one cache per build (the previous one is deleted after an update); it never stores what the app
fetches from storages, map tiles or OpenStreetMap services, and never answers for addresses outside
the app's folder.
