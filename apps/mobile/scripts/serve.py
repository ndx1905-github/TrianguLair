# Static server for the Expo web export (end-to-end tests).
#
#   python3 scripts/serve.py dist 4319                       SPA: unknown paths get /index.html
#   python3 scripts/serve.py dist-pwa 4320 /triangulair      like YunoHost "My webapp" under a sub-path:
#                                                            files under /triangulair/ only, `try_files
#                                                            $uri $uri/ =404` (no fallback page)
import http.server, os, sys
ROOT = sys.argv[1]; PORT = int(sys.argv[2])
BASE = sys.argv[3].rstrip('/') if len(sys.argv) > 3 else None

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.webmanifest': 'application/manifest+json'}
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def end_headers(self):
        # The service worker script is always revalidated (browsers do so anyway for sw.js).
        if self.path.split('?')[0].endswith('/sw.js'): self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def do_GET(self):
        path = self.path.split('?')[0]
        if BASE is not None:
            if path != BASE and not path.startswith(BASE + '/'):
                return self.send_error(404)
            rest = path[len(BASE):] or '/'
            full = os.path.join(ROOT, rest.lstrip('/'))
            if os.path.isdir(full):
                if not os.path.exists(os.path.join(full, 'index.html')): return self.send_error(404)
                # nginx `$uri/`: the folder's index.html, served without a redirect.
                self.path = rest.rstrip('/') + '/index.html'
            elif rest == '/sw.js' and 'tl-e2e-sw=next' in (self.headers.get('Cookie') or ''):
                # e2e/pwa.spec.ts, "a new version": the same service worker as a newer build.
                with open(full, 'rb') as f: body = f.read().replace(b'","base":', b'-next","base":', 1)
                self.send_response(200)
                self.send_header('Content-Type', 'text/javascript')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            elif os.path.exists(full):
                self.path = rest + (self.path[len(path):])
            else:
                return self.send_error(404)
            return super().do_GET()
        if not os.path.exists(os.path.join(ROOT, path.lstrip('/'))) or path == '/':
            self.path = '/index.html'
        return super().do_GET()

http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
