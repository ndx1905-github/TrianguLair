"""Screenshots of the filter bar, tag management and closed places (T-108/109/113/116).

    EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web --output-dir dist
    python3 scripts/serve.py dist 8765 &
    python3 scripts/shots_filters.py docs            # or: ... docs phone tablet dark french

Same setup as shots.py (Chromium, offline, clock on Friday 23 October 2026,
18:30 in Paris; blank base map placeholder).
"""
import asyncio, json, os, sys, datetime
from playwright.async_api import async_playwright

BASE = os.environ.get('SHOTS_BASE', 'http://127.0.0.1:8765')
OUT = sys.argv[1]
NOW = datetime.datetime(2026, 10, 23, 16, 30, tzinfo=datetime.timezone.utc)
PAULETTE = (48.8602311, 2.360142)

def style(dark):
    return json.dumps({"version": 8, "sources": {}, "layers": [
        {"id": "bg", "type": "background", "paint": {"background-color": "#1D232B" if dark else "#ECEBE6"}}]})

PHOTO = '''<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#CBD5E1"/>
<text x="240" y="170" font-family="sans-serif" font-size="20" text-anchor="middle" fill="#334155">photo placeholder (offline)</text></svg>'''

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
    await page.route(lambda u: 'panoramax' in u and ('/thumb' in u or '/sd' in u or '/hd' in u), lambda r: r.fulfill(status=200, content_type='image/svg+xml', body=PHOTO))
    await page.route('https://upload.wikimedia.org/**', lambda r: r.fulfill(status=200, content_type='image/svg+xml', body=PHOTO))
    return b, page, errors

async def ready(page, path='/'):
    await page.goto(url(path))
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
    # The monthly closed-place check runs when the app opens: grouped notice.
    await page.wait_for_selector('[data-testid="closure-notice"]', timeout=15000)
    await jump(page, 48.861, 2.356, 12.6)
    await shot(page, 'phone-closure-notice')
    await page.get_by_test_id('closure-notice-later').click()
    # Expanded bar: category "Eat & drink" with its sub-filters, Terrace.
    await page.get_by_test_id('filter-category-food_drink').click()
    await page.get_by_test_id('filter-criterion-terrace').click()
    await page.get_by_test_id('filter-tag-Restaurant').click()
    await page.wait_for_timeout(400)
    await shot(page, 'phone-filters-expanded')
    # Collapsed: one pill per active filter.
    await page.get_by_test_id('filter-toggle').click()
    await page.wait_for_timeout(400)
    await shot(page, 'phone-filters-collapsed')
    # Maybe-closed card.
    # Remove one pill from the summary, then clear the rest.
    await page.get_by_test_id('filter-pill-criterion:terrace').get_by_role('button').click()
    await page.get_by_test_id('filter-toggle').click()
    await page.get_by_test_id('filter-clear').click()
    await page.get_by_test_id('filter-toggle').click()
    await jump(page, PAULETTE[0], PAULETTE[1], 16.6)
    await page.locator('[data-pin-id="osm:node/9123456720"]').click()
    await page.wait_for_selector('[data-testid="closure-maybe"]', timeout=15000)
    await page.wait_for_timeout(600)
    await shot(page, 'phone-maybe-closed-card')
    # Directions and "open in", further down the card.
    await page.get_by_test_id('directions').scroll_into_view_if_needed()
    await page.wait_for_timeout(300)
    await shot(page, 'phone-card-directions')
    # Tag management: the tree, then the editor of a sub-tag.
    await page.goto(url('/tags'))
    await page.wait_for_selector('[data-testid="tag-row-Pizza"]', timeout=15000)
    await page.wait_for_timeout(400)
    await shot(page, 'phone-tags')
    await page.get_by_test_id('tag-row-Pizza').click()
    await page.wait_for_selector('[data-testid="tag-editor"]')
    await page.wait_for_timeout(300)
    await shot(page, 'phone-tag-editor')
    await page.get_by_test_id('tag-cancel').click()
    await page.get_by_test_id('friendtag-link-Rooftop').click()
    await page.wait_for_timeout(300)
    await page.get_by_test_id('friendtag-Rooftop').evaluate('el => el.scrollIntoView({block: "start"})')
    await page.wait_for_timeout(300)
    await shot(page, 'phone-friend-tags')
    print('errors', errors)
    await b.close()

async def tablet(p):
    b, page, errors = await setup(p, 1180, 820)
    await ready(page)
    await page.wait_for_selector('[data-testid="closure-notice"]', timeout=15000)
    await page.get_by_test_id('closure-notice-later').click()
    await page.get_by_test_id('filter-category-culture').click()
    await page.get_by_test_id('filter-charge-20').click()
    await jump(page, 48.858, 2.345, 13.2)
    await shot(page, 'tablet-filters-expanded')
    await page.goto(url('/tags'))
    await page.wait_for_selector('[data-testid="tag-new"]', timeout=15000)
    await page.get_by_test_id('tag-new').click()
    await page.get_by_test_id('tag-name').fill('Sushi bars')
    await page.wait_for_timeout(400)
    await shot(page, 'tablet-tag-new')
    print('errors', errors)
    await b.close()

async def dark(p):
    b, page, errors = await setup(p, 390, 844, dark=True)
    await ready(page)
    await page.wait_for_selector('[data-testid="closure-notice"]', timeout=15000)
    await page.get_by_test_id('closure-notice-review').click()
    await page.wait_for_timeout(400)
    await jump(page, PAULETTE[0], PAULETTE[1], 16.6)
    await page.locator('[data-pin-id="osm:node/9123456720"]').click()
    await page.wait_for_selector('[data-testid="closure-maybe"]', timeout=15000)
    await page.wait_for_timeout(600)
    await shot(page, 'phone-dark-maybe-closed')
    print('errors', errors)
    await b.close()

async def french(p):
    b, page, errors = await setup(p, 390, 844, lang='fr-FR')
    await ready(page)
    await page.wait_for_selector('[data-testid="closure-notice"]', timeout=15000)
    await page.get_by_test_id('closure-notice-later').click()
    await page.get_by_test_id('filter-category-culture').click()
    await page.wait_for_timeout(400)
    await shot(page, 'phone-fr-filters')
    print('errors', errors)
    await b.close()

async def main():
    which = sys.argv[2:] or ['phone', 'tablet', 'dark', 'french']
    async with async_playwright() as p:
        for w in which:
            await globals()[w](p)

asyncio.run(main())
