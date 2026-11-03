# Static server with SPA fallback for the Expo web export.
import http.server, os, sys
ROOT = sys.argv[1]; PORT = int(sys.argv[2])
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        path = self.path.split('?')[0]
        if not os.path.exists(os.path.join(ROOT, path.lstrip('/'))) or path == '/':
            self.path = '/index.html'
        return super().do_GET()
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
