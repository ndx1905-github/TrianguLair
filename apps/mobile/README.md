# TrianguLair mobile app

An Expo / React Native app for iOS and Android. The web build is for testing only.
Wired to the workspace packages `@triangulair/data` (local SQLite + document) and
`@triangulair/osm` (Overpass, Photon, opening hours, photos):

- **Map** (index): pins from `Repository.mapPins` for the visible area, clustering when zoomed
  out (T-103 basic), filter bar driven by my tags and OSM criteria (open now, terrace, happy
  hour, vegetarian), filtered display (matching pins in color, the others grey, faded, smaller).
- **Add a place** (`/add`, T-105): nearby OSM places around the map center sorted by distance,
  search as you type (Photon session) plus the local part (my and friends' places), long press /
  right click on the map or "drop a point" for a manual point; each candidate says "Already in my
  places" / "Saved by N friends"; the form sets tags (first = main), status, price, comment and its
  visibility, sharing.
- **Place card** (sheet on the map, side panel on wide screens, `/place/[id]` page; T-107 UI):
  category, address, opening line ("Open, closes at 10 pm"), happy hour, terrace/diet/cuisine/
  reservation/fee chips, free photos with credit lines, friends who saved it, my tags/status/price/
  comment/sharing (saved immediately), move to trash. OSM data is refreshed when stale.
- **List** (`/list`, T-104 basic): sort recent / distance / name, text search (FTS or fallback),
  same filter bar; two panes (list + card) on wide screens.
- **Import / export** (`/import`, T-114/T-115; link "Import / export" in the list header): pick a
  file (Google Takeout, KML/KMZ, GeoJSON, CSV with a column-mapping step, Mapstr and Pin Drop
  exports, which are **unverified** and flagged as such), match to OpenStreetMap with progress and
  cancel, preview (to check / found / manual points / no position, per-place choice among
  candidates, manual point or leave out; what each source tag becomes), batched write with
  progress and cancel, summary and undo for 7 days; export everything as GeoJSON (download or
  share sheet on web, share sheet on native). Logic in `@triangulair/import` (see its README).
  Native file access uses `expo-document-picker`, `expo-file-system` and `expo-sharing`
  (new native modules: a new development build is needed). Screenshots: `docs/*-import-*.png`.
- **i18n**: English and French (`src/i18n`), device language, `EXPO_PUBLIC_LOCALE` or `?lang=fr`
  on web to force one. No UI string is hard-coded in components.

- **Expo SDK 57** (React Native 0.86, New Architecture, React 19.2), TypeScript, expo-router
- **Map:** `@maplibre/maplibre-react-native` 11 on native and `maplibre-gl` 5 on web, behind one
  component interface (`src/components/map/types.ts`)
- **Base map:** OpenFreeMap Positron (`https://tiles.openfreemap.org/styles/positron`). The dark
  mode uses OpenFreeMap `dark`. Both URLs are set in `src/config.ts`.

## Run

Install dependencies from this folder. The app currently has its own lockfile, like the other packages:

```sh
npm install --workspaces=false
```

The workspace packages are used from their TypeScript sources (`../../packages/*/src`), with no
build step and no change to the root `package.json`:

- `metro.config.js` watches `packages/data`, `packages/osm` and `packages/import`, maps their names to their folders
  (`extraNodeModules`, package `exports` honored) and resolves their runtime dependencies
  (`yjs` and its `lib0`, `opening_hours`) from this app's `node_modules`. On web it empties
  sql.js's Node-only imports. Outside fixture mode it replaces `src/osm/fixtures.ts` by an empty
  module, so the OSM fixture JSON never reaches a production bundle.
- `tsconfig.json` maps the package names to their sources (`paths`) and allows `.ts` import
  extensions; `vitest.config.mts` has the same aliases.

### Web (testing)

```sh
npx expo start --web          # dev server
npx expo export --platform web # static build in dist/
```

### iOS / Android: development build (Expo Go is not supported)

MapLibre Native needs native code. Its config plugin is listed in `app.json`, so you need a
**development build**:

```sh
npx eas-cli@latest login
npx eas-cli@latest build --profile development --platform android   # or ios
# iOS simulator: --profile development-simulator
npx expo start --dev-client
```

You can also build locally with `npx expo run:android` / `npx expo run:ios` (needs Android Studio / Xcode).
`eas.json` defines three profiles: `development` (dev client, internal), `preview` (internal) and `production`.

The bundle ID / package `org.triangulair.app` is a **placeholder** until the final identifier is chosen.
Before the first EAS build, run `eas init` to link a project (it adds `extra.eas.projectId`).

### Data on each platform

- **Native**: `expo-sqlite` through the package's `ExpoSqliteDriver` (`src/data/openStore.native.ts`).
  `app.json` enables R*Tree (`customBuildFlags: -DSQLITE_ENABLE_RTREE=1`, needs a native rebuild).
  Type-checked, not run on a device yet (the document is Yjs, pure JavaScript, so Hermes is no
  longer a blocker).
- **Web**: sql.js (SQLite in WebAssembly, inline build) behind `SqlJsDriver` (`src/data/sqljsDriver.ts`),
  the database file saved to IndexedDB after each write (debounced, and on page hide). When
  IndexedDB is unavailable the data stays in memory and the map says so. sql.js has no R*Tree/FTS5:
  the package's fallback indexes are used.
- **Demo data**: on first launch the 15 sample places in Paris are seeded as tags, my saves (status,
  price, comments), a friend's saves ("Léa") and illustrative OSM info (opening hours, terrace,
  happy hours) so the filters have data (`src/data/demo.ts`).
- Owner id is a placeholder (`local-me`) until identity creation exists; the document actor is a
  per-device random id kept in localStorage / expo-sqlite's kv-store.

### OSM services, offline and fixture mode

All OSM calls go through one `createOsmClient()` (`src/osm/client.ts`). Failures never block a
screen: the add screen falls back to the places on this device ("Nearby, on this device") with a
clear message, the card keeps its cached info. **Fixture mode** answers every OSM request with the
osm package's test fixtures (synthetic places in the Marais), for offline demos:

```sh
EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web
```

In fixture mode the demo seed also saves "Trattoria Da Lucia" (a fixture place), so the add screen
shows "Already in my places".

### Checks

```sh
npm run typecheck   # tsc --noEmit (also type-checks the packages' sources used by the app)
npm test            # vitest: pins, clustering, filters, card wording, add-place logic, list query,
                    # sql.js driver + DataStore + demo seed, fixture fetch, i18n (en/fr parity),
                    # import screen logic
```

Screenshots in fixture mode: `python3 scripts/shots.py docs importer` (phone) or `importer_tablet`
(the import preview uses `packages/import/test/fixtures/kml/my-maps.kml`, matched against the OSM
fixtures; `SHOTS_BASE` overrides the server address).

## Configuration

`src/config.ts` reads these variables at build time:

| Variable | Default |
|---|---|
| `EXPO_PUBLIC_MAP_STYLE_URL` | `https://tiles.openfreemap.org/styles/positron` |
| `EXPO_PUBLIC_MAP_STYLE_URL_DARK` | `https://tiles.openfreemap.org/styles/dark` |

The attribution "© OpenStreetMap contributors, OpenFreeMap" is drawn by our own overlay
(`MapAttribution`), so it is always visible. When a place sheet is open, the overlay moves above it.

## Layout

```
src/app/              expo-router screens: index (map), list, add, place/[id], _layout (providers)
src/components/map/   Map.native.tsx, Map.web.tsx, Map.tsx (type fallback), types.ts, cluster.ts
src/components/       FilterBar, PlaceSheet, PlaceCard, SaveEditor, ScreenHeader, DataGate, ui
src/data/             DataProvider, openStore.{web,native}, sqljsDriver, webPersistence, demo, usePlaces
src/osm/              client (one OSM client), fixtureFetch + fixtures (fixture mode), errors
src/places/           pure logic: filters, clustering, model, card, add, list, camera
src/pins/             bands.ts, pinSvg.ts, build.ts (pins from places and the filter)
src/i18n/             core (plurals, placeholders), en, fr, provider
src/state/            AppState (filter, last map area, focus) shared by the screens
src/theme/            tags.ts (palette, demo tags, category icons), icons.ts, colors.ts
src/config.ts         map style URLs, attribution, initial camera, fixture flag
```

## Pins

- **Shape:** teardrop pin with an SVG `viewBox` of 40×52. The tip is the anchor point.
- **Tag colors:** the colors are saturated and set in `src/theme/tags.ts`.
- **Icon:** the icon of the first tag, drawn **white** with a dark halo. The halo is the same path
  drawn first with a dark stroke.
- **Several tags:** the round body is split into up to **3 horizontal color bands** of equal height,
  stacked in tag order and centered on the body. The tail takes the color of the last band.
  Tags hidden by the filter are removed from the bands.
- **Friends-only places** (`ownerIsMe: false`): the bands are drawn at 50% opacity over white, which
  gives a lighter pin, and the whole pin is slightly translucent.
- **Selected pin:** drawn 1.3× larger.
- **Filter active:** matching pins take the color and icon of the filtered tag; the others (and
  places lacking the information, spec "unknown info") are grey, 40% opacity and 0.72× smaller.
- **Clusters:** computed in JS on the viewport's pins (radius 56 px, none from zoom 15); a bubble in
  the majority color of its matching members, grey if none matches; tapping zooms in.

Both platforms use the same SVG string (`pinSvg()`):

- **Web:** inline SVG in a `maplibregl.Marker` HTML element.
- **Native:** `SvgXml` from react-native-svg inside a MapLibre RN `Marker`.

This is simple, and native and web look the same, which is good enough for tens or a few hundred
pins. **Later:** move native rendering to a `GeoJSONSource` + `SymbolLayer`, with one pre-rendered
image per color/icon combination (made at build time or with Skia) and engine-side clustering.

## Responsiveness and accessibility

- **Light/dark:** follows the system setting for both the UI and the map style. The "Theme" button in
  the filter bar cycles Auto / Light / Dark (in memory only for now; persistence comes with T-118).
- **Text size:** text follows the system font size. Chips and labels cap it with
  `maxFontSizeMultiplier`, and nothing uses a fixed height.
- **Layout:** pure size classes in `src/theme/layout.ts` (Material breakpoints: compact < 600 ≤ medium
  < 840 ≤ expanded), fed by `useWindowDimensions`. On wide windows (tablets, unfolded foldables,
  landscape phones) the filter bar becomes a floating panel with wrapped chips and the place card opens
  as a side panel on the right. On compact windows (phones, outer screens, Display Zoom) the chips
  scroll sideways and the card is a bottom sheet docked full width. Layout changes never reset state.
- **Initial camera:** fits all places in the visible area (`src/places/camera.ts`), computed once.

## Screenshots

Taken from the web export in fixture mode with Playwright (Chromium), clock set to Friday
23 October 2026, 18:30 in Paris (`scripts/shots.py`). The sandbox had no access to the tile server
or photo hosts: the map style is answered with a background-only placeholder (blank base map) and
photos with a placeholder image; pins, clusters, UI, data and credit lines are real.

| File | Shows |
| --- | --- |
| `docs/phone-map-clusters.png` | Map zoomed out: clusters in the majority tag color, multi-tag pins, friends' places faded |
| `docs/phone-map-filters.png` | Filters Bar + Terrace: matching pins in color, the others and their clusters grey |
| `docs/phone-place-card.png` | Card of an OSM place: opening line, address, chips, Panoramax photos with credits |
| `docs/phone-add-nearby.png` | Add screen: nearby places by distance, "Already in my places" |
| `docs/phone-add-search.png`, `docs/phone-add-form.png` | Search as you type, then the save form |
| `docs/phone-list.png`, `docs/phone-list-search.png` | List (recent), text search in comments |
| `docs/tablet-map-filter-card.png` | Tablet: "Open now" filter, card as side panel with happy hour |
| `docs/tablet-list.png` | Tablet: list by distance and card side by side |
| `docs/phone-dark-card.png` | Dark mode |
| `docs/phone-fr-add.png` | French UI |
