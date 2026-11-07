"""Screenshots of Settings › Storage (T-203): web export in fixture mode, against the Apache
WebDAV server of packages/storage/scripts/real-servers.sh (127.0.0.1:8081, run as root).

    EXPO_PUBLIC_OSM_FIXTURES=1 npx expo export --platform web --output-dir dist
    python3 scripts/serve.py dist 8765 &
    python3 scripts/shots_storage.py docs

The write side goes through a small CORS proxy started here (like e2e/storage.spec.ts); friends'
read address `https://friends.triangulair.test/pub/...` is answered from Apache's anonymous /pub.
"""
import asyncio, datetime, http.client, http.server, json, os, random, string, sys, threading, base64
import urllib.request
from playwright.async_api import async_playwright

BASE = os.environ.get('SHOTS_BASE', 'http://127.0.0.1:8765')
OUT = sys.argv[1]
NOW = datetime.datetime(2026, 10, 23, 16, 30, tzinfo=datetime.timezone.utc)
DAV = ('127.0.0.1', 8081)
AUTH = 'Basic ' + base64.b64encode(b'alice:s3cret').decode()
FRIENDS = 'https://friends.triangulair.test'
DELAY = {'s': 0.0}

class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Depth, If-Match, If-None-Match')
        self.send_header('Access-Control-Expose-Headers', 'ETag, OC-ETag, Content-Length')
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def forward(self):
        import time
        if DELAY['s']: time.sleep(DELAY['s'])
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        c = http.client.HTTPConnection(*DAV)
        h = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'origin')}
        c.request(self.command, self.path, body=body, headers=h)
        r = c.getresponse(); data = r.read()
        self.send_response(r.status)
        for k, v in r.getheaders():
            if k.lower() not in ('transfer-encoding', 'connection', 'content-length'): self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.cors(); self.end_headers()
        if self.command != 'HEAD': self.wfile.write(data)
    do_GET = do_HEAD = do_PUT = do_DELETE = do_PROPFIND = do_MKCOL = forward

def start_proxy():
    s = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{s.server_address[1]}'

def dav(method, path, body=None):
    req = urllib.request.Request(f'http://{DAV[0]}:{DAV[1]}/dav/{path}', data=body, method=method, headers={'Authorization': AUTH})
    try:
        return urllib.request.urlopen(req).status
    except urllib.error.HTTPError as e:
        return e.code

def put(path, body):
    parts = path.split('/')[:-1]
    for i in range(1, len(parts) + 1): dav('MKCOL', '/'.join(parts[:i]) + '/')
    dav('PUT', path, body)

def folder():
    return 'shots-' + ''.join(random.choices(string.ascii_lowercase, k=6))

def style(dark):
    return json.dumps({"version": 8, "sources": {}, "layers": [{"id": "bg", "type": "background", "paint": {"background-color": "#1D232B" if dark else "#ECEBE6"}}]})

async def setup(p, width, height, dark=False, lang='en-US'):
    b = await p.chromium.launch()
    ctx = await b.new_context(viewport={'width': width, 'height': height}, device_scale_factor=2, locale=lang,
                              timezone_id='Europe/Paris', color_scheme='dark' if dark else 'light', has_touch=width < 600)
    page = await ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type in ('warning', 'error') and print('console:', m.text))
    await page.clock.set_system_time(NOW)
    await page.route('https://tiles.openfreemap.org/**', lambda r: r.fulfill(status=200, content_type='application/json', body=style(dark)))
    async def friends(route):
        r = await route.fetch(url=route.request.url.replace(FRIENDS, f'http://{DAV[0]}:{DAV[1]}'), headers={})
        await route.fulfill(response=r, headers={**r.headers, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'ETag'})
    await page.route(FRIENDS + '/**', friends)
    return b, page, errors

def url(path, lang=None):
    q = 'autostart=1' + (f'&lang={lang}' if lang else '')
    return BASE + path + ('&' if '?' in path else '?') + q

async def shot(page, name, at=None):
    """Viewport shot (the screens scroll inside a ScrollView); `at`: test id to scroll to the top."""
    if at:
        await page.get_by_test_id(at).first.evaluate('(e) => e.scrollIntoView({block: "start"})')
    await page.wait_for_timeout(300)
    await page.screenshot(path=f'{OUT}/{name}.png')
    print('saved', name)

async def fill_webdav(page, base, d, password='s3cret'):
    if await page.get_by_test_id('choice-other').count(): await page.get_by_test_id('choice-other').click()
    await page.get_by_test_id('choice-webdav').click()
    await page.get_by_test_id('field-davUrl').fill(f'{base}/dav/{d}/')
    await page.get_by_test_id('field-davUser').fill('alice')
    await page.get_by_test_id('field-davPassword').fill(password)
    await page.get_by_test_id('field-readUrl').fill(f'{FRIENDS}/pub/{d}/')

async def run_test(page):
    await page.get_by_test_id('setup-test').click()
    await page.wait_for_selector('[data-testid="test-summary"]', timeout=30000)

async def phone(p, proxy, dark=False, prefix='phone'):
    b, page, errors = await setup(p, 390, 844, dark=dark)
    await page.goto(url('/storage'))
    await page.wait_for_selector('[data-testid="storage-local"]', timeout=30000)
    if not dark: await shot(page, f'{prefix}-storage-local')
    await page.get_by_test_id('storage-connect').click()
    await page.wait_for_selector('[data-testid="choice-nextcloud"]')
    if not dark: await shot(page, f'{prefix}-storage-choose')
    # Nextcloud helper: the folder URL built from server + user, problems shown after "Test".
    await page.get_by_test_id('choice-nextcloud').click()
    await page.get_by_test_id('field-ncServer').fill('cloud.example.org')
    await page.get_by_test_id('field-ncUser').fill('marie@example.org')
    await page.get_by_test_id('setup-test').click()
    if not dark: await shot(page, f'{prefix}-storage-nextcloud-form', at='choice-other')
    # CORS diagnosis: Apache directly, from the browser.
    d = folder()
    await fill_webdav(page, f'http://{DAV[0]}:{DAV[1]}', d)
    await run_test(page)
    await shot(page, f'{prefix}-storage-test-cors', at='step-reach')
    # Through the proxy: all green.
    await page.get_by_test_id('field-davUrl').fill(f'{proxy}/dav/{d}/')
    await run_test(page)
    await shot(page, f'{prefix}-storage-test-ok', at='test-results')
    if not dark: await shot(page, f'{prefix}-storage-certify', at='test-summary')
    await page.get_by_test_id('master-go').click()
    await page.wait_for_selector('[data-testid="storage-connected-banner"]')
    await page.get_by_test_id('storage-done').click()
    await page.wait_for_selector('[data-testid="storage-read-address"]')
    if dark:
        await shot(page, f'{prefix}-storage-connected')
        await b.close(); return
    # Content on A, then a move to B with progress (slowed down), verification and switch.
    for i in range(40): put(f'{d}/packs/b2b256-p{i}.bin', os.urandom(3000 + i * 50))
    put(f'{d}/media/photo-1.bin', os.urandom(300_000))
    put(f'{d}/index.json', b'{"seq":3}')
    e = folder()
    await page.get_by_test_id('storage-change').click()
    await fill_webdav(page, proxy, e)
    await run_test(page)
    await page.get_by_test_id('setup-use').click()
    await page.wait_for_selector('[data-testid="move-start"]', timeout=30000)
    await shot(page, f'{prefix}-storage-move-plan')
    DELAY['s'] = 0.15
    await page.get_by_test_id('move-start').click()
    await page.wait_for_timeout(2500)
    await shot(page, f'{prefix}-storage-move-progress', at='move-progress')
    DELAY['s'] = 0
    await page.wait_for_selector('[data-testid="move-verified"]', timeout=120000)
    await shot(page, f'{prefix}-storage-move-verified', at='move-verified')
    await page.get_by_test_id('master-go').click()
    await page.wait_for_selector('[data-testid="move-done"]', timeout=30000)
    await shot(page, f'{prefix}-storage-move-done', at='move-done')
    await page.get_by_test_id('move-finish').click()
    await page.wait_for_selector('[data-testid="storage-previous"]')
    await shot(page, f'{prefix}-storage-overview')
    print('errors', errors)
    await b.close()

async def tablet_fr(p, proxy):
    b, page, errors = await setup(p, 834, 1194, lang='fr-FR')
    await page.goto(url('/storage/setup', 'fr'))
    await page.wait_for_selector('[data-testid="choice-s3"]', timeout=30000)
    await page.get_by_test_id('choice-s3').click()
    await page.get_by_test_id('field-s3Endpoint').fill('https://s3.fr-par.scw.cloud')
    await page.get_by_test_id('field-s3Bucket').fill('mes-lieux')
    await page.get_by_test_id('field-s3Region').fill('fr-par')
    await page.get_by_test_id('field-s3Prefix').fill('')
    await shot(page, 'tablet-fr-storage-s3')
    await page.goto(url('/lists/edit', 'fr'))
    await page.wait_for_selector('[data-testid="storage-needed"]', timeout=30000)
    await shot(page, 'tablet-fr-list-storage-needed', at='list-visibility')
    print('errors', errors)
    await b.close()

async def main():
    proxy = start_proxy()
    async with async_playwright() as p:
        await phone(p, proxy)
        await phone(p, proxy, dark=True, prefix='phone-dark')
        await tablet_fr(p, proxy)

asyncio.run(main())
