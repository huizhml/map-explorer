"""Forget what GDAL cached for a remote file after a failed read.

GDAL's /vsicurl/ keeps the byte ranges it fetched in a process-wide cache. When
source.coop cuts a response short (a few requests per thousand, 2026-10-29:
"TIFFFillTile: ... got 65685 bytes, expected 633265"), the short range is
cached too, and every later read of that block in this process fails at once,
without touching the network, until the backend restarts. That broke map tiles
(titiler) as well as profiles and cubes.

rasterio has no API for this, so the GDAL C function VSICurlPartialClearCache
is called through ctypes on the libgdal rasterio itself loaded. If it cannot be
found, `clear` returns False and callers fall back to other means.
"""

from __future__ import annotations

import ctypes
import glob
import os
import re
import sys
import threading
from typing import Optional

_lock = threading.Lock()
_fn = None
_looked = False


def _candidates():
    import rasterio

    pkg = os.path.dirname(rasterio.__file__)
    # The library rasterio is linked against, in order: the one already mapped
    # into this process (Linux), the wheel's bundled copy (macOS / Linux), conda.
    if os.path.exists("/proc/self/maps"):
        with open("/proc/self/maps") as f:
            for line in f:
                m = re.search(r"(/\S*libgdal[^/\s]*\.so[^/\s]*)$", line.strip())
                if m:
                    yield m.group(1)
    yield from glob.glob(os.path.join(pkg, ".dylibs", "libgdal*"))
    yield from glob.glob(os.path.join(os.path.dirname(pkg), "rasterio.libs", "libgdal*"))
    yield from sorted(glob.glob(os.path.join(sys.prefix, "lib", "libgdal.*")))


def _load():
    global _fn, _looked
    with _lock:
        if _looked:
            return _fn
        _looked = True
        for path in _candidates():
            try:
                lib = ctypes.CDLL(path)
                fn = lib.VSICurlPartialClearCache
            except (OSError, AttributeError):
                continue
            fn.argtypes = [ctypes.c_char_p]
            fn.restype = None
            _fn = fn
            break
        if _fn is None:
            print("[gdal-cache] VSICurlPartialClearCache not found; failed reads stay cached until restart")
        return _fn


def clear(url: Optional[str]) -> bool:
    """Drop GDAL's cached ranges for one http(s) URL (or a /vsicurl/ path)."""
    if not url:
        return False
    if url.startswith(("http://", "https://")):
        url = "/vsicurl/" + url
    if not url.startswith("/vsicurl/"):
        return False
    fn = _load()
    if fn is None:
        return False
    fn(url.encode())
    return True


_TIF_IN_ERROR = re.compile(r"(\S+?\.tif)\b")


def clear_after_error(exc: BaseException, url: Optional[str] = None) -> bool:
    """After a failed read: clear the URL if known, else the file named in the
    GDAL message (titiler errors carry the file name, not the URL)."""
    if url:
        return clear(url)
    msg = str(exc)
    c = exc
    while (c.__cause__ or c.__context__) is not None:
        c = c.__cause__ or c.__context__
        msg += " " + str(c)
    if "TIFF" not in msg and "IReadBlock" not in msg and "Read failed" not in msg:
        return False
    # Only a bare file name ("RH98_Q1.tif") is in the message: clearing by that
    # alone is not possible, so drop the whole remote-read cache. Rare (a few
    # failures per thousand requests) and cheap: headers are re-read on demand.
    fn = _load()
    if fn is None:
        return False
    fn(b"/vsicurl/")
    return True
