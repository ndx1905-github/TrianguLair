"""Screenshots of the first launch, recovery kit, settings and the card's lists (T-205),
plus the screen-adaptation pass (T-117/T-118): web export in fixture mode.

    EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web --output-dir dist
    python3 scripts/serve.py dist 8765 &
    python3 scripts/shots_first_launch.py docs            # or: ... docs phone kit lists adapt

Font scale: a browser has no system text size, so `font_scale()` enlarges every text
of the page (each element whose own font size is set, the others inherit) to mimic
Android's font scale / iOS Dynamic Type. It ignores `maxFontSizeMultiplier`, so it
is slightly harsher than a phone at the same scale.
"""
import asyncio, json, sys, datetime
from playwright.async_api import async_playwright

BASE = __import__('os').environ.get('SHOTS_BASE', 'http://127.0.0.1:8765')
OUT = sys.argv[1]
NOW = datetime.datetime(2026, 10, 23, 16, 30, tzinfo=datetime.timezone.utc)

def url(path):
    return BASE + path + ('&' if '?' in path else '?') + 'autostart=1'

def style(dark):
    return json.dumps({"version": 8, "sources": {}, "layers": [
        {"id": "bg", "type": "background", "paint": {"background-color": "#1D232B" if dark else "#ECEBE6"}}]})

FONT_SCALE_JS = '''
(scale) => {
  const done = new WeakMap();
  const apply = () => {
    for (const el of document.querySelectorAll('body *')) {
      if (done.has(el) || el.tagName === 'svg' || el.closest('svg')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
      if (!own) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const p = el.parentElement && el.parentElement.closest('[data-fs]');
      if (p && Math.abs(size - parseFloat(p.dataset.fs) * scale) < 0.01) { done.set(el, 1); continue; }
      el.dataset.fs = String(size);
      el.style.fontSize = (size * scale) + 'px';
      if (cs.lineHeight !== 'normal') el.style.lineHeight = 'normal';
      done.set(el, 1);
    }
  };
  apply();
  new MutationObserver(() => requestAnimationFrame(apply)).observe(document.body, { childList: true, subtree: true, characterData: true });
}
'''

async def setup(p, width, height, dark=False, lang='en-US', touch=None):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': width, 'height': height}, device_scale_factor=2, locale=lang,
                              timezone_id='Europe/Paris', color_scheme='dark' if dark else 'light',
                              has_touch=width < 600 if touch is None else touch)
    page = await ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    await page.clock.set_system_time(NOW)
    await page.route('https://tiles.openfreemap.org/**', lambda r: r.fulfill(status=200, content_type='application/json', body=style(dark)))
    return b, page, errors

async def font_scale(page, scale):
    await page.evaluate(FONT_SCALE_JS, scale)
    await page.wait_for_timeout(300)

async def shot(page, name):
    await page.screenshot(path=f'{OUT}/{name}.png')
    print('saved', name)

async def first_launch(page, name='Alex'):
    """The standard flow by hand, up to the map."""
    await page.goto(BASE + '/')
    await page.wait_for_selector('[data-testid="welcome"]', timeout=30000)
    await page.get_by_test_id('welcome-start').click()
    await page.wait_for_selector('[data-testid="keys-ready"]', timeout=30000)
    await page.get_by_test_id('profile-name').fill(name)
    await page.get_by_test_id('profile-continue').click()
    await page.wait_for_selector('[data-testid="welcome-lock"]')
    await page.get_by_test_id('lock-skip').click()
    await page.wait_for_selector('[data-testid="welcome-location"]')
    await page.get_by_test_id('location-skip').click()
    await page.wait_for_selector('[data-testid="welcome-import"]')
    await page.get_by_test_id('import-later').click()
    await page.wait_for_selector('[data-pin-id]', timeout=30000)
    await page.wait_for_timeout(800)

async def show_protect(page):
    await page.wait_for_timeout(1000)
    if await page.get_by_test_id('protect-card').count() == 0:
        await page.get_by_role('button', name='Later').first.click()
    await page.wait_for_selector('[data-testid="protect-card"]')

async def phone(p):
    b, page, errors = await setup(p, 390, 844)
    await page.goto(BASE + '/')
    await page.wait_for_selector('[data-testid="welcome"]', timeout=30000)
    await page.wait_for_timeout(300)
    await shot(page, 'phone-welcome')
    await page.get_by_test_id('welcome-device').click()
    await page.wait_for_selector('[data-testid="welcome-device-screen"]')
    await shot(page, 'phone-welcome-device')
    await page.go_back()
    await page.get_by_test_id('welcome-invitation').click()
    await page.wait_for_selector('[data-testid="welcome-invitation-screen"]')
    await shot(page, 'phone-welcome-invitation')
    await page.go_back()
    await page.get_by_test_id('welcome-start').click()
    await page.wait_for_selector('[data-testid="keys-ready"]', timeout=30000)
    await page.get_by_test_id('profile-name').fill('Alex')
    await shot(page, 'phone-welcome-profile')
    await page.get_by_test_id('profile-continue').click()
    await page.wait_for_selector('[data-testid="welcome-lock"]')
    await page.get_by_test_id('lock-toggle').click()
    await page.get_by_test_id('code-new').fill('2468')
    await page.get_by_test_id('code-again').fill('2469')
    await page.get_by_test_id('lock-continue').click()
    await page.wait_for_selector('[data-testid="code-problem"]')
    await shot(page, 'phone-welcome-lock')
    await page.get_by_test_id('code-again').fill('2468')
    await page.get_by_test_id('lock-continue').click()
    await page.wait_for_selector('[data-testid="welcome-location"]')
    await shot(page, 'phone-welcome-location')
    await page.get_by_test_id('location-skip').click()
    await page.wait_for_selector('[data-testid="welcome-import"]')
    await shot(page, 'phone-welcome-import')
    await page.get_by_test_id('import-later').click()
    await page.wait_for_selector('[data-pin-id]', timeout=30000)
    await page.wait_for_timeout(800)
    await page.get_by_test_id('filter-toggle').click()  # fold the filter bar
    await page.wait_for_timeout(300)
    await shot(page, 'phone-map-hint')
    # "Protect your places" (12 places >= 10), after the monthly closed-place notice if there is one.
    await show_protect(page)
    await page.get_by_test_id('hint-dismiss').click()
    await page.wait_for_timeout(300)
    await shot(page, 'phone-protect-card')
    # App lock: reload = new launch, the code is asked.
    await page.reload()
    await page.wait_for_selector('[data-testid="lock-screen"]', timeout=30000)
    await page.get_by_test_id('lock-code').fill('1111')
    await page.get_by_test_id('lock-unlock').click()
    await page.wait_for_timeout(300)
    await shot(page, 'phone-lock-screen')
    await page.get_by_test_id('lock-code').fill('2468')
    await page.get_by_test_id('lock-unlock').click()
    await page.wait_for_selector('[data-testid="lock-screen"]', state='detached')
    print('errors', errors)
    await b.close()

async def kit(p):
    b, page, errors = await setup(p, 390, 844)
    await first_launch(page)
    await show_protect(page)
    await page.get_by_test_id('protect-kit').click()
    await page.wait_for_selector('[data-testid="kit"]')
    await page.get_by_test_id('kit-reveal').click()
    await page.wait_for_selector('[data-testid="kit-words"]')
    await shot(page, 'phone-kit')
    words = await page.locator('[data-testid="kit-words"] > div').evaluate_all('els => els.map((e) => e.innerText.split(/\\s+/).pop())')
    # Copy to the clipboard (cleared after one minute), then the print view.
    await page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
    await page.get_by_test_id('kit-copy-phrase').click()
    await page.wait_for_selector('[data-testid="kit-message"]')
    await page.get_by_test_id('kit-message').scroll_into_view_if_needed()
    await shot(page, 'phone-kit-export')
    html_holder = []
    async def grab():
        for _ in range(40):
            for f in page.frames[1:]:
                try:
                    h = await f.content()
                    if 'class="w"' in h:
                        html_holder.append(h)
                        return
                except Exception:
                    pass
            await page.wait_for_timeout(25)
    task = asyncio.ensure_future(grab())
    await page.get_by_test_id('kit-print').click()
    await task
    if html_holder:
        pp = await page.context.new_page()
        await pp.set_viewport_size({'width': 794, 'height': 1123})
        await pp.set_content(html_holder[0])
        await pp.screenshot(path=f'{OUT}/web-kit-print.png')
        print('saved web-kit-print')
        await pp.close()
    # Check 3 words (one wrong first).
    await page.get_by_test_id('kit-next').click()
    await page.wait_for_selector('[data-testid="kit-check"]')
    labels = await page.locator('[data-testid^="kit-word-"]').evaluate_all('els => els.map((e) => e.getAttribute("aria-label"))')
    idx = [int(l.split()[-1]) - 1 for l in labels]
    for n, i in enumerate(idx):
        await page.get_by_test_id(f'kit-word-{n}').fill(words[i] if n else 'wrong')
    await page.get_by_test_id('kit-confirm').click()
    await page.wait_for_selector('[data-testid="kit-wrong"]')
    await shot(page, 'phone-kit-check')
    await page.get_by_test_id('kit-word-0').fill(words[idx[0]].upper())
    await page.get_by_test_id('kit-confirm').click()
    await page.wait_for_selector('[data-testid="kit-done"]')
    await shot(page, 'phone-kit-done')
    # Settings: kit saved, lock, device, appearance.
    await page.get_by_test_id('kit-back').click()
    await page.wait_for_selector('[data-pin-id]', timeout=30000)
    await page.get_by_test_id('open-settings').click()
    await page.wait_for_selector('[data-testid="settings"]')
    await shot(page, 'phone-settings')
    print('errors', errors)
    await b.close()

async def warm_up(page):
    # First launch of a fresh browser: let the seeded database reach IndexedDB before reloading.
    await page.goto(url('/'))
    await page.wait_for_selector('[data-pin-id]', timeout=30000)
    await page.wait_for_timeout(3000)

async def make_lists(page):
    await warm_up(page)
    await page.goto(url('/lists/edit'))
    await page.wait_for_selector('[data-testid="list-editor"]', timeout=30000)
    await page.get_by_test_id('list-name').fill('Weekend')
    await page.get_by_test_id('list-kind').get_by_text('Selection by hand', exact=True).click()
    await page.get_by_test_id('list-save').click()
    await page.wait_for_timeout(1500)  # the web database is written to IndexedDB shortly after
    await page.goto(url('/lists/edit'))
    await page.wait_for_selector('[data-testid="list-editor"]', timeout=30000)
    await page.get_by_test_id('list-name').fill('Good food')
    await page.get_by_test_id('list-tag-Restaurant').click()
    await page.get_by_test_id('list-save').click()
    await page.wait_for_timeout(1500)  # the web database is written to IndexedDB shortly after
    await page.goto(url('/lists/edit'))
    await page.wait_for_selector('[data-testid="list-editor"]', timeout=30000)
    await page.get_by_test_id('list-name').fill('Museums')
    await page.get_by_test_id('list-tag-Museum').click()
    await page.get_by_test_id('list-save').click()
    await page.wait_for_timeout(1500)  # the web database is written to IndexedDB shortly after

async def lists(p):
    b, page, errors = await setup(p, 390, 844)
    await make_lists(page)
    await page.goto(url('/place/local:demoplace02'))
    await page.wait_for_selector('[data-testid="card-lists"]', timeout=30000)
    await page.get_by_test_id('card-list-toggle-Weekend').click()
    await page.wait_for_timeout(300)
    await page.get_by_test_id('card-list-action-Museums').click()
    await page.wait_for_timeout(300)
    await page.get_by_test_id('card-lists').scroll_into_view_if_needed()
    await shot(page, 'phone-card-lists')
    # Same card, dark mode and French, on a tablet side panel.
    print('errors', errors)
    await b.close()
    b, page, errors = await setup(p, 1024, 768, dark=True, lang='fr-FR', touch=False)
    await make_lists_fr(page)
    await page.goto(url('/place/local:demoplace02'))
    await page.wait_for_selector('[data-testid="card-lists"]', timeout=30000)
    await page.get_by_test_id('card-lists').scroll_into_view_if_needed()
    await shot(page, 'tablet-dark-fr-card-lists')
    print('errors', errors)
    await b.close()

async def make_lists_fr(page):
    await warm_up(page)
    await page.goto(url('/lists/edit'))
    await page.wait_for_selector('[data-testid="list-editor"]', timeout=30000)
    await page.get_by_test_id('list-name').fill('Week-end')
    await page.get_by_test_id('list-kind').get_by_text('Sélection à la main', exact=True).click()
    await page.get_by_test_id('list-save').click()
    await page.wait_for_timeout(1500)  # the web database is written to IndexedDB shortly after
    await page.goto(url('/lists/edit'))
    await page.wait_for_selector('[data-testid="list-editor"]', timeout=30000)
    await page.get_by_test_id('list-name').fill('Musées')
    await page.get_by_test_id('list-tag-Musée').click()
    await page.get_by_test_id('list-save').click()
    await page.wait_for_timeout(1500)  # the web database is written to IndexedDB shortly after

async def adapt(p):
    """T-117/T-118: font scale 2.0 on a small phone, foldable (outer and inner), landscape, dark."""
    # Small phone (iPhone SE, 320 pt in Display Zoom) with text at 2.0.
    b, page, errors = await setup(p, 320, 568)
    await page.goto(BASE + '/')
    await page.wait_for_selector('[data-testid="welcome"]', timeout=30000)
    await font_scale(page, 2.0)
    await shot(page, 'small-font2-welcome')
    await page.goto(url('/'))
    await page.wait_for_selector('[data-pin-id]', timeout=30000)
    await page.wait_for_timeout(600)
    await font_scale(page, 2.0)
    await shot(page, 'small-font2-map')
    await page.goto(url('/settings'))
    await page.wait_for_selector('[data-testid="settings"]', timeout=30000)
    await font_scale(page, 2.0)
    await shot(page, 'small-font2-settings')
    print('errors', errors)
    await b.close()
    # Kit at 1.5 on a large phone.
    b, page, errors = await setup(p, 430, 932)
    await page.goto(url('/kit'))
    await page.wait_for_selector('[data-testid="kit"]', timeout=30000)
    await page.get_by_test_id('kit-reveal').click()
    await font_scale(page, 1.5)
    await shot(page, 'large-font15-kit')
    print('errors', errors)
    await b.close()
    # Foldable: outer screen (Galaxy Z Fold cover, 344 pt), then unfolded (two panes).
    b, page, errors = await setup(p, 344, 882)
    await page.goto(BASE + '/')
    await page.wait_for_selector('[data-testid="welcome"]', timeout=30000)
    await page.get_by_test_id('welcome-start').click()
    await page.wait_for_selector('[data-testid="keys-ready"]', timeout=30000)
    await page.get_by_test_id('profile-name').fill('Camille')
    await shot(page, 'fold-outer-profile')
    await page.set_viewport_size({'width': 690, 'height': 841})  # unfolded: nothing typed is lost
    await page.wait_for_timeout(500)
    await shot(page, 'fold-inner-profile')
    print('errors', errors)
    await b.close()
    # Landscape phone, dark: the kit check and the welcome.
    b, page, errors = await setup(p, 844, 390, dark=True)
    await page.goto(BASE + '/')
    await page.wait_for_selector('[data-testid="welcome"]', timeout=30000)
    await shot(page, 'landscape-dark-welcome')
    await page.goto(url('/kit'))
    await page.wait_for_selector('[data-testid="kit"]', timeout=30000)
    await page.get_by_test_id('kit-reveal').click()
    await page.wait_for_timeout(300)
    await shot(page, 'landscape-dark-kit')
    print('errors', errors)
    await b.close()
    # Tablet, French: settings.
    b, page, errors = await setup(p, 834, 1194, lang='fr-FR', touch=True)
    await page.goto(url('/settings'))
    await page.wait_for_selector('[data-testid="settings"]', timeout=30000)
    await shot(page, 'tablet-fr-settings')
    print('errors', errors)
    await b.close()

async def main():
    which = sys.argv[2:] or ['phone', 'kit', 'lists', 'adapt']
    async with async_playwright() as p:
        for w in which:
            await globals()[w](p)

asyncio.run(main())
