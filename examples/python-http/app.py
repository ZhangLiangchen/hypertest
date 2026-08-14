#!/usr/bin/env python3
"""Tiny HTTP fixture used by HyperTest's cross-language conformance suite."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


class Handler(BaseHTTPRequestHandler):
    server_version = "HyperTestFixture/1.0"

    def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
        path = unquote(urlsplit(self.path).path)
        if path == "/health":
            self._json(200, {"status": "ok"})
            return
        if path.startswith("/greet/"):
            name = path[len("/greet/") :]
            if not name or name == "{name}" or len(name) > 32:
                self._json(400, {"error": "name is required"})
                return
            self._json(200, {"message": f"hello, {name}"})
            return
        if path in {"/greet", "/greet/"}:
            self._json(400, {"error": "name is required"})
            return
        self._json(404, {"error": "not found"})

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _json(self, status: int, value: object) -> None:
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    try:
        server.serve_forever(poll_interval=0.05)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
