"""Screenshots of the web export in fixture mode (Chromium, offline).

    EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web --output-dir dist
    python3 scripts/serve.py dist 8765 &
    python3 scripts/shots.py docs            # or: ... docs phone tablet dark french

Needs the Python `playwright` package and an installed Chromium. The base map
style and photo files are answered with placeholders (no network).
"""
import asyncio, json, sys, datetime
from playwright.async_api import async_playwright

BASE = __import__('os').environ.get('SHOTS_BASE', 'http://127.0.0.1:8765')
OUT = sys.argv[1]
# Friday 23 October 2026, 18:30 in Paris: happy hours on, some places open, some not yet.
NOW = datetime.datetime(2026, 10, 23, 16, 30, tzinfo=datetime.timezone.utc)
MARAIS = (48.8594, 2.3624)

def style(dark):
    return json.dumps({"version": 8, "sources": {}, "layers": [
        {"id": "bg", "type": "background", "paint": {"background-color": "#1D232B" if dark else "#ECEBE6"}}]})

PHOTO = '''<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#93C5FD"/><stop offset="1" stop-color="#FDE68A"/></linearGradient></defs>
<rect width="480" height="320" fill="url(#g)"/><rect x="150" y="120" width="180" height="140" fill="#F8FAFC" opacity=".8"/>
<polygon points="130,125 240,60 350,125" fill="#F1F5F9" opacity=".9"/>
<text x="240" y="300" font-family="sans-serif" font-size="20" text-anchor="middle" fill="#334155">photo placeholder (offline)</text></svg>'''

async def setup(p, width, height, dark=False, lang='en-US'):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': width, 'height': height}, device_scale_factor=2, locale=lang,
                              timezone_id='Europe/Paris', color_scheme='dark' if dark else 'light',
                              has_touch=width < 600)
    page = await ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    await page.clock.set_system_time(NOW)
    await page.route('https://tiles.openfreemap.org/**', lambda r: r.fulfill(status=200, content_type='application/json', body=style(dark)))
    await page.route('https://upload.wikimedia.org/**', lambda r: r.fulfill(status=200, content_type='image/svg+xml', body=PHOTO))
    await page.route('**/panoramax**/*.jpg', lambda r: r.fulfill(status=200, content_type='image/svg+xml', body=PHOTO))
    await page.route(lambda u: 'panoramax' in u and ('/thumb' in u or '/sd' in u or '/hd' in u), lambda r: r.fulfill(status=200, content_type='image/svg+xml', body=PHOTO))
    return b, page, errors

async def ready(page):
    await page.goto(BASE + '/')
    await page.wait_for_selector('[data-pin-id]', timeout=30000)
    await page.wait_for_timeout(800)

async def jump(page, lat, lon, zoom):
    await page.evaluate(f'window.__tlMap.jumpTo({{center: [{lon}, {lat}], zoom: {zoom}}})')
    await page.wait_for_timeout(700)

async def shot(page, name):
    await page.screenshot(path=f'{OUT}/{name}.png')
    print('saved', name)

async def phone(p):
    b, page, errors = await setup(p, 390, 844)
    await ready(page)
    # Map zoomed out: clusters.
    await jump(page, 48.866, 2.356, 11.6)
    await shot(page, 'phone-map-clusters')
    # Filters: Bar tag + Terrace criterion; non-matching pins greyed.
    await page.get_by_test_id('filter-tag-Bar').click()
    await page.get_by_test_id('filter-criterion-terrace').click()
    await jump(page, 48.862, 2.356, 12.4)
    await shot(page, 'phone-map-filters')
    await page.get_by_test_id('filter-clear').click()
    # Place card (bottom sheet) for the fixture place.
    await jump(page, MARAIS[0], MARAIS[1], 16.2)
    await page.locator('[data-pin-id="osm:node/9123456702"]').click()
    await page.wait_for_selector('[data-testid="photo-credit"]', timeout=15000)
    await page.wait_for_timeout(600)
    await shot(page, 'phone-place-card')
    await page.get_by_test_id('card-close').click()
    await page.wait_for_timeout(400)
    # Add a place: nearby list around the map center.
    await page.get_by_test_id('open-add').click()
    await page.wait_for_selector('[data-testid="badge-mine"]', timeout=15000)
    await page.wait_for_timeout(400)
    await shot(page, 'phone-add-nearby')
    await page.get_by_test_id('add-search').fill('cafe pen')
    await page.wait_for_selector('[data-testid="candidate-Café Pendule"]', timeout=15000)
    await page.wait_for_timeout(300)
    await shot(page, 'phone-add-search')
    await page.get_by_test_id('candidate-Café Pendule').click()
    await page.wait_for_selector('[data-testid="add-form"]')
    await page.wait_for_timeout(300)
    await shot(page, 'phone-add-form')
    await page.get_by_test_id('save-place').click()
    await page.wait_for_selector('[data-testid="place-card"]', timeout=15000)
    await page.wait_for_timeout(800)
    # List view.
    await page.get_by_test_id('card-close').click()
    await page.get_by_test_id('open-list').click()
    await page.wait_for_selector('[data-testid="place-list"]')
    await page.wait_for_timeout(400)
    await shot(page, 'phone-list')
    await page.get_by_test_id('list-search').fill('oysters')
    await page.wait_for_timeout(500)
    await shot(page, 'phone-list-search')
    print('errors', errors)
    await b.close()

async def tablet(p):
    b, page, errors = await setup(p, 1180, 820)
    await ready(page)
    await page.get_by_test_id('filter-criterion-openNow').click()
    await jump(page, 48.858, 2.352, 13.4)
    await page.locator('[data-pin-id="local:demoplace06"]').click()
    await page.wait_for_selector('[data-testid="place-card"]')
    await page.wait_for_timeout(600)
    await shot(page, 'tablet-map-filter-card')
    await page.get_by_test_id('card-close').click()
    await page.get_by_test_id('filter-clear').click()
    await page.get_by_test_id('open-list').click()
    await page.wait_for_selector('[data-testid="place-list"]')
    await page.get_by_text('Distance', exact=True).click()
    await page.get_by_test_id('row-Le Comptoir du Relais').click()
    await page.wait_for_timeout(600)
    await shot(page, 'tablet-list')
    print('errors', errors)
    await b.close()

async def dark(p):
    b, page, errors = await setup(p, 390, 844, dark=True)
    await ready(page)
    await jump(page, 48.852, 2.372, 14.2)
    await page.locator('[data-pin-id="local:demoplace06"]').click()
    await page.wait_for_selector('[data-testid="place-card"]')
    await page.wait_for_timeout(600)
    await shot(page, 'phone-dark-card')
    print('errors', errors)
    await b.close()

async def french(p):
    b, page, errors = await setup(p, 390, 844, lang='fr-FR')
    await ready(page)
    await page.get_by_test_id('open-add').click()
    await page.wait_for_timeout(1500)
    await shot(page, 'phone-fr-add')
    print('errors', errors)
    await b.close()

IMPORT_FIXTURES = __import__('os').path.join(__import__('os').path.dirname(__file__), '../../../packages/import/test/fixtures')

async def pick_file(page, rel):
    async with page.expect_file_chooser() as fc:
        await page.get_by_test_id('import-pick').click()
    chooser = await fc.value
    await chooser.set_files(f'{IMPORT_FIXTURES}/{rel}')

async def importer(p, width=390, height=844, prefix='phone'):
    """Import preview (T-114) on the hand-made My Maps fixture, matched against the OSM fixtures."""
    b, page, errors = await setup(p, width, height)
    await ready(page)
    await page.get_by_test_id('open-list').click()
    await page.get_by_test_id('open-import').click()
    await page.wait_for_selector('[data-testid="import-pick"]')
    await page.wait_for_timeout(300)
    await shot(page, f'{prefix}-import-home')
    # Export (T-115): downloaded on desktop web; check it is our GeoJSON.
    async with page.expect_download() as dl:
        await page.get_by_test_id('export-all').click()
    d = await dl.value
    data = json.loads(open(await d.path()).read())
    print('export', d.suggested_filename, data['triangulair']['format'], len(data['features']), 'features')
    await pick_file(page, 'kml/my-maps.kml')
    await page.wait_for_selector('[data-testid="import-preview"]', timeout=20000)
    await page.wait_for_timeout(400)
    await shot(page, f'{prefix}-import-preview-check')
    await page.get_by_test_id('preview-groups').get_by_text('Found', exact=False).click()
    await page.get_by_test_id('preview-row-Trattoria Da Lucia').get_by_role('button').first.click()
    await page.wait_for_timeout(300)
    await shot(page, f'{prefix}-import-preview-found')
    await page.get_by_test_id('preview-groups').get_by_text('Manual', exact=False).click()
    await page.wait_for_timeout(300)
    await page.get_by_test_id('tag-row-Culture').scroll_into_view_if_needed()
    await page.wait_for_timeout(300)
    await shot(page, f'{prefix}-import-preview-tags')
    await page.get_by_test_id('import-confirm').click()
    await page.wait_for_selector('[data-testid="import-done"]', timeout=20000)
    await page.wait_for_timeout(300)
    await shot(page, f'{prefix}-import-done')
    await page.get_by_text('Import another file').click()
    await pick_file(page, 'csv/spreadsheet-fr.csv')
    await page.wait_for_selector('[data-testid="column-mapping"]', timeout=20000)
    await page.wait_for_timeout(300)
    await shot(page, f'{prefix}-import-mapping')
    print('errors', errors)
    await b.close()

async def importer_tablet(p):
    await importer(p, 1180, 820, 'tablet')

async def main():
    which = sys.argv[2:] or ['phone', 'tablet', 'dark', 'french', 'importer']
    async with async_playwright() as p:
        for w in which:
            await globals()[w](p)

asyncio.run(main())
