"""Local preview server. Same as `python3 -m http.server`, but tells the browser
never to cache, so a reload always shows the files as they are on disk.
It always serves the folder this file lives in, wherever it is started from."""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    ThreadingHTTPServer(("", port), partial(NoCacheHandler, directory=HERE)).serve_forever()
