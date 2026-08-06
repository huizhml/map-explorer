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

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
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


class PublicReadOnlyMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, allowed_prefixes: tuple[str, ...]):
        super().__init__(app)
        self.allowed_prefixes = allowed_prefixes

    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path.rstrip("/") or "/"
        method = request.method.upper()

        if path in _BLOCKED_PATHS:
            return _deny("This endpoint is disabled on the public deployment.")

        if method in {"PUT", "PATCH", "DELETE"}:
            return _deny("This deployment is read-only.")

        if method == "POST" and any(p.match(path) for p in _BLOCKED_POST):
            return _deny("This deployment is read-only.")

        if self.allowed_prefixes:
            for key in _URL_PARAMS:
                value = request.query_params.get(key)
                if value is None:
                    continue
                if not value.startswith(self.allowed_prefixes):
                    return _deny(
                        f"'{key}' must start with one of: "
                        + ", ".join(self.allowed_prefixes)
                    )

        return await call_next(request)


# Rendered imagery is a pure function of (source COG, render params), so it can
# be cached by the browser and by any CDN placed in front. TiTiler sets no
# Cache-Control at all, which means a reviewer panning back over ground they
# already looked at re-renders every tile — and each one costs a round trip to
# source.coop, which measures 2-4 s.
_CACHEABLE_PREFIXES = (
    "/cog/tiles",
    "/cog/preview",
    "/cog/crop",
    "/predictions/interval-tile",
    "/saved-features/image",
)


class TileCacheMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, max_age: int):
        super().__init__(app)
        self.header_value = f"public, max-age={max_age}"

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if (
            request.method == "GET"
            and response.status_code == 200
            and request.url.path.startswith(_CACHEABLE_PREFIXES)
            and "cache-control" not in response.headers
        ):
            response.headers["Cache-Control"] = self.header_value
        return response


def install_public_guard(app) -> bool:
    """Attach the guard when PUBLIC_READONLY is set. Returns whether it was."""
    if not readonly_enabled():
        return False

    prefixes = _allowed_prefixes()
    app.add_middleware(PublicReadOnlyMiddleware, allowed_prefixes=prefixes)

    # A day, not a month: the source COGs are still being uploaded, so pinning
    # renders for weeks would serve stale imagery long after a tile is replaced.
    max_age = int(os.environ.get("TILE_CACHE_MAX_AGE", "86400"))
    app.add_middleware(TileCacheMiddleware, max_age=max_age)

    print("=== PUBLIC_READONLY enabled ===")
    print(f"  blocked paths     : {sorted(_BLOCKED_PATHS)}")
    print(f"  allowed url prefix: {list(prefixes) or 'NONE SET — url= is unrestricted!'}")
    print(f"  tile Cache-Control: public, max-age={max_age}")
    print("===============================")
    return True
