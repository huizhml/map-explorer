"""Public-deployment guard: read-only mode + dataset-URL allowlist.

The internal (hendrix/lumi) deployment trusts its callers: TiTiler's ``url=``
parameter accepts any path or URL, ``/auxiliary/list-dirs`` enumerates server
directories, and the saved-features routes write to disk. None of that is safe
on a public host.

Setting ``PUBLIC_READONLY=1`` installs a middleware that:
  * rejects every mutating request (writes to the DB / image root),
  * blocks the filesystem-browsing endpoints outright,
  * confines ``url`` / ``url_high`` / ``url_low`` to ``ALLOWED_DATA_URL_PREFIXES``.

Off by default, so importing this module changes nothing for the internal
deployment.
"""

from __future__ import annotations

import os
import re
from typing import Optional

from starlette.datastructures import QueryParams
from starlette.responses import JSONResponse

_TRUTHY = {"1", "true", "yes", "on"}

# Endpoints that expose or mutate the server filesystem. No public equivalent.
_BLOCKED_PATHS = frozenset({
    "/auxiliary/list-dirs",   # enumerates arbitrary server directories
    "/auxiliary/save-figures",  # writes to an arbitrary server path
    "/fgb/path",              # reads an arbitrary server file
})

# POST routes that mutate state. Every other POST in the app is pure
# computation (figure rendering, profile sampling, geometry lookup) and stays
# available — that is the whole point of read-only mode.
_BLOCKED_POST = (
    re.compile(r"^/saved-features/?$"),
    re.compile(r"^/saved-features/area-images/?$"),
    re.compile(r"^/saved-features/[^/]+/refresh-"),
)

# Query params that carry a dataset path into rio-tiler / GDAL.
_URL_PARAMS = ("url", "url_high", "url_low")

_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
}


def readonly_enabled() -> bool:
    return os.environ.get("PUBLIC_READONLY", "").strip().lower() in _TRUTHY


def _allowed_prefixes() -> tuple[str, ...]:
    raw = os.environ.get("ALLOWED_DATA_URL_PREFIXES", "")
    return tuple(p.strip() for p in raw.split(",") if p.strip())


def _deny(detail: str, status: int = 403) -> JSONResponse:
    # Carry CORS headers explicitly: this response short-circuits the stack, so
    # the CORS middleware never sees it and the browser would otherwise report a
    # useless "Failed to fetch" instead of the real reason.
    return JSONResponse({"detail": detail}, status_code=status, headers=_CORS_HEADERS)


# Pure ASGI, not BaseHTTPMiddleware, deliberately. BaseHTTPMiddleware pumps
# every chunk of a StreamingResponse through an anyio memory stream, and the
# cost is per-chunk: the FlatGeobuf endpoints stream a 5 MB grid in 8 KB pieces,
# which measured ~0.15 s *per chunk* through a stack of three such middlewares —
# minutes for one file, and the transfer stalled outright. Pure ASGI middleware
# passes the send/receive callables straight through and adds nothing per chunk.
class PublicReadOnlyMiddleware:
    def __init__(self, app, allowed_prefixes: tuple[str, ...]):
        self.app = app
        self.allowed_prefixes = allowed_prefixes

    def _rejection(self, scope) -> Optional[JSONResponse]:
        method = scope.get("method", "GET").upper()
        if method == "OPTIONS":
            return None

        path = scope.get("path", "/").rstrip("/") or "/"

        if path in _BLOCKED_PATHS:
            return _deny("This endpoint is disabled on the public deployment.")

        if method in {"PUT", "PATCH", "DELETE"}:
            return _deny("This deployment is read-only.")

        if method == "POST" and any(p.match(path) for p in _BLOCKED_POST):
            return _deny("This deployment is read-only.")

        if self.allowed_prefixes:
            params = QueryParams(scope.get("query_string", b"").decode("latin-1"))
            for key in _URL_PARAMS:
                value = params.get(key)
                if value is None:
                    continue
                if not value.startswith(self.allowed_prefixes):
                    return _deny(
                        f"'{key}' must start with one of: "
                        + ", ".join(self.allowed_prefixes)
                    )
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        rejection = self._rejection(scope)
        if rejection is not None:
            await rejection(scope, receive, send)
            return

        await self.app(scope, receive, send)


def install_public_guard(app) -> bool:
    """Attach the guard when PUBLIC_READONLY is set. Returns whether it was."""
    if not readonly_enabled():
        return False

    prefixes = _allowed_prefixes()
    app.add_middleware(PublicReadOnlyMiddleware, allowed_prefixes=prefixes)

    # Caching (Cache-Control, the server tile cache, gzip) is no longer part
    # of the guard: it is on for every deployment — see tile_cache.py.

    print("=== PUBLIC_READONLY enabled ===")
    print(f"  blocked paths     : {sorted(_BLOCKED_PATHS)}")
    print(f"  allowed url prefix: {list(prefixes) or 'NONE SET — url= is unrestricted!'}")
    print("===============================")
    return True
