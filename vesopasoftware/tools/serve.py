#!/usr/bin/env python3
"""Static server for site/.

python3 -m http.server is single-threaded: Chromium opens several parallel
connections for the fonts, three.js and a dozen images, and the whole page
load stalls until the 30s navigation timeout. Threading fixes it.
"""
import sys, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5080
H = functools.partial(SimpleHTTPRequestHandler, directory="site")
H.log_message = lambda *a, **k: None          # quiet; failures still surface in the driver
print(f"serving site/ on http://localhost:{port}/", flush=True)
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
