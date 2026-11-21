"""Single source of the task breakdown. Generates docs/TASKS.md and is used to
create GitHub issues (scripts/create_issues.py)."""

MILESTONES = {
    "P0": "Phase 0 — scoping and prototypes",
    "P1": "Phase 1 — local app",
    "P2": "Phase 2 — sharing",
    "P3": "Phase 3 — opening up",
}

# status: todo | wip | review | done
# An acceptance criterion starting with "[x] " is met (rendered as a ticked checkbox).
T = []

def checkbox(a):
    return f"- [x] {a[4:]}" if a.startswith("[x] ") else f"- [ ] {a}"
def t(id, phase, title, labels, desc, accept, deps=(), status="todo"):
    T.append(dict(id=id, phase=phase, title=title, labels=list(labels), desc=desc,
                  accept=list(accept), deps=list(deps), status=status))

# ---------------- Phase 0 ----------------
t("T-001","P0","Encrypted format prototype (packages/crypto)",["crypto"],
  "Identity from 12 words, Ed25519 master key and replaceable X25519 sharing key, XChaCha20-Poly1305 packs, anonymous per-recipient wraps, groups, signed index, 7-day invitation and return link, Argon2id transfer code, revocation. See \"Architecture › Encrypted sharing\" and \"Format versions\".",
  ["`npm test` and `npm run typecheck` pass","Format README (byte layout, JSON, algorithms) and THREATS.md present"],status="done")
t("T-002","P0","Independent review of the crypto prototype",["crypto","review"],
  "Review by an agent or a person who did not write T-001: primitive choices, wrap anonymity, canonical serialization, anti-rollback, invitation, transfer code. Decide the 5 open questions from T-001 (`seq` field, meaning of `etag`, stable pack id, invitation link size, out-of-band verification of the return link).",
  ["Review report in docs/reviews/","Open questions decided and reflected in the spec"],deps=["T-001"],status="done")
t("T-003","P0","Storage adapters prototype (packages/storage)",["storage"],
  "Common get/put/delete/list/head interface with conditional writes (ETag) and typed errors; WebDAV, S3, read-only HTTPS and SFTP (Node only) adapters; in-memory adapter; shared conformance suite; publishSnapshot/fetchSnapshot. See \"Storage protocols\" and \"Layout on storage\".",
  ["Conformance suite green on every adapter against a local server","Per-protocol README (CORS, public read, ETag semantics)"],status="done")
t("T-004","P0","Expo app skeleton with map and pins (apps/mobile)",["app","map"],
  "Expo + expo-router, native MapLibre / web MapLibre GL JS behind a common interface, configurable OpenFreeMap Positron style, SVG pins (white icon with strong halo, multi-tag bands, faded friends' pins), bottom sheet, collapsible filter bar, dark mode. See \"Interface\" and \"Base map\".",
  ["`tsc --noEmit` passes, web export succeeds","Web screenshot in apps/mobile/docs/","eas.json ready for a development build"],status="done")
t("T-005","P0","Mockups of the main screens",["design"],
  "Map, list, add place, place card, filters, sharing list, invitation, first launch, storage settings. Follow the palette, pins and icon style sheet (24 px grid, 2 px stroke).",
  ["Mockups published and linked from the spec"])
t("T-006","P0","Continuous integration with GitHub Actions",["infra"],
  "Lint + typecheck + tests of all workspaces on every PR; web export; Dependabot; read-only permissions by default.",
  ["Green CI badge on main","PR blocked when tests fail"],status="done")
t("T-007","P0","Automatic deployment of the web test build",["infra","app"],
  "Deploy the web export to static hosting on every merge (GitHub Pages or similar), with a test WebDAV storage configured for CORS.",
  ["Test link published in the README"],deps=["T-004","T-006"])
t("T-008","P0","Administrative and legal checks",["legal","maintainer"],
  "Cryptology declaration to ANSSI (current procedure); ODbL impact on public lists; triangulair / triangulaire domains; TMview trademarks in classes 9 and 42.",
  ["Results reflected in \"Legal and publishing\""])
t("T-009","P0","Mapstr and Pin Drop export formats",["import","maintainer"],
  "Get a real export from a Mapstr and a Pin Drop account, document columns and formats, anonymize a sample for tests.",
  ["Samples in packages/import/fixtures/","Columns documented in the spec"])
t("T-010","P0","Forgejo mirror of the repository",["infra","maintainer"],
  "Automatic mirror from GitHub to the maintainer's Forgejo instance, with a read-only token.",
  ["Mirror up to date after each push"])

# ---------------- Phase 1 ----------------
t("T-101","P1","Local SQLite database with spatial index",["data"],
  "Schema from \"Data model\" (people, groups, places, saves, tags, save_tags, tag_mappings, lists, list_items, access, media), migrations, \"places in this area\" queries.",
  ["Tests on 10,000 places within performance targets"],status="done")
t("T-102","P1","Yjs model and merging across devices",["sync","data"],
  "CRDT document (Yjs: pure JavaScript, no WebAssembly, runs on Hermes) for places, tags, lists; projection to SQLite; merge rules kept explicit where Yjs's last-writer-wins differs (shared base update, one save per place with folding of concurrent creations, deletion and privacy win via per-device slots, character-level comments, unknown fields kept); property-based tests of merging.",
  ["Two simulated devices converge after concurrent edits","No WebAssembly in the runtime dependency tree (tested)"],deps=["T-101"],status="done")
t("T-103","P1","Map: clustering when zoomed out and filtered display",["map"],
  "Clusters, matching pins in color / others greyed and smaller, zones displayed, 10,000-place performance. Done on web with JS clusters; native needs map-engine layers for 10,000 pins.",
  ["60 fps on the reference device"],deps=["T-004","T-101"])
t("T-104","P1","List view: sorting, text search",["app"],
  "Sort by recent / distance / name, full-text search, \"N friends\" mention.",["Unit tests for sorting and search"],deps=["T-101"],status="done")
t("T-105","P1","Add a place: nearby places, search, long press",["app","osm"],
  "Add screen listing nearby OSM places by increasing distance, Photon/Nominatim search, long press, current location; \"already mine / saved by friends\" indicator.",
  ["End-to-end flow on simulator"],deps=["T-106","T-101"],status="done")
t("T-106","P1","OSM client: Overpass, Photon/Nominatim",["osm"],
  "Clients with caching, rate limits respected, identifying User-Agent, configurable URLs.",["Tests with recorded responses"],status="done")
t("T-107","P1","Enriched place card: info, opening hours, free photos",["osm","app"],
  "Opening hours (opening_hours), cuisine, diets, terrace, entrance fee; Wikimedia Commons and Panoramax photos with attribution.",
  ["Attribution shown for every photo"],deps=["T-106"],status="done")
t("T-108","P1","Personal tags, colors, icons, sub-tags",["app","design"],
  "Create and edit tags, palette, CC0 icons, sub-tags (\"Restaurant › Pizza\").",["Tests of the palette and band rendering"],deps=["T-101"],status="done")
t("T-109","P1","Full filter bar",["app","osm"],
  "Categories, sub-filters, OSM criteria (open now, happy hour, terrace, diet, reservation, free entry, price), status, visibility, price level, text; collapsible, state remembered.",
  ["Unit tests for each criterion"],deps=["T-107","T-108"],status="done")
t("T-110","P1","Zones: neighborhoods, street segments, freehand drawing",["map","app"],
  "Existing OSM neighborhood, one or more street segments, drawing by points or finger painting; zone icon.",["Zones stored as valid GeoJSON"],deps=["T-103"],status="done")
t("T-111","P1","Comments, status, price, personal photos",["app"],
  "Comment visibility (private / friends / public), to try / tried / favorite status, €–€€€€, personal photos.",["Visibility respected in exports"],deps=["T-101"],status="done")
t("T-112","P1","Lists from saved filters or manual selection",["app"],
  "Dynamic lists (categories, tags, zones by name via OSM boundaries or drawn) and manual lists; a private place never enters a list.",["Property-based tests on excluding private places"],deps=["T-109","T-110"],status="done")
t("T-113","P1","Monthly detection of closed places",["osm"],
  "Monthly check via OSM (disused:, shop=vacant, deletion), notify the user.",["Tests with recorded OSM cases"],deps=["T-106"],status="done")
t("T-114","P1","Import from Google Takeout, Mapstr, Pin Drop, CSV, KML, GeoJSON",["import"],
  "Parsing, matching with OSM places, preview before import, deduplication.",["T-009 samples imported without loss"],deps=["T-009","T-106"],status="done")
t("T-115","P1","Full GeoJSON export",["import"],"Export all places, zones, tags, comments.",["Re-import without loss"],deps=["T-101"],status="done")
t("T-116","P1","Directions and opening in Apple Maps / Google Maps",["app"],"Deep links to navigation apps.",["Tested on iOS and Android"],status="done")
t("T-117","P1","Screen adaptation: foldables, iPad, Mac, font sizes",["app","design"],
  "Adaptive layout, dual screens (Galaxy Fold, iPhone Duo), iPad, Apple Silicon Mac, dynamic type, iOS display zoom.",["Automatic screenshots per form factor"],status="done")
t("T-118","P1","Languages and dark mode",["app","i18n"],"i18n (English and French first), Weblate; complete dark mode.",["No hard-coded strings"],status="done")
t("T-119","P1","End-to-end tests on simulators",["infra","tests"],"Maestro or Detox: first launch, add, filter, list, import.",["Run in CI"],deps=["T-006"],status="done")

# ---------------- Phase 2 ----------------
t("T-201","P2","Final v1 encrypted format and test vectors",["crypto"],
  "Format v4 frozen on main at 5b10faf after five independent reviews (docs/reviews/). Remaining before the external audit: a standalone format specification in docs/format/ with pseudocode for every check, known-answer test vectors (positive and negative, from seeded randomness), fuzzing of every parser, a second minimal reader in another language, and a map from each spec promise to the code that enforces it.",
  ["[x] Standalone format specification in docs/format/: byte layouts, JSON shapes, size limits, versioning rules and pseudocode for every check",
   "[x] Known-answer vectors for every structure, positive and negative, from seeded randomness, checked by the library (`npm test`) and regenerated by `npm run vectors`",
   "[x] Fuzz and property tests of every parser (fixed seed in CI, `npm run fuzz:long`)",
   "[x] Map from each spec promise to the code that enforces it (docs/format/promises.md)",
   "[x] A second minimal reader (Python, docs/format/reference-reader/) checks the signed-index, pack and invitation-link vectors",
   "[x] Vectors checked by a second implementation: the Python reader implements every op and agrees on all 473 vectors (`npm run reader`, in CI)"],deps=["T-002"],status="done")
t("T-202","P2","Production storage adapters and tests against real servers",["storage"],
  "Nextcloud, MinIO, SFTP, web server in CI; simulated failures (timeout, quota, credentials, interrupted write). SFTP on mobile: native module or unsupported. Support `index.v<N>.json` next to `index.json` for major format transitions (spec \"Format versions\").",["Conformance suite green against each server"],deps=["T-003"],status="done")
t("T-203","P2","Storage settings and migration between storages",["app","storage"],
  "Choice of local only / WebDAV / S3 / SFTP, HTTPS read address, connection test, full copy when switching.",["Lossless migration tested"],deps=["T-202"],status="done")
t("T-204","P2","Sync: publishing and reading packs",["sync"],
  "While in use and right after closing, no periodic task; ETag, signed index, friends' cache. ETag compare-and-swap is best effort on some servers: after publishing, re-read the index and check it carries our `seq`; merge and republish otherwise. A real Nextcloud takes ~0.4 s per request: upload packs in parallel and avoid needless round trips.",["Headless multi-user simulation","A full sync against a real Nextcloud stays within the performance targets"],deps=["T-102","T-201","T-202"],status="done")
t("T-205","P2","Recovery kit and first launch",["crypto","app"],
  "Three entry points, 12-word phrase, recovery kit, standard flow.",["[x] End-to-end flow: e2e `recovery.spec.ts` against Apache WebDAV: places, a photo and a friend, the kit saved, browser storage wiped, restored on a fresh launch from the pasted kit or the printed page (words, QR code of the address): places, photos, friends, names and storage access back"],deps=["T-201"],status="done")
t("T-206","P2","Adding a device (transfer code, QR)",["crypto","app"],"Argon2id code and QR code.",["Two devices in sync"],deps=["T-205","T-204"],status="done")
t("T-207","P2","Loss and theft: key rotation, remote wipe",["crypto","sync"],
  "Sharing key rotation, re-encryption, key deletion at sync on the removed device.",["\"Stolen device\" scenario simulated"],deps=["T-206"],status="done")
t("T-208","P2","Invitation by link, QR code and return link",["crypto","app"],
  "7-day temporary invitation key, content visible immediately, return link, asymmetric relationships.",["Full scenario between two simulated users"],deps=["T-204"],status="done")
t("T-209","P2","Access management and revocation",["crypto","sync"],
  "Choose what each friend can open; revoking access removes the content from the friend's cache.",["End-to-end revocation tests"],deps=["T-208"],status="done")
t("T-210","P2","Friends' places, counters and What's new view",["app","sync"],
  "\"Also saved by friends\" filters, choice of displayed friends, unknown tags keeping their original color, What's new view.",["Tests of tag matching"],deps=["T-204"],status="done")
t("T-211","P2","Public lists (GeoJSON) and \"View on uMap\" link",["sharing"],
  "Publish public/lists.geojson in clear, ODbL attribution, uMap link.",["List opened in uMap"],deps=["T-112","T-204"],status="done")
t("T-212","P2","Link-only lists (key in the URL fragment)",["sharing","crypto"],"Follow a list without following the person.",["Link opened on a second device"],deps=["T-211"],status="done")
t("T-213","P2","Error cases from the spec",["app","sync"],"Implement every row of the \"Error cases\" table.",["[x] One test per row (mapped in [`error-cases.md`](error-cases.md))"],deps=["T-204"],status="done")
t("T-214","P2","External security audit",["crypto","maintainer"],"Audit of encryption and sync before release.",["Report published and fixes made"],deps=["T-209"])

# ---------------- Phase 3 ----------------
t("T-301","P3","Release on App Store, Play Store, F-Droid",["release","maintainer"],"Store listings, screenshots, reproducible F-Droid builds.",["Apps published"],deps=["T-214"])
t("T-302","P3","User and self-hosting documentation",["docs"],"Guides for Nextcloud, NAS, S3, self-hosted tiles.",["Guides reviewed by a non-technical person"])
t("T-303","P3","Contribution guide, code of conduct, security policy",["docs"],"Complete CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.",["Files present and linked from the README"])
t("T-304","P3","Funding: Liberapay / Open Collective, NLnet",["maintainer"],"Open donations, apply to NLnet.",["Application sent"])
