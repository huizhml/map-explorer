"""Caching for rendered imagery: in the server, in the browser, and on the wire.

A rendered tile is a pure function of (source COG, render parameters) — the URL
says everything about it — so it can be kept and served again instead of being
re-rendered. Three layers, all on every deployment (hendrix and Cloud Run
alike):

  * ``ServerTileCache`` keeps recently rendered tiles in this process's memory,
    an LRU bounded in bytes. A second request for the same tile — the same
    reader panning back, or a second reader on the same ground — is answered
    without opening a COG. It reports ``x-tile-cache: HIT`` / ``MISS``.

  * ``CacheControlMiddleware`` stamps ``Cache-Control`` on rendered imagery.
    TiTiler sets none, so without it the browser asks again for every tile it
    has already shown.

  * gzip for large non-image responses — the MGRS grid is 5.1 MB of FlatGeobuf
    and gzips to 1.1 MB, and the frontend fetches all of it before it can ask
    for a single prediction tile.

On Cloud Run the memory cache is per instance and empties when the service
scales to zero; there is no disk to spill to (``/tmp`` is memory there too),
which is why the cache is in memory and sized in bytes. The default leaves most
of a 2 GiB instance to rendering.

Environment:
  TILE_SERVER_CACHE_MB   memory for the server cache; 0 turns it off (default 256)
  TILE_SERVER_CACHE_TTL  seconds a cached tile is served before it is re-rendered
                         (default 86400 — a COG replaced on disk shows up within a day)
  TILE_CACHE_MAX_AGE     browser Cache-Control max-age, seconds (default 86400)
  GZIP_MIN_BYTES         responses smaller than this are not gzipped (default 500000)
"""

from __future__ import annotations

import os
import time
from collections import OrderedDict
from typing import Optional

from starlette.middleware.gzip import GZipMiddleware

# Rendered imagery the browser may cache. Saved-feature images are included:
# their URLs change when they are re-rendered.
_BROWSER_CACHEABLE_PREFIXES = (
    "/cog/tiles",
    "/cog/preview",
    "/cog/crop",
    "/predictions/interval-tile",
    "/saved-features/image",
)

# Map tiles only. Saved-feature images are served from disk already, and a
# re-render replaces the file behind the same URL — a server cache would keep
# serving the old one.
_SERVER_CACHEABLE_PREFIXES = (
    "/cog/tiles",
    "/predictions/interval-tile",
)

# A map tile is tens of kB. Anything much bigger is not a map tile, and keeping
# it would push out hundreds that are.
_MAX_ITEM_BYTES = 2 * 1024 * 1024


class ServerTileCache:
    """In-memory LRU of rendered tiles, keyed by path and query string.

    Pure ASGI, so it does not sit in the streaming path of other responses.
    The event loop runs it on one thread, so the dict needs no lock.
    """

    def __init__(self, app, max_bytes: int, ttl_seconds: int):
        self.app = app
        self.max_bytes = max_bytes
        self.ttl = ttl_seconds
        # key -> (stored_at, status, headers, body)
        self._items: "OrderedDict[bytes, tuple[float, int, list, bytes]]" = OrderedDict()
        self._bytes = 0

    def _get(self, key: bytes) -> Optional[tuple[int, list, bytes]]:
        item = self._items.get(key)
        if item is None:
            return None
        stored_at, status, headers, body = item
        if time.monotonic() - stored_at > self.ttl:
            self._drop(key)
            return None
        self._items.move_to_end(key)
        return status, headers, body

    def _drop(self, key: bytes) -> None:
        item = self._items.pop(key, None)
        if item is not None:
            self._bytes -= len(item[3])

    def _put(self, key: bytes, status: int, headers: list, body: bytes) -> None:
        if len(body) > _MAX_ITEM_BYTES or len(body) > self.max_bytes:
            return
        self._drop(key)
        self._items[key] = (time.monotonic(), status, headers, body)
        self._bytes += len(body)
        while self._bytes > self.max_bytes and self._items:
            oldest = next(iter(self._items))
            self._drop(oldest)

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope.get("method", "GET").upper() != "GET"
            or not scope.get("path", "").startswith(_SERVER_CACHEABLE_PREFIXES)
        ):
            await self.app(scope, receive, send)
            return

        key = scope["path"].encode("utf-8") + b"?" + scope.get("query_string", b"")
        hit = self._get(key)
        if hit is not None:
            status, headers, body = hit
            await send({
                "type": "http.response.start",
                "status": status,
                "headers": [*headers, (b"x-tile-cache", b"HIT")],
            })
            await send({"type": "http.response.body", "body": body})
            return

        start: dict = {}
        chunks: list[bytes] = []

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                start.update(message)
                message = {**message, "headers": [*message.get("headers", []), (b"x-tile-cache", b"MISS")]}
            elif message["type"] == "http.response.body":
                chunks.append(message.get("body", b""))
                if not message.get("more_body", False) and start.get("status") == 200:
                    self._put(key, 200, list(start.get("headers", [])), b"".join(chunks))
            await send(message)

        await self.app(scope, receive, send_wrapper)


class CacheControlMiddleware:
    """Stamp Cache-Control on rendered imagery that does not set its own."""

    def __init__(self, app, max_age: int):
        self.app = app
        self.header_value = f"public, max-age={max_age}".encode("latin-1")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method", "GET").upper() != "GET":
            await self.app(scope, receive, send)
            return
        if not scope.get("path", "").startswith(_BROWSER_CACHEABLE_PREFIXES):
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start" and message["status"] == 200:
                headers = message.setdefault("headers", [])
                if not any(k.lower() == b"cache-control" for k, _ in headers):
                    headers.append((b"cache-control", self.header_value))
            await send(message)

        await self.app(scope, receive, send_wrapper)


def install_tile_caching(app) -> None:
    """Attach all three. Call before install_public_guard, so the guard is the
    outermost layer and a request it rejects never reaches the cache."""
    cache_mb = int(os.environ.get("TILE_SERVER_CACHE_MB", "256"))
    ttl = int(os.environ.get("TILE_SERVER_CACHE_TTL", "86400"))
    max_age = int(os.environ.get("TILE_CACHE_MAX_AGE", "86400"))
    gzip_min = int(os.environ.get("GZIP_MIN_BYTES", "500000"))

    # Starlette wraps in reverse: the last added is outermost. CORS was added
    # before this, so it sits inside all three — what the server cache stores
    # and replays already carries the CORS headers. The cache sits inside the
    # other two, so a replayed tile still gets Cache-Control.
    if cache_mb > 0:
        app.add_middleware(ServerTileCache, max_bytes=cache_mb * 1024 * 1024, ttl_seconds=ttl)
    app.add_middleware(CacheControlMiddleware, max_age=max_age)
    # minimum_size is well above tile size on purpose: rendered PNGs are
    # already compressed, and gzipping them would burn CPU for nothing.
    app.add_middleware(GZipMiddleware, minimum_size=gzip_min)

    print(
        f"[tile-cache] server cache: {cache_mb} MB, ttl {ttl}s · "
        f"browser Cache-Control max-age={max_age} · gzip >= {gzip_min} B"
    )
