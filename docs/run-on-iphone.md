# Run TrianguLair on your own iPhone (free)

This installs a development build on **your own iPhone** with a **free Apple ID**:
no Apple Developer Program, no Expo account. Limits of free provisioning:

- the app **expires after 7 days** (re-run the install command to renew it);
- at most 3 apps signed this way per device;
- no universal links: invitation and list links open in the browser; paste them
  in the app (Invite / Follow a list screens) instead.

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

## What to try

- First launch, add places, filters, zones, lists, import/export (local only).
- Sharing: connect a storage (Nextcloud: server address + an app password, see
  Settings › Storage), invite a friend who also has a build, or a second
  browser on the web test build (`npx expo start --web`).
- Report anything odd: this is the first time the native app runs on a device.

## Known gaps on phones (see docs/spec-coverage.md)

S3 storage, SFTP and the Nextcloud browser login are not ready on phones yet;
"offline" detection, database encryption and the map at 10,000 pins are being
worked on.
