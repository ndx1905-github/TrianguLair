# Run TrianguLair on your own iPhone (free)

This installs a development build on **your own iPhone** with a **free Apple ID**:
no Apple Developer Program, no Expo account. Limits of free provisioning:

- the app **expires after 7 days** (re-run the install command to renew it);
- at most 3 apps signed this way per device;
- no universal links: invitation and list links open in the browser; paste them
  in the app (Invite / Follow a list screens) instead.

No Mac? See [Without Xcode: CI build + Sideloadly/AltStore](#without-xcode-ci-build--sideloadlyaltstore)
below.

You need a **Mac** (Apple Silicon or Intel) with macOS recent enough for the
current Xcode, a **USB cable**, and the iPhone on **iOS 16 or later**.

## 1. Install the tools on the Mac (once)

1. **Xcode** from the Mac App Store (free, large download). Open it once and
   accept the license; let it install the iOS platform it offers.
2. In Terminal:
   ```sh
   xcode-select --install          # command line tools (if not already there)
   brew install node@22 cocoapods  # needs Homebrew: https://brew.sh
   ```
3. Xcode › Settings › **Accounts** › `+` › Apple ID: sign in with your usual
   Apple ID. A "Personal Team" appears.

## 2. Get the code

The repository is private, so either:

- **GitHub Desktop** (simplest): sign in, *Clone repository* › `ndx1905-github/TrianguLair`; or
- **ZIP**: on github.com, *Code* › *Download ZIP*, then unzip.

## 3. Prepare the iPhone (once)

1. Plug it into the Mac, unlock it, tap **Trust this computer**.
2. iOS 16+: *Settings › Privacy & Security › **Developer Mode*** › on, restart,
   confirm.

## 4. Build and install

In Terminal, in the project folder:

```sh
cd apps/mobile
npm install --workspaces=false
export TL_FREE_SIGNING=1
export TL_IOS_BUNDLE_ID=com.yourname.triangulair   # anything unique to you
npx expo prebuild --platform ios --clean
npx expo run:ios --device --configuration Release
```

- `run:ios --device` lists connected iPhones: pick yours.
- The first build takes a while (CocoaPods + native compile).
- If Xcode complains about signing: open `ios/TrianguLair.xcworkspace`, select the
  app target › *Signing & Capabilities* › Team = **your Personal Team**, keep
  "Automatically manage signing", then run the last command again.
- `--configuration Release` makes a standalone app that works away from the Mac.
  For live reloading while developing, omit it and keep `npx expo start` running
  on the same Wi-Fi.

## 5. First launch on the iPhone

*Settings › General › **VPN & Device Management*** › your Apple ID › **Trust**.
Then open TrianguLair.

## Without Xcode: CI build + Sideloadly/AltStore

GitHub Actions can build the app on a Mac in the cloud and give you an **unsigned
`.ipa`**; a sideloading tool on Windows or a Mac then signs it with your Apple ID
and installs it.

1. On github.com: *Actions* › **Native iOS build** › *Run workflow* (branch
   `main`, "What to build" = `ipa`). It takes roughly 20–40 minutes; each run
   uses a good share of the private repo's free macOS minutes, so start it only
   when you need a new build.
2. When the run is green, open it and download the artifact
   `TrianguLair-ios-ipa-…` (a ZIP containing `TrianguLair-unsigned.ipa`; kept
   7 days). Unzip it.
3. Install with one of:
   - **[Sideloadly](https://sideloadly.io)** (Windows / macOS): plug in the
     iPhone, drag the `.ipa` in, enter your Apple ID, *Start*.
   - **[AltStore](https://altstore.io)** (AltServer on Windows / macOS, then
     AltStore on the iPhone): *My Apps* › `+` › pick the `.ipa`.
4. On the iPhone: Developer Mode on (step 3 above) and trust your Apple ID
   (step 5 above).

Caveats:

- **You give your Apple ID (and password, or an app-specific password) to a
  third-party tool**, which talks to Apple on your behalf. Prefer a secondary
  Apple ID if that bothers you.
- Same limits as free signing with Xcode: the app **expires after 7 days**
  (AltStore can refresh it over Wi-Fi while AltServer runs; with Sideloadly,
  install it again), 3 apps at most, no universal links.
- The build uses `TL_FREE_SIGNING=1`, bundle id `org.triangulair.app.dev` unless
  you set one in the workflow form; the tools may also rewrite it.

## What to try

- First launch, add places, filters, zones, lists, import/export (local only).
- Sharing: connect a storage (Nextcloud: server address + an app password, see
  Settings › Storage), invite a friend who also has a build, or a second
  browser on the web test build (`npx expo start --web`).
- Report anything odd: this is the first time the native app runs on a device.

## Known gaps on phones

S3 storage, SFTP and the Nextcloud browser login are not ready on phones yet;
"offline" detection, database encryption and the map at 10,000 pins are being
worked on.
