"""A size x size window of all 101 RH layers (RH0..RH100) of one MGRS tile.

Shared by the point profile and the 3D cube view. The per-RH COGs are tiled in
1024 px blocks, so reading a single pixel already downloads and decodes the
whole block around it (~0.9 MB per RH, ~90 MB per click). A window that stays
inside that block costs no extra bytes, so the profile reads the window, and the
cube request for the same click is served from the result instead of reading
the 101 blocks a second time.

Window placement: centred on the clicked pixel, then shifted (not clipped) so
it stays inside the 1024 px block that holds the pixel. Crossing a block edge
would download 2-4 blocks per RH instead of one. The shift is reported so the
UI can say how far the window moved and mark the clicked pixel. Where the block
is narrower than the window (never for 128 px: the last block of a 10980 px
tile is 740 px), the window is only kept inside the tile.
"""

from __future__ import annotations

import gzip
import json
import os
import struct
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Hashable, List, Optional, Sequence, Tuple

import numpy as np

import gdal_cache
import rasterio
from rasterio.transform import rowcol
from rasterio.warp import transform as rw_transform
from rasterio.windows import Window, bounds as window_bounds

NODATA = 32767
N_LEVELS = 101  # RH0..RH100
CUBE_SIZE = 128
# One entry is 101 x 128 x 128 int16 = 3.3 MB.
_CACHE_ENTRIES = max(1, int(os.environ.get("CUBE_CACHE_ENTRIES", "16")))


@dataclass(frozen=True)
class Grid:
    crs: str
    transform: rasterio.Affine
    width: int
    height: int
    block_w: int
    block_h: int


@dataclass(frozen=True)
class Placement:
    row: int  # clicked pixel in the tile
    col: int
    row_off: int  # window origin in the tile
    col_off: int
    size: int
    shift_east_m: float  # how far the window centre moved from the clicked pixel
    shift_north_m: float
    shift_reason: Optional[str]  # None | "block" | "tile"


@dataclass
class Stack:
    data: np.ndarray  # int16 [rh][row][col], decimetres, NODATA = 32767
    missing: List[int] = field(default_factory=list)  # file absent from the archive
    failed: List[int] = field(default_factory=list)  # read error after GDAL's retries


class OutsideTile(ValueError):
    pass


# ---------------------------------------------------------------- grid ----

_grid_cache: dict = {}
_grid_lock = threading.Lock()


def tile_grid(key: Hashable, paths: Sequence[Optional[str]]) -> Grid:
    """Grid of a tile, read once from any one of its RH files (all share it)."""
    with _grid_lock:
        hit = _grid_cache.get(key)
    if hit:
        return hit
    # RH50 first: it exists wherever the tile does. Then any other level.
    order = [50] + [i for i in range(len(paths)) if i != 50]
    last_err: Optional[Exception] = None
    for i in order:
        p = paths[i] if i < len(paths) else None
        if not p:
            continue
        try:
            with rasterio.open(p) as src:
                bh, bw = src.block_shapes[0]
                grid = Grid(src.crs.to_string(), src.transform, src.width, src.height, bw, bh)
            with _grid_lock:
                _grid_cache[key] = grid
            return grid
        except Exception as ex:  # try the next level
            last_err = ex
    raise RuntimeError(f"no readable RH file for {key}: {last_err}")


def _axis(p: int, n: int, block: int, size: int) -> Tuple[int, int, Optional[str]]:
    want = p - size // 2
    b0 = (p // block) * block
    b1 = min(b0 + block, n)
    lo, hi = (b0, b1 - size) if b1 - b0 >= size else (0, max(0, n - size))
    off = min(max(want, lo), hi)
    if off == want:
        return off, 0, None
    return off, off - want, ("tile" if off == 0 or off + size >= n else "block")


def place_window(grid: Grid, lon: float, lat: float, size: int = CUBE_SIZE) -> Placement:
    (x,), (y,) = rw_transform("EPSG:4326", grid.crs, [lon], [lat])
    row, col = (int(v) for v in rowcol(grid.transform, x, y))
    if not (0 <= row < grid.height and 0 <= col < grid.width):
        raise OutsideTile(f"point ({lon}, {lat}) is outside the tile")
    col_off, dcol, rc = _axis(col, grid.width, grid.block_w, size)
    row_off, drow, rr = _axis(row, grid.height, grid.block_h, size)
    reason = "tile" if "tile" in (rc, rr) else (rc or rr)
    return Placement(
        row=row, col=col, row_off=row_off, col_off=col_off, size=size,
        shift_east_m=float(dcol * grid.transform.a) + 0.0,
        # Rows grow southwards: a window moved down (drow > 0) moved south.
        shift_north_m=float(drow * grid.transform.e) + 0.0,
        shift_reason=reason,
    )


# ---------------------------------------------------------------- read ----

_cache: "OrderedDict[Hashable, Stack]" = OrderedDict()
_inflight: dict = {}
_lock = threading.Lock()


def _is_not_found(ex: Exception) -> bool:
    msg = str(ex)
    return "404" in msg or "No such file" in msg or "does not exist" in msg


# Attempts per RH level. GDAL retries HTTP errors itself (GDAL_HTTP_RETRY_*),
# but a stalled request cut off by GDAL_HTTP_TIMEOUT, or a failed range request
# for the tile index ("Cannot read offset/size for strile", 2026-10-29, 32UMB),
# surfaces as a TIFF error, which it does not retry. These failures are random:
# the same blocks read fine a moment later.
_READ_ATTEMPTS = 3

# GDAL keeps the partial tile of a failed read in its /vsicurl/ cache, so every
# later read of that URL in this process fails instantly without touching the
# network (measured 2026-10-29: "got 70451 bytes, expected …" in 0.0 s).
# gdal_cache.clear drops that; if libgdal could not be found for it, the URL is
# read under a new query string from then on instead (also verified to work).
_url_gen: dict = {}


def _fresh(path: str) -> str:
    g = _url_gen.get(path, 0)
    if not g or not path.startswith(("http://", "https://")):
        return path
    return f"{path}{'&' if '?' in path else '?'}gdal_retry={g}"


def _poisoned(path: str) -> None:
    if gdal_cache.clear(path):
        return
    if path.startswith(("http://", "https://")):
        with _lock:
            _url_gen[path] = _url_gen.get(path, 0) + 1


def _root_cause(ex: BaseException) -> str:
    """rasterio wraps the GDAL message as "Read failed. See previous exception"."""
    while (ex.__cause__ or ex.__context__) is not None:
        ex = ex.__cause__ or ex.__context__
    return str(ex)


def _read_level(path: Optional[str], win: Window, local: bool) -> Tuple[str, Optional[np.ndarray]]:
    if not path or (local and not os.path.isfile(path)):
        return "missing", None
    for attempt in range(_READ_ATTEMPTS):
        status, a, err = _read_level_once(_fresh(path), win)
        if status != "failed":
            return status, a
        _poisoned(path)
        if attempt + 1 < _READ_ATTEMPTS:
            time.sleep(0.5 * (attempt + 1))
    print(f"[cube-window] read error for {path[:100]} after {_READ_ATTEMPTS} attempts: {err}")
    return "failed", None


def _read_level_once(path: str, win: Window) -> Tuple[str, Optional[np.ndarray], str]:
    try:
        with rasterio.open(path) as src:
            a = src.read(1, window=win)
            nd = src.nodata
        a = a.astype(np.int16, copy=False)
        bad = a == -9999
        if nd is not None and nd != NODATA and -32768 <= nd <= 32767:
            bad |= a == int(nd)
        if bad.any():
            a = np.where(bad, np.int16(NODATA), a)
        return "ok", a, ""
    except Exception as ex:
        if _is_not_found(ex):
            return "missing", None, ""
        return "failed", None, _root_cause(ex)


def _read_stack(paths: Sequence[Optional[str]], p: Placement, local: bool, workers: int) -> Stack:
    win = Window(p.col_off, p.row_off, p.size, p.size)
    data = np.full((N_LEVELS, p.size, p.size), NODATA, np.int16)
    stack = Stack(data)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = pool.map(lambda rh: (rh, *_read_level(paths[rh], win, local)), range(N_LEVELS))
        for rh, status, a in results:
            if status == "ok":
                data[rh] = a
            elif status == "missing":
                stack.missing.append(rh)
            else:
                stack.failed.append(rh)
    return stack


def read_around(
    key: Hashable,
    paths: Sequence[Optional[str]],
    lon: float,
    lat: float,
    local: bool,
    workers: int,
    size: int = CUBE_SIZE,
) -> Tuple[Grid, Placement, Stack]:
    """Window around (lon, lat), cached. Concurrent calls for the same window
    (the profile and the cube request of one click) share a single read."""
    grid = tile_grid(key, paths)
    p = place_window(grid, lon, lat, size)
    wkey = (key, p.row_off, p.col_off, size)

    with _lock:
        hit = _cache.get(wkey)
        if hit is not None:
            _cache.move_to_end(wkey)
            return grid, p, hit
        fut = _inflight.get(wkey)
        owner = fut is None
        if owner:
            fut = _inflight[wkey] = Future()

    if not owner:
        return grid, p, fut.result()

    try:
        stack = _read_stack(paths, p, local, workers)
    except BaseException as ex:
        with _lock:
            _inflight.pop(wkey, None)
        fut.set_exception(ex)
        raise
    with _lock:
        _inflight.pop(wkey, None)
        # A level that failed to read may succeed next time: don't pin the gap.
        if not stack.failed:
            _cache[wkey] = stack
            while len(_cache) > _CACHE_ENTRIES:
                _cache.popitem(last=False)
    fut.set_result(stack)
    return grid, p, stack


# -------------------------------------------------------------- encode ----


def _fill_single_gaps(data: np.ndarray, gaps: Sequence[int]) -> Tuple[np.ndarray, List[int]]:
    """RH is monotonic in the percentile, so a single absent level (e.g.
    2020/50NNM has no RH78) is the mean of its neighbours. Wider gaps stay
    nodata."""
    gapset = set(gaps)
    filled: List[int] = []
    out = data
    for rh in sorted(gapset):
        if rh <= 1 or rh >= N_LEVELS - 1 or (rh - 1) in gapset or (rh + 1) in gapset:
            continue
        lo, hi = data[rh - 1].astype(np.int32), data[rh + 1].astype(np.int32)
        ok = (lo != NODATA) & (hi != NODATA)
        if out is data:
            out = data.copy()
        out[rh] = np.where(ok, (lo + hi) // 2, NODATA).astype(np.int16)
        filled.append(rh)
    return out, filled


def encode_cube(grid: Grid, p: Placement, stack: Stack, meta: dict) -> bytes:
    """gzip( "VSMC" | uint32 LE header length | JSON header | pad to 8 | int16 LE data ).

    Data layout [rh][row][col], RH0..RH100, row 0 = north edge, decimetres,
    nodata 32767."""
    gaps = sorted(set(stack.missing) | set(stack.failed))
    data, filled = _fill_single_gaps(stack.data, gaps)

    win = Window(p.col_off, p.row_off, p.size, p.size)
    left, bottom, right, top = window_bounds(win, grid.transform)
    xs, ys = [left, right, right, left], [top, top, bottom, bottom]
    lons, lats = rw_transform(grid.crs, "EPSG:4326", xs, ys)
    header = {
        **meta,
        "size": p.size,
        "rh_first": 0,
        "rh_last": N_LEVELS - 1,
        "nodata": NODATA,
        "scale": 0.1,
        "layout": "[rh][row][col] int16 LE, decimetres, row 0 = north",
        "crs": grid.crs,
        "res_m": [grid.transform.a, -grid.transform.e],
        "bounds": [left, bottom, right, top],
        # NW, NE, SE, SW corners, for drawing the window on the map.
        "footprint": [[lo, la] for lo, la in zip(lons, lats)],
        "window": {"row_off": p.row_off, "col_off": p.col_off},
        "click": {"row": p.row - p.row_off, "col": p.col - p.col_off},
        "shift": {
            "east_m": p.shift_east_m,
            "north_m": p.shift_north_m,
            "reason": p.shift_reason,
            "block_px": [grid.block_w, grid.block_h],
        },
        "missing_rh": stack.missing,
        "failed_rh": stack.failed,
        "interpolated_rh": filled,
    }
    hb = json.dumps(header, separators=(",", ":")).encode()
    pad = (-(8 + len(hb))) % 8
    body = b"VSMC" + struct.pack("<I", len(hb) + pad) + hb + b" " * pad + data.astype("<i2").tobytes()
    return gzip.compress(body, compresslevel=5)
