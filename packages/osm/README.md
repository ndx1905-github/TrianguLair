# @triangulair/osm

OpenStreetMap client for TrianguLair (tasks T-106, and the pure parts of T-107 and T-113): nearby places and place details from Overpass, search with Photon and Nominatim, typed place cards, opening hours, free photos (Wikimedia Commons, Panoramax) and closed-place detection. Fetch-based, no DOM: it runs in React Native, browsers and Node.

License: MPL-2.0. Dependency: [opening_hours](https://github.com/opening-hours/opening_hours.js) (LGPL-3.0-only, see Open questions).

```ts
import { createOsmClient, buildUserAgent, openingStatus, describeOpening } from '@triangulair/osm';

const osm = createOsmClient({
  userAgent: buildUserAgent({ name: 'TrianguLair', version: '0.1.0', contact: 'https://github.com/…' }),
  contactEmail: 'maintainers@…',          // Nominatim `email=`
  endpoints: settings.osmEndpoints,       // never hardcoded; defaults are the public instances
  cache: sqliteCache,                     // optional, any OsmCache
});

const around = await osm.overpass.nearby(here, { radius: 150 });          // nearest first
const session = osm.newSearchSession({ near: here, lang: 'fr' });          // search as you type
const results = await session.update(text);                                // Photon only
const card = await osm.overpass.getPlace({ type: 'node', id: 123 });       // PlaceInfo
const photos = await osm.placePhotos(card);                                // each with attribution
describeOpening(openingStatus(card.openingHours, new Date(), openingContextOf(card)));
// "Open, closes at 10 pm"
```

## Modules

| Module | What |
| --- | --- |
| `http/` | Shared HTTP layer: identification headers, per-service rate limits, request coalescing, cache with TTL and stale-if-error, timeouts, retries honoring `Retry-After`, per-caller abort |
| `overpass.ts` | `nearby`, `inBBox`, `getElement`/`getPlace`, `getElements` (batches), endpoint failover |
| `search.ts` | `PhotonClient`, `NominatimClient`, `PlaceSearch` (fallback rules), `SearchSession` (debounce + abort) |
| `categories.ts` | Stable category ids (`CATEGORY_IDS`), groups and suggested Maki icons |
| `normalize.ts` | `normalizeElement` → `PlaceInfo` (cuisine, `diet:*`, terrace, happy hours, reservation, fee/charge, contact, address…) |
| `opening-hours.ts` | `openingStatus`, `isOpenAt`, `happyHourStatus`, `openIntervals`, English reference wording |
| `photos/` | `CommonsClient` (image / wikimedia_commons / wikidata), `PanoramaxClient`, `Photo` with license and credit line |
| `closure/` | `osmSignals`, `reportSignals`, `assessClosure`, monthly schedule, `ClosureChecker` |
| `osmapi.ts` | OSM API lookups, only to confirm deletions |

`wheelchair` and other accessibility tags are not interpreted (SPEC: no accessibility work in v1); raw tags stay in `PlaceInfo.tags`.

## Usage policies

| Service | What the client does |
| --- | --- |
| All | Identifying `User-Agent` (name, version, contact; stock agents refused) and `Referer` on native platforms. Browsers forbid setting them: there the page's own Referer identifies the app, and Wikimedia gets `Api-User-Agent`. Addresses are configurable. |
| Nominatim | 1 request per second max, one at a time; results cached 7 days; **never** used for search-as-you-type (forbidden by the policy), only for an explicit search or when Photon is down; `email=` when configured. |
| Photon | Made for search-as-you-type; debounced, superseded requests aborted, results cached. |
| Overpass | One query in flight per endpoint, 1 s between queries, 429/504 pause the endpoint (`Retry-After`), failover to the next endpoint, results cached, refreshes batched (100 ids per query), monthly at most per place. |
| OSM API | Only for elements Overpass no longer returns, at most 10 per run, 1 request per second. |
| Wikimedia | Serial requests, titles batched, metadata cached 30 days, `origin=*`. |
| Panoramax | Two requests in flight at most, cached 7 days. |

Attributions to show: `ATTRIBUTIONS` (OSM, search), and `photo.attribution` / `photo.license` / `photo.pageUrl` under every photo.

## Open questions

- opening_hours.js is LGPL-3.0-only (the SPEC names it): check compatibility with App Store distribution of a bundled JS app (T-008), or isolate it so it can be replaced.
- Opening hours are evaluated in the device's time zone; a place in another time zone shows the wrong state.
- Holidays need the country (`addr:country`, or a fallback such as reverse geocoding); without it holiday rules are ignored and flagged.
- The Panoramax viewer link template and the public Overpass failover instance are defaults to confirm.
- Fixtures were written from the documented formats; re-record real answers once network access is available.

## Tests

`npm install --workspaces=false && npm test && npm run typecheck`. The service responses in `test/fixtures` are synthetic (see its README): no test calls a live service.
