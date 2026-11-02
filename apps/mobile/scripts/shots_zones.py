"""Screenshots of zones (T-110) and lists (T-112), web export in fixture mode.

    EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web --output-dir dist
    python3 scripts/serve.py dist 8765 &
    python3 scripts/shots_zones.py docs            # or: ... docs phone tablet dark french

Same setup as shots.py (Chromium, offline, placeholder base map). Zone
sources (neighbourhoods, streets, areas by name) are the synthetic fixtures
of src/osm/zoneFixtures.ts.
"""
import asyncio, json, sys, datetime
from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8765'
OUT = sys.argv[1]
NOW = datetime.datetime(2026, 10, 23, 16, 30, tzinfo=datetime.timezone.utc)

def style(dark):
    return json.dumps({"version": 8, "sources": {}, "layers": [
        {"id": "bg", "type": "background", "paint": {"background-color": "#1D232B" if dark else "#ECEBE6"}}]})

async def setup(p, width, height, dark=False, lang='en-US'):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': width, 'height': height}, device_scale_factor=2, locale=lang,
                              timezone_id='Europe/Paris', color_scheme='dark' if dark else 'light')
    page = await ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    await page.clock.set_system_time(NOW)
    await page.route('https://tiles.openfreemap.org/**', lambda r: r.fulfill(status=200, content_type='application/json', body=style(dark)))
    await page.route('https://upload.wikimedia.org/**', lambda r: r.fulfill(status=404, body=''))
    return b, page, errors

async def shot(page, name):
    await page.screenshot(path=f'{OUT}/{name}.png')
    print('saved', name)

async def jump(page, lat, lon, zoom):
    await page.evaluate(f'window.__tlMap.jumpTo({{center: [{lon}, {lat}], zoom: {zoom}}})')
    await page.wait_for_timeout(900)

async def px(page, lat, lon):
    p = await page.evaluate(f'(() => {{ const p = window.__tlMap.project([{lon}, {lat}]); const r = window.__tlMap.getContainer().getBoundingClientRect(); return [p.x + r.left, p.y + r.top]; }})()')
    return p[0], p[1]

async def tap_at(page, lat, lon):
    x, y = await px(page, lat, lon)
    await page.mouse.click(x, y)
    await page.wait_for_timeout(700)  # slower than a double click (which zooms the map)

async def paint(page, pts):
    xy = [await px(page, lat, lon) for lat, lon in pts]
    await page.mouse.move(*xy[0])
    await page.mouse.down()
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        for k in range(1, 9):
            await page.mouse.move(x0 + (x1 - x0) * k / 8, y0 + (y1 - y0) * k / 8)
    await page.mouse.up()
    await page.wait_for_timeout(400)

async def open_map(page, path='/'):
    await page.goto(url(path))
    await page.wait_for_selector('[data-pin-id]' if path == '/' else '[data-testid="map"]', timeout=30000)
    await page.wait_for_timeout(800)

async def new_zone(page):
    await page.get_by_test_id('open-new-zone').click()
    await page.wait_for_selector('[data-testid="zone-panel"]')
    await page.wait_for_timeout(600)

async def save_zone(page, name, tag):
    await page.get_by_test_id('zone-next').click()
    await page.wait_for_selector('[data-testid="zone-form"]')
    await page.get_by_test_id('zone-name').fill(name)
    if tag:
        await page.get_by_test_id(f'tag-option-{tag}').click()
    await page.get_by_test_id('zone-save').click()
    await page.wait_for_selector('[data-testid="zone-card"]', timeout=15000)
    await page.wait_for_timeout(900)

async def make_private(page, pin_id):
    await page.locator(f'[data-pin-id="{pin_id}"]').click()
    await page.wait_for_selector('[data-testid="place-card"]')
    await page.get_by_test_id('sharing').get_by_text('Private', exact=True).click()
    await page.wait_for_timeout(300)
    await page.get_by_test_id('card-close').click()
    await page.wait_for_timeout(300)

async def phone(p):
    b, page, errors = await setup(p, 390, 844)
    await open_map(page)
    await jump(page, 48.8615, 2.3605, 15.2)
    await make_private(page, 'local:demoplace12')  # Marché des Enfants Rouges: private, so never in a list

    # 1. Neighbourhood: candidates from OSM (fixtures), tap one.
    await new_zone(page)
    # The panel covers the lower half of a phone: keep what is tapped in the upper half.
    await jump(page, 48.8572, 2.3612, 14.3)
    await page.wait_for_selector('[data-testid="zone-area-Archives"]', timeout=15000)
    await tap_at(page, 48.8592, 2.3625)  # inside Archives
    await page.wait_for_timeout(500)
    await shot(page, 'phone-zone-neighbourhood')
    await save_zone(page, 'Archives', 'Museum')
    await page.get_by_test_id('card-close').click()

    # 2. Freehand by points: five corners, tap the first to close.
    await new_zone(page)
    await page.get_by_test_id('zone-mode').get_by_text('Draw', exact=True).click()
    await jump(page, 48.8630, 2.3630, 15.4)
    corners = [(48.8657, 2.3606), (48.8658, 2.3648), (48.8645, 2.3655), (48.8624, 2.3646), (48.8625, 2.3606)]
    for lat, lon in corners + [corners[0]]:
        await tap_at(page, lat, lon)
    await page.wait_for_timeout(500)
    await shot(page, 'phone-zone-draw-points')
    await save_zone(page, 'Haut-Marais walk', 'Shop')
    await shot(page, 'phone-zone-card')
    await page.get_by_test_id('card-close').click()

    # 3. Painting: two strokes and the eraser.
    await new_zone(page)
    await page.get_by_test_id('zone-mode').get_by_text('Draw', exact=True).click()
    await page.get_by_test_id('zone-draw-kind').get_by_text('By painting', exact=True).click()
    await jump(page, 48.8565, 2.3640, 15.6)
    await page.get_by_test_id('zone-brush-L').click()
    await paint(page, [(48.8585, 2.3615), (48.8588, 2.3640), (48.8580, 2.3662)])
    await paint(page, [(48.8572, 2.3618), (48.8575, 2.3645), (48.8568, 2.3665)])
    await page.wait_for_timeout(500)
    await shot(page, 'phone-zone-paint')
    await save_zone(page, 'Sunday stroll', 'Park')
    await page.get_by_test_id('card-close').click()

    # 4. Street segments: start on Rue des Archives, end on Rue de Turenne (the path follows the streets).
    await new_zone(page)
    await page.get_by_test_id('zone-mode').get_by_text('Streets', exact=True).click()
    await jump(page, 48.8612, 2.3626, 15.0)
    await page.wait_for_timeout(1200)
    await tap_at(page, 48.8618, 2.3592)
    await tap_at(page, 48.8628, 2.3659)
    await page.wait_for_timeout(500)
    await shot(page, 'phone-zone-streets')
    await save_zone(page, 'Rue de Bretagne', 'Restaurant')
    await page.get_by_test_id('card-close').click()

    # 5. Zones on the map.
    await jump(page, 48.8606, 2.3628, 14.7)
    await shot(page, 'phone-map-zones')

    # 6. Lists: a filter list (statuses + zone), with exceptions and the reasons.
    await page.get_by_test_id('open-lists').click()
    await page.wait_for_selector('[data-testid="new-list"]')
    await page.get_by_test_id('new-list').click()
    await page.wait_for_selector('[data-testid="list-editor"]')
    await page.get_by_test_id('list-name').fill('Marais picks')
    await page.get_by_test_id('list-tag-Restaurant').click()
    await page.get_by_test_id('list-tag-Shop').click()
    await page.get_by_test_id('list-myzone-Haut-Marais walk').click()
    await page.get_by_test_id('list-zone-search').fill('Archives')
    await page.get_by_test_id('list-zone-go').click()
    await page.wait_for_selector('[data-testid="list-zone-result-Archives"]', timeout=15000)
    await page.get_by_test_id('list-zone-result-Archives').click()
    await page.wait_for_timeout(1200)
    await shot(page, 'phone-list-editor')
    await page.get_by_test_id('list-toggle-out').click()
    await page.wait_for_timeout(300)
    await page.get_by_test_id('list-count').scroll_into_view_if_needed()
    await page.wait_for_timeout(1200)
    await shot(page, 'phone-list-preview')
    await page.get_by_test_id('list-row-Marché des Enfants Rouges').scroll_into_view_if_needed()
    await page.wait_for_timeout(300)
    await shot(page, 'phone-list-reasons')
    await page.get_by_test_id('list-save').click()
    await page.wait_for_selector('[data-testid="list-summary"]', timeout=15000)
    await page.wait_for_timeout(1500)
    await shot(page, 'phone-list-view')
    await page.get_by_test_id('list-view-mode').get_by_text('List', exact=True).click()
    await page.wait_for_timeout(500)
    await shot(page, 'phone-list-view-rows')
    print('errors', errors)
    await b.close()

async def tablet(p):
    b, page, errors = await setup(p, 1180, 820)
    await open_map(page)
    await new_zone(page)
    await jump(page, 48.8615, 2.3600, 14.8)
    await page.wait_for_selector('[data-testid="zone-area-Enfants-Rouges"]', timeout=15000)
    await page.get_by_test_id('zone-area-Enfants-Rouges').click()
    await page.wait_for_timeout(600)
    await shot(page, 'tablet-zone-neighbourhood')
    await save_zone(page, 'Enfants-Rouges', 'Restaurant')
    await jump(page, 48.8628, 2.3700, 15.0)
    await shot(page, 'tablet-map-zone-card')
    await page.get_by_test_id('card-close').click()
    await page.get_by_test_id('open-lists').click()
    await page.get_by_test_id('new-list').click()
    await page.wait_for_selector('[data-testid="list-editor"]')
    await page.get_by_test_id('list-name').fill('Favorites in Paris')
    await page.get_by_test_id('list-status-favorite').click()
    await page.get_by_test_id('list-status-tried').click()
    await page.get_by_test_id('list-zone-search').fill('Paris')
    await page.get_by_test_id('list-zone-go').click()
    await page.wait_for_selector('[data-testid="list-zone-result-Paris"]', timeout=15000)
    await page.get_by_test_id('list-zone-result-Paris').click()
    await page.get_by_test_id('list-visibility').get_by_text('Public', exact=True).click()
    await page.wait_for_timeout(1500)
    await shot(page, 'tablet-list-editor')
    await page.get_by_test_id('list-save').click()
    await page.wait_for_selector('[data-testid="list-summary"]', timeout=15000)
    await page.wait_for_timeout(800)
    await page.locator('[data-testid^="member-"]').first.click()
    await page.wait_for_timeout(1500)
    await shot(page, 'tablet-list-view')
    print('errors', errors)
    await b.close()

async def dark(p):
    b, page, errors = await setup(p, 390, 844, dark=True)
    await open_map(page)
    await new_zone(page)
    await page.get_by_test_id('zone-mode').get_by_text('Draw', exact=True).click()
    await jump(page, 48.8640, 2.3630, 15.4)
    corners = [(48.8666, 2.3606), (48.8667, 2.3648), (48.8650, 2.3655), (48.8640, 2.3612)]
    for lat, lon in corners + [corners[0]]:
        await tap_at(page, lat, lon)
    await tap_at(page, 48.8650, 2.3655)  # select a vertex to move it
    await page.wait_for_timeout(400)
    await shot(page, 'phone-dark-zone-draw')
    print('errors', errors)
    await b.close()

async def french(p):
    b, page, errors = await setup(p, 390, 844, lang='fr-FR')
    await open_map(page)
    await page.get_by_test_id('open-lists').click()
    await page.get_by_test_id('new-list').click()
    await page.wait_for_selector('[data-testid="list-editor"]')
    await page.get_by_test_id('list-name').fill('Mes favoris')
    await page.get_by_test_id('list-kind').get_by_text('Sélection à la main', exact=True).click()
    await page.wait_for_timeout(800)
    await shot(page, 'phone-fr-list-editor')
    print('errors', errors)
    await b.close()

async def main():
    which = sys.argv[2:] or ['phone', 'tablet', 'dark', 'french']
    async with async_playwright() as p:
        for w in which:
            await globals()[w](p)

asyncio.run(main())
