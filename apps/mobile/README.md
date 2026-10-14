# TrianguLair mobile app (phase 0 skeleton)

An Expo / React Native app for iOS and Android. The web build is for testing only.
It shows a full-screen OpenStreetMap map with sample places in Paris, tag-colored pins,
a collapsible tag filter bar and a bottom sheet for the selected place.

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

### Checks

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest: pin bands, SVG, filtering, layout, theme, camera
```

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
src/app/              expo-router screens (_layout, index = map screen)
src/components/map/   Map.native.tsx, Map.web.tsx, Map.tsx (type fallback), types.ts
src/components/       FilterBar, PlaceSheet, TagChip, MapAttribution
src/pins/             bands.ts (band computation), pinSvg.ts (pin SVG), fromPlace.ts
src/places/           types, mockPlaces (15 places in Paris), filter.ts
src/theme/            tags.ts (10 tag colors), icons.ts (MDI icon paths), colors.ts (light/dark UI)
src/config.ts         map style URLs, attribution, initial camera
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

Both platforms use the same SVG string (`pinSvg()`):

- **Web:** inline SVG in a `maplibregl.Marker` HTML element.
- **Native:** `SvgXml` from react-native-svg inside a MapLibre RN `Marker`.

This is simple, and native and web look the same, which is good enough for tens or a few hundred
pins. **Later:** move native rendering to a `GeoJSONSource` + `SymbolLayer`, with one pre-rendered
image per color/icon combination (made at build time or with Skia) and clustering.

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

`docs/screenshot-web.png` (phone, place sheet open), `docs/screenshot-web-tablet.png` (tablet, side
panel) and `docs/screenshot-web-dark.png` (phone, dark) were taken from the web export with Playwright
(Chromium). The sandbox that produced them had no access to `tiles.openfreemap.org`, so the style
request was answered with a background-only placeholder: the base map is blank, pins and UI are real.
