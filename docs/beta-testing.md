# Testing the TrianguLair beta

Thanks for helping! TrianguLair is an app to save your favorite places on a map and share them with friends, with
everything encrypted. This is its **first beta**: it has never been used on a real phone before, so things will break.
That is exactly what we want to find out.

Before you start:

- **Keep a copy of anything you care about.** In the app: list view (the list icon) › *Import and export* ›
  *Export*. Beta versions may lose data.
- You will get the app from the person who invited you: a link to the GitHub release, or the file itself. The files
  are named like `TrianguLair-0.9.0-beta.1.apk` (Android) and `TrianguLair-0.9.0-beta.1-unsigned.ipa` (iPhone).

## Android

You need a reasonably recent Android phone with a few hundred MB free.

1. Download `TrianguLair-<version>.apk` on the phone (or copy it from a computer by cable, a cloud drive or a message
   to yourself).
2. Open the file (from the notification, the *Files* app or the browser's downloads).
3. Android says that this app is not allowed to install unknown apps: tap **Settings**, turn on **Allow from this
   source**, then go back. (This allows the app you opened the file with, Chrome or Files for example. You can turn
   it off again afterwards.)
4. Tap **Install**. If Play Protect warns about an unknown app: *More details* › **Install anyway**.
5. Open TrianguLair.

**Updating**: install the next beta's APK the same way, over the old one: your places stay.

## iPhone

Apple only lets apps from the App Store be installed normally. For the beta we use a free trick: a program on your
computer signs the app with **your own Apple ID** and puts it on your iPhone. Details and alternatives:
[run-on-iphone.md](run-on-iphone.md#without-xcode-ci-build--sideloadlyaltstore).

You need:

- an iPhone on iOS 16 or later and its USB cable;
- a Windows or Mac computer;
- an Apple ID (a free one is enough; a second Apple ID made just for this is a good idea, see "Privacy" below).

Steps:

1. On the computer, install **[Sideloadly](https://sideloadly.io)**. On Windows, also install iTunes and iCloud
   *from Apple's website* (not the Microsoft Store versions): Sideloadly's site explains it.
2. Download `TrianguLair-<version>-unsigned.ipa` to the computer.
3. Plug in the iPhone, unlock it, and tap **Trust this computer** if asked.
4. Open Sideloadly, drag the `.ipa` into it, check that your iPhone is selected, type your Apple ID, then **Start**.
   Type your Apple ID password when asked (and the code Apple sends you, if any).
5. On the iPhone, the first time:
   - if it asks for **Developer Mode**: *Settings › Privacy & Security › Developer Mode* › on, then restart and
     confirm;
   - *Settings › General › VPN & Device Management* › your Apple ID › **Trust**.
6. Open TrianguLair.

Limits of the free method:

- **The app stops opening after 7 days.** To renew it, plug in the iPhone and do step 4 again with the same file and
  the same Apple ID: your places stay. Do the same with a newer `.ipa` to update.
- At most 3 apps installed this way on one iPhone.
- Invitation and list links open in Safari instead of the app: copy the link and paste it in the app (*Invite* or
  *Follow a list* screens).

## What to test

Use it as you would really use it, and tell us about anything that crashes, looks wrong, is slow or is confusing.
Some ideas, from the most important:

1. **First launch**: create your profile, save the recovery kit (write down the 12 words and keep them private).
2. **Your places**: add a few places (search a name, pick one nearby, or long-press the map), add tags, a status, a
   comment, a price, a photo. Close the app and open it again: everything should still be there.
3. **The map and the list**: zoom out with many places, filters ("open now", your tags), search in the list.
4. **Zones**: draw a zone, or pick a neighborhood.
5. **Import**: if you used Google Maps or Mapstr, import your saved places (Google Takeout or a Mapstr export).
6. **Sharing** (needs a storage, for example a Nextcloud account): connect it in *Settings › Storage*, invite a
   friend who also has the beta, check that they see your shared places and not your private ones, and that
   changes appear in *What's new*.
7. **Lists**: make a list and share its link; follow someone else's list.
8. **Phone things**: the camera when scanning a QR code, the location permission at first launch, the app lock (Face ID, fingerprint or
   code), dark mode, turning the phone sideways, airplane mode and back.

## Reporting a bug

On GitHub, open a new issue on the project and pick **Bug report**
(<https://github.com/ndx1905-github/TrianguLair/issues/new/choose>). It asks for:

- your **device** (brand and model) and **OS version** (Android: *Settings › About phone*; iPhone: *Settings ›
  General › About*);
- the **app version** (the file name you installed, for example `0.9.0-beta.1`);
- the **steps** that lead to the problem, what happened and what you expected.

The project is private during the beta: you need a GitHub account that the person who invited you has added to it.
If you do not have one, send them the same information by message.

A screenshot or a short screen recording helps a lot, as long as nothing private is on it. For sync problems, a
screenshot of *Settings › Sync status › Technical log* helps too: it never contains your places, comments or keys.

## Privacy reminders

- **This beta has not had a security audit.** Do not save places that would put someone at risk if they leaked (a
  shelter, the home of someone hiding from someone).
- **Never share your 12 words or your recovery kit**, not even with us: nobody from the project will ever ask for them.
  The same goes for your storage password.
- Places are **shared with your friends by default**; set a place to *private* if it should stay on your phone only.
  Public lists can be read by anyone with the link: the app warns you when a place looks like a home.
- Removing a friend stops them from seeing your new and updated places, but cannot erase copies they already made
  (screenshots, exports).
- On iPhone, Sideloadly sends your Apple ID and password to Apple on your behalf. Use a second Apple ID if that
  bothers you.
- Bug reports on GitHub are visible to everyone with access to the project: no recovery words, passwords, invitation
  links or private addresses in them.
- The app talks directly to open-data services (OpenStreetMap, OpenFreeMap, Wikimedia Commons, Panoramax): they see
  the area of the map you look at and your searches, with your IP address, but no account and none of your places.
