"""Prediction loading, mosaic URL, vertical-profile, and COG info endpoints."""

from fastapi import APIRouter
from pydantic import BaseModel, Field
from typing import Dict, Optional, Union, List, Tuple
from urllib.parse import quote
import asyncio
import os
import re
import traceback
import requests
from typing import Literal

# Allowed values for the prediction `version` parameter. Only year==2020
# has on-disk versioned outputs ('original' is the raw model output,
# 'blended' fills cross-tile seams, 'masked' applies the no-veg mask).
VersionLiteral = Literal["original", "blended", "masked"]

import mgrs as mgrs_lib
import numpy as np
import rasterio
from rasterio.warp import transform as rw_transform

from utils import (
    HEATMAP_MAX_HEIGHT,
    MAX_HEIGHT_METERS,
    profile_curve_points,
    profile_y_bounds,
    pixel_vertical_profile,
    pixel_diversity_indices,
)
import math

router = APIRouter(tags=["predictions"])


def _to_jsonable(v):
    """Recursively convert numpy scalars/arrays + NaN/Inf to JSON-safe Python
    primitives. FastAPI's jsonable_encoder doesn't handle numpy types and fails
    with a useless "[TypeError(...'numpy.int64' is not iterable'...)]" 500.
    Apply this to any dict returned from a route that touches numpy.
    """
    if isinstance(v, dict):
        return {k: _to_jsonable(val) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        return [_to_jsonable(x) for x in v]
    if isinstance(v, np.ndarray):
        return _to_jsonable(v.tolist())
    if isinstance(v, np.generic):
        # numpy scalar — .item() returns the underlying Python primitive
        py = v.item()
        if isinstance(py, float) and (math.isnan(py) or math.isinf(py)):
            return None
        return py
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v

# ---------------------------------------------------------------------------
# Module-level env vars (read at import time; same as before)
# ---------------------------------------------------------------------------

# Unified local path template: full absolute path with {version}, {tile}, {rh}, {q}
# placeholders. Replaces the old split PREDICTIONS_LOCAL_BASE_PATH +
# PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH + PREDICTIONS_LOCAL_PATH_TEMPLATE trio.
PREDICTIONS_LOCAL_PATH = os.environ.get("PREDICTIONS_LOCAL_PATH", "")
PREDICTIONS_BASE_URL = os.environ.get("PREDICTIONS_BASE_URL", "")

# Years served from local disk; every other year is fetched over HTTP from
# PREDICTIONS_BASE_URL. Purely declarative — the source is decided by config,
# never by probing the filesystem, so the same code behaves identically on the
# internal host and on a public deployment.
#
#   internal (hendrix/lumi): PREDICTIONS_LOCAL_YEARS=2020
#   public deployment      : leave unset — everything comes from source.coop
def _parse_local_years(raw: str) -> frozenset[int]:
    out = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.add(int(part))
        except ValueError:
            print(f"[predictions] ignoring non-integer PREDICTIONS_LOCAL_YEARS entry: {part!r}")
    return frozenset(out)


PREDICTIONS_LOCAL_YEARS = _parse_local_years(os.environ.get("PREDICTIONS_LOCAL_YEARS", ""))
print(f"[predictions] local years: {sorted(PREDICTIONS_LOCAL_YEARS) or 'none (all remote)'}")
PREDICTIONS_REMOTE_PATH_TEMPLATE = os.environ.get("PREDICTIONS_REMOTE_PATH_TEMPLATE", "{zone}-{year}/{tile}/RH{rh}_Q{q}.tif")
VERTICAL_PROFILE_WORKERS = max(4, min(48, int(os.environ.get("VERTICAL_PROFILE_WORKERS", "28"))))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mgrs_tile_from_latlon(lat: float, lon: float) -> Optional[str]:
    try:
        g = mgrs_lib.MGRS().toMGRS(lat, lon).replace(" ", "").upper()
        m = re.match(r"^(\d{1,2})([CDEFGHJKLMNPQRSTUVWX])([ABCDEFGHJKLMNPQRSTUVWXYZ]{2})", g)
        if m:
            return f"{int(m.group(1)):02d}{m.group(2)}{m.group(3)}"
        m = re.match(r"^(\d{3})([CDEFGHJKLMNPQRSTUVWX])([ABCDEFGHJKLMNPQRSTUVWXYZ]{2})", g)
        if m:
            return f"{m.group(1)}{m.group(2)}{m.group(3)}"
    except Exception as e:
        print(f"[vertical-profile] MGRS error: {e}")
    return None


def _sample_rh_geotiff(path_or_url: str, lon: float, lat: float) -> Optional[float]:
    vals = _sample_rh_geotiff_many(path_or_url, [(lon, lat)])
    return vals[0] if vals else None


def _sample_rh_geotiff_many(path_or_url: str, lon_lat_points: List[Tuple[float, float]]) -> List[Optional[float]]:
    if not lon_lat_points:
        return []
    try:
        with rasterio.open(path_or_url) as src:
            lons = [float(p[0]) for p in lon_lat_points]
            lats = [float(p[1]) for p in lon_lat_points]
            xs, ys = rw_transform("EPSG:4326", src.crs, lons, lats)
            nodata = src.nodata
            # VSM RH tiles are always single-band int16, one sample per point.
            arr = np.fromiter(
                (s[0] if len(s) else np.nan for s in src.sample(list(zip(xs, ys)))),
                dtype=np.float64,
                count=len(lon_lat_points),
            )
        bad = ~np.isfinite(arr)
        if nodata is not None:
            bad |= arr == nodata
        bad |= np.isin(arr, (32767.0, 32768.0, -9999.0))
        return [None if b else float(v) for b, v in zip(bad.tolist(), arr.tolist())]
    except Exception as ex:
        print(f"[vertical-profile] sample error for {path_or_url[:80]}…: {ex}")
        return [None for _ in lon_lat_points]


def _haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2.0) ** 2
    )
    return 2.0 * r * math.asin(math.sqrt(max(0.0, min(1.0, a))))


TRANSECT_SAMPLE_STEP_M = 10.0
MAX_TRANSECT_SAMPLES = 1024


def _sample_points_along_line(line_coordinates: List[Tuple[float, float]]) -> Tuple[List[Tuple[float, float, float]], float]:
    coords = [(float(lon), float(lat)) for lon, lat in line_coordinates]
    if len(coords) < 2:
        return [], 0.0

    seg_lengths: List[float] = []
    total = 0.0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        seg = _haversine_m(lon1, lat1, lon2, lat2)
        seg_lengths.append(seg)
        total += seg

    if total <= 0:
        lon, lat = coords[0]
        return [(lon, lat, 0.0)], 0.0

    # Extract many real sample points along the drawn line at fixed spacing.
    # Values are sampled from raster at these coordinates (no fake interpolation of values).
    step_m = max(1.0, TRANSECT_SAMPLE_STEP_M)
    n_points = int(math.floor(total / step_m)) + 1
    n_points = max(2, min(MAX_TRANSECT_SAMPLES, n_points))
    targets = [total * i / (n_points - 1) for i in range(n_points)]

    out: List[Tuple[float, float, float]] = []
    seg_idx = 0
    seg_start_dist = 0.0
    for t in targets:
        while seg_idx < len(seg_lengths) - 1 and seg_start_dist + seg_lengths[seg_idx] < t:
            seg_start_dist += seg_lengths[seg_idx]
            seg_idx += 1
        seg_len = seg_lengths[seg_idx]
        lon1, lat1 = coords[seg_idx]
        lon2, lat2 = coords[seg_idx + 1]
        frac = 0.0 if seg_len <= 0 else (t - seg_start_dist) / seg_len
        frac = max(0.0, min(1.0, frac))
        lon = lon1 + (lon2 - lon1) * frac
        lat = lat1 + (lat2 - lat1) * frac
        out.append((lon, lat, t))
    return out, total


def _build_profile_paths(year: int, version: str, q_index: int, tile_name: str):
    zone = tile_name[:3].lower() if len(tile_name) >= 3 else tile_name.lower()
    fmt_base = dict(zone=zone, year=year, tile=tile_name, q=q_index, version=version)

    if year in PREDICTIONS_LOCAL_YEARS:
        if not PREDICTIONS_LOCAL_PATH:
            return None, fmt_base, "PREDICTIONS_LOCAL_PATH not set."
        return PREDICTIONS_LOCAL_PATH, fmt_base, None

    if not PREDICTIONS_BASE_URL:
        return None, fmt_base, "PREDICTIONS_BASE_URL not set."
    return None, fmt_base, None


def _path_for_rh(year: int, local_tpl: Optional[str], fmt_base: Dict[str, Union[str, int]], rh: int) -> Optional[str]:
    fmt_rh = {**fmt_base, "rh": rh}
    if year in PREDICTIONS_LOCAL_YEARS:
        if not local_tpl:
            return None
        try:
            return local_tpl.format(**fmt_rh)
        except Exception:
            return None
    try:
        rel = PREDICTIONS_REMOTE_PATH_TEMPLATE.format(**fmt_rh)
    except Exception:
        return None
    return PREDICTIONS_BASE_URL.rstrip("/") + "/" + rel.lstrip("/")


def _compute_profile_at_point(
    lon: float,
    lat: float,
    year: int,
    version: str,
    q_index: int,
    tile_name: Optional[str] = None,
    max_workers: int = VERTICAL_PROFILE_WORKERS,
    fhd_interval: int = 5,
):
    tile = (tile_name or "").strip().upper() or None
    if not tile:
        tile = _mgrs_tile_from_latlon(lat, lon)
    if not tile:
        return {"success": False, "error": "Could not determine MGRS tile."}

    local_tpl, fmt_base, setup_error = _build_profile_paths(year, version, q_index, tile)
    if setup_error:
        return {"success": False, "error": setup_error, "tile_name": tile}

    from concurrent.futures import ThreadPoolExecutor, as_completed

    def work(rh: int):
        p = _path_for_rh(year, local_tpl, fmt_base, rh)
        if not p:
            return rh, None, True
        if year in PREDICTIONS_LOCAL_YEARS and not os.path.isfile(p):
            return rh, None, True
        return rh, _sample_rh_geotiff(p, lon, lat), False

    rh_results: Dict[int, tuple] = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(work, rh) for rh in range(0, 101)]
        for fut in as_completed(futures):
            rh, val, missing = fut.result()
            rh_results[rh] = (val, missing)

    profile, missing_files = [], 0
    for rh in range(0, 101):
        val, file_missing = rh_results[rh]
        if file_missing:
            profile.append({"rh": rh, "value": None, "missing": True})
            missing_files += 1
        else:
            profile.append({"rh": rh, "value": val / 10.0 if val is not None else None, "missing": False})

    valid_vals = [p["value"] for p in profile if p["value"] is not None and not p["missing"]]

    def _safe_scalar(v):
        try:
            fv = float(v)
        except (TypeError, ValueError):
            return None
        return None if (math.isnan(fv) or math.isinf(fv)) else fv

    vertical_profile_curve: List[Dict[str, float]] = []
    profile_y_min, profile_y_max = profile_y_bounds()
    fhd = enl1d = enl2d = cr = None
    if len(valid_vals) >= 3:
        try:
            # Smoothed Savitzky-Golay envelope + raw binned energy %, already
            # trimmed to the real data extent (utils.profile_curve_points).
            # The client fixes the y-axis to [profile_y_min, profile_y_max]
            # so points stay visually comparable; the curve itself only
            # spans real data (no flat-line tail across the fixed axis).
            vertical_profile_curve = profile_curve_points(valid_vals)
        except (TypeError, AttributeError, NameError):
            # Signature / programming mismatch (e.g. wrong kwargs) — fail loudly
            # with a 500 instead of silently returning an empty curve, which
            # only manifests as a missing plot in the UI.
            raise
        except Exception as e:
            print(
                f"[vertical-profile] profile_curve_points failed; curve omitted: "
                f"{e}\n{traceback.format_exc()}"
            )
        try:
            raw_fhd, raw_enl1d, raw_enl2d, raw_cr = pixel_diversity_indices(
                valid_vals, bin_width=fhd_interval, max_height=MAX_HEIGHT_METERS
            )
            fhd = _safe_scalar(raw_fhd)
            enl1d = _safe_scalar(raw_enl1d)
            enl2d = _safe_scalar(raw_enl2d)
            cr = _safe_scalar(raw_cr)
        except Exception as e:
            print(f"[vertical-profile] pixel_diversity_indices error: {e}")

    return {
        "success": True,
        "tile_name": tile,
        "year": year,
        "q_index": q_index,
        "version": version,
        "lon": lon,
        "lat": lat,
        "profile": profile,
        "vertical_profile_curve": vertical_profile_curve,
        "profile_y_min": profile_y_min,
        "profile_y_max": profile_y_max,
        "fhd": fhd,
        "enl1d": enl1d,
        "enl2d": enl2d,
        "cr": cr,
        "missing_file_count": missing_files,
        "max_height": MAX_HEIGHT_METERS,
        "heatmap_max_height": HEATMAP_MAX_HEIGHT,
        "fhd_interval": fhd_interval,
    }


def _derive_profile_and_metrics(valid_vals: List[float], height_bin_m: int = 5, max_height: int = MAX_HEIGHT_METERS):

    def _safe_scalar(v: float):
        return None if (math.isnan(v) or math.isinf(v)) else v

    hb = max(1, min(int(height_bin_m), int(max_height)))
    # Always return a fixed profile shape derived from configured MAX_HEIGHT.
    # even when there are not enough valid samples or metrics computation fails.
    n_bins = max(1, int(max_height / hb))
    vertical_profile: List[Optional[float]] = [None] * n_bins
    fhd, enl1d, enl2d, cr = None, None, None, None
    if len(valid_vals) >= 3:
        # Convert the histogram first and unconditionally — diversity-metrics
        # failures (e.g. IndexError on sparse profiles) must not strand
        # `vertical_profile` as a numpy array nor wipe out the profile shape.
        try:
            vp = pixel_vertical_profile(valid_vals)
            vertical_profile = vp.tolist() if hasattr(vp, "tolist") else list(vp)
        except Exception as e:
            print(f"[vertical-profile] pixel_vertical_profile error: {e}")
        try:
            raw_fhd, raw_enl1d, raw_enl2d, raw_cr = pixel_diversity_indices(valid_vals, bin_width=hb, max_height=max_height)
            fhd = _safe_scalar(float(raw_fhd))
            enl1d = _safe_scalar(float(raw_enl1d))
            enl2d = _safe_scalar(float(raw_enl2d))
            cr = _safe_scalar(float(raw_cr))
        except Exception as e:
            print(f"[vertical-profile] pixel_diversity_indices error: {e}")
    return vertical_profile, fhd, enl1d, enl2d, cr


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class PredictionsRequest(BaseModel):
    year: int
    tile_name: str
    rh_index: int
    q_index: Union[int, str]
    version: VersionLiteral = "original"


class VerticalProfileRequest(BaseModel):
    lon: float
    lat: float
    year: int = 2020
    version: VersionLiteral = "original"
    q_index: int = 1
    tile_name: Optional[str] = None
    fhd_interval: int = Field(
        default=5,
        ge=1,
        le=10,
        description="Histogram bin width (m) for RH height; same as GEDI / auxiliary point-profile.",
    )


class VerticalProfileLineRequest(BaseModel):
    line_coordinates: List[Tuple[float, float]]
    year: int = 2020
    version: VersionLiteral = "original"
    q_index: int = 1
    sample_count: Optional[int] = None
    fhd_interval: int = Field(default=5, ge=1, le=50)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/predictions/mosaic-url")
async def get_mosaic_url(
    year: int,
    rh_index: int = 98,
    q_index: Union[int, str] = 1,
    version: VersionLiteral = "original",
):
    fmt = dict(year=year, rh=rh_index, q=q_index, version=version)

    if year in PREDICTIONS_LOCAL_YEARS:
        template = os.environ.get("PREDICTIONS_MOSAIC_LOCAL_PATH", "")
        if not template:
            return {"success": False, "error": "PREDICTIONS_MOSAIC_LOCAL_PATH env var is not set"}
        try:
            path = template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_MOSAIC_LOCAL_PATH: {e}"}
        if not os.path.isfile(path):
            return {"success": False, "error": f"Mosaic file not found: {path}"}
        return {"success": True, "url": path, "year": year, "version": version, "location": "local"}
    else:
        template = os.environ.get("PREDICTIONS_MOSAIC_REMOTE_URL", "")
        if not template:
            return {"success": False, "error": "PREDICTIONS_MOSAIC_REMOTE_URL env var is not set"}
        try:
            url = template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_MOSAIC_REMOTE_URL: {e}"}

        # Confirm the object exists, the same way /predictions/load does.
        # The published mosaics only cover Q1, so a request for Q0/Q2 (or for
        # either half of an interval) formats a URL that 404s. Returning
        # success=True for it would hand the frontend a layer that renders as
        # silent blank tiles; the caller checks `success`, so failing here makes
        # the gap visible instead.
        try:
            resp = requests.head(url, timeout=10)
            resp.raise_for_status()
        except Exception as e:
            return {"success": False, "error": f"Mosaic not available: {e}", "url": url}

        return {"success": True, "url": url, "year": year, "location": "remote"}


@router.get("/predictions/download-info")
async def get_download_info():
    """Where the published COGs live, so the frontend can build download links.

    The explore page offers direct downloads from the object store rather than
    proxying bytes: source.coop serves the COGs with ``Access-Control-Allow-
    Origin: *`` and range support, so a browser can fetch them itself. A proxy
    would put 100-170 MB per file through this process for no gain.

    Which means the frontend needs the base URL and the path layout — and those
    are configuration, known only here. Hardcoding them in the bundle would put
    the same fact in two places that are deployed separately; that is exactly
    how PREDICTIONS_MOSAIC_REMOTE_URL went missing once already.

    ``available`` is false when this deployment serves predictions from local
    disk, which has no public URL to hand out. The caller hides its download
    controls instead of offering links into a filesystem nobody else can reach.
    """
    base = PREDICTIONS_BASE_URL.rstrip("/")
    mosaic = os.environ.get("PREDICTIONS_MOSAIC_REMOTE_URL", "")

    return {
        # Templates carry {year}/{tile}/{rh}/{q} placeholders, filled in by the
        # caller. Returned as templates rather than as a list of URLs because
        # the set of interesting files is a property of the map view, not of
        # the server: the visible MGRS tiles change on every pan.
        "available": bool(base),
        "base_url": base,
        "tile_url_template": f"{base}/{PREDICTIONS_REMOTE_PATH_TEMPLATE.lstrip('/')}" if base else "",
        "mosaic_url_template": mosaic,
        # Only Q1 is published. The caller has no quantile control, but the
        # templates have a {q} hole, so say which value belongs in it rather
        # than leaving the frontend to assume.
        "q_index": 1,
        # Every RH level from 0 to 100 exists, for the mosaics and for each
        # tile. The map only offers seven — the ones worth *looking* at — but a
        # download has no such reason to choose, so the panel lists all of them.
        # Overridable because a future year may be published incrementally.
        "rh_min": int(os.environ.get("PREDICTIONS_RH_MIN", "0")),
        "rh_max": int(os.environ.get("PREDICTIONS_RH_MAX", "100")),
        # Where a reader goes for the dataset as a whole: the repository page,
        # its README and its own bulk-download instructions.
        "repository_url": os.environ.get(
            "PREDICTIONS_REPOSITORY_URL", "https://source.coop/geoai-ucph/gvsm"
        ),
        "license": "CC-BY-4.0",
    }


@router.post("/predictions/load")
async def load_predictions(request: PredictionsRequest):
    zone = request.tile_name[:3].lower()
    fmt = dict(
        zone=zone, year=request.year, tile=request.tile_name,
        rh=request.rh_index, q=request.q_index, version=request.version,
    )

    if request.year in PREDICTIONS_LOCAL_YEARS:
        if not PREDICTIONS_LOCAL_PATH:
            return {"success": False, "error": "PREDICTIONS_LOCAL_PATH env var is not set."}
        try:
            local_path = PREDICTIONS_LOCAL_PATH.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_LOCAL_PATH template: {e}"}
        if os.path.isfile(local_path):
            return {"success": True, "url": local_path, "tile_name": request.tile_name, "rh_index": request.rh_index, "q_index": request.q_index, "year": request.year, "version": request.version, "location": "local"}
        return {"success": False, "error": f"Local file not found: {local_path}"}
    else:
        if not PREDICTIONS_BASE_URL:
            return {"success": False, "error": "PREDICTIONS_BASE_URL env var is not set."}
        try:
            remote_rel = PREDICTIONS_REMOTE_PATH_TEMPLATE.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid template: {e}"}
        cog_url = PREDICTIONS_BASE_URL.rstrip("/") + "/" + remote_rel.lstrip("/")
        try:
            resp = requests.head(cog_url, timeout=10)
            resp.raise_for_status()
            return {"success": True, "url": cog_url, "tile_name": request.tile_name, "rh_index": request.rh_index, "q_index": request.q_index, "year": request.year, "version": request.version, "location": "remote"}
        except Exception as e:
            return {"success": False, "error": str(e), "url": cog_url}


@router.options("/predictions/load")
async def predictions_load_options():
    return {"message": "OK"}


# ---------------------------------------------------------------------------
# Interval (quantile-difference) tile endpoint
# ---------------------------------------------------------------------------
# Single-Q VSM tiles live on disk (RH98_Q0.tif, RH98_Q1.tif, RH98_Q2.tif);
# intervals (95%-5%, 95%-50%, 50%-5%) are not pre-built, so we compute them
# per-tile here by subtracting two single-Q COGs on the fly.

from fastapi import Response  # noqa: E402  (kept local to avoid top-level reshuffle)
from rio_tiler.io import Reader  # noqa: E402
from rio_tiler.models import ImageData  # noqa: E402
from rio_tiler.colormap import cmap as _colormap_registry  # noqa: E402
from rio_tiler.errors import TileOutsideBounds  # noqa: E402

# Sentinel value baked into the source COGs marking "no valid prediction".
_INTERVAL_SENTINEL = 32767.0


@router.get("/predictions/interval-tile/WebMercatorQuad/{z}/{x}/{y}")
async def get_interval_tile(
    z: int, x: int, y: int,
    url_high: str,
    url_low: str,
    rescale: str = "0,500",
    colormap_name: str = "inferno",
    nodata: float = -9999.0,
):
    """Return a PNG tile of (url_high - url_low), rescaled and colormapped.

    Mirrors the parameter style of `/cog/tiles` so the frontend can swap it in
    for interval qChoices without other changes.
    """
    try:
        rmin, rmax = (float(v) for v in rescale.split(","))
    except Exception:
        rmin, rmax = 0.0, 500.0

    try:
        with Reader(url_high) as src:
            img_high = src.tile(x, y, z, nodata=nodata)
        with Reader(url_low) as src:
            img_low = src.tile(x, y, z, nodata=nodata)
    except TileOutsideBounds:
        raise

    high = np.asarray(img_high.data, dtype="float32")
    low = np.asarray(img_low.data, dtype="float32")
    # np.ma convention: True = masked (invalid). Mask if either source pixel is
    # masked, or either hits the in-band sentinel.
    invalid_2d = (
        ~img_high.mask.astype(bool)
        | ~img_low.mask.astype(bool)
        | (high[0] >= _INTERVAL_SENTINEL)
        | (low[0] >= _INTERVAL_SENTINEL)
    )
    diff = high - low
    masked_diff = np.ma.masked_array(diff, mask=np.broadcast_to(invalid_2d, diff.shape))

    out = ImageData(masked_diff, crs=img_high.crs, bounds=img_high.bounds)
    out.rescale(in_range=((rmin, rmax),))

    try:
        cm = _colormap_registry.get(colormap_name)
    except Exception:
        cm = _colormap_registry.get("inferno")

    return Response(
        content=out.render(img_format="PNG", colormap=cm),
        media_type="image/png",
    )


@router.post("/predictions/vertical-profile")
async def predictions_vertical_profile(request: VerticalProfileRequest):
    result = await asyncio.to_thread(
        _compute_profile_at_point,
        request.lon,
        request.lat,
        request.year,
        request.version,
        request.q_index,
        request.tile_name,
        VERTICAL_PROFILE_WORKERS,
        request.fhd_interval,
    )
    return _to_jsonable(result)


@router.options("/predictions/vertical-profile")
async def predictions_vertical_profile_options():
    return {"message": "OK"}


@router.post("/predictions/vertical-profile-line")
async def predictions_vertical_profile_line(request: VerticalProfileLineRequest):
    coords = request.line_coordinates or []
    if len(coords) < 2:
        return {"success": False, "error": "line_coordinates must contain at least 2 points."}

    def compute_line_profiles():
        from concurrent.futures import ThreadPoolExecutor, as_completed

        sampled_points, total_length_m = _sample_points_along_line(coords)
        # Pre-fill outputs and group sampled points by MGRS tile.
        out: List[Dict] = []
        rh_profile: List[List[Optional[float]]] = [[] for _ in range(len(sampled_points))]
        vertical_profile: List[List[Optional[float]]] = [[] for _ in range(len(sampled_points))]
        tile_to_indices: Dict[str, List[int]] = {}
        for idx, (lon, lat, distance_m) in enumerate(sampled_points):
            tile = _mgrs_tile_from_latlon(lat, lon)
            if not tile:
                return {"success": False, "error": "Could not determine MGRS tile.", "failed_index": idx}
            out.append({
                "index": idx,
                "distance_m": distance_m,
                "lon": lon,
                "lat": lat,
                "tile_name": tile,
                "vertical_profile": None,
                "fhd": None,
                "enl1d": None,
                "enl2d": None,
                "cr": None,
            })
            tile_to_indices.setdefault(tile, []).append(idx)

        workers = max(4, min(8, VERTICAL_PROFILE_WORKERS))
        for tile_name, indices in tile_to_indices.items():
            local_tpl, fmt_base, setup_error = _build_profile_paths(
                request.year, request.version, request.q_index, tile_name
            )
            if setup_error:
                return {"success": False, "error": setup_error, "tile_name": tile_name}

            tile_points = [(out[i]["lon"], out[i]["lat"]) for i in indices]

            def work_rh(rh: int):
                p = _path_for_rh(request.year, local_tpl, fmt_base, rh)
                if not p:
                    return rh, [None] * len(tile_points), True
                if request.year in PREDICTIONS_LOCAL_YEARS and not os.path.isfile(p):
                    return rh, [None] * len(tile_points), True
                vals = _sample_rh_geotiff_many(p, tile_points)
                return rh, vals, False

            rh_results: Dict[int, Tuple[List[Optional[float]], bool]] = {}
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(work_rh, rh) for rh in range(0, 101)]
                for fut in as_completed(futures):
                    rh, vals, missing = fut.result()
                    rh_results[rh] = (vals, missing)

            for local_i, global_i in enumerate(indices):
                missing_files = 0
                row_values: List[Optional[float]] = []
                for rh in range(0, 101):
                    vals, file_missing = rh_results[rh]
                    val = vals[local_i] if local_i < len(vals) else None
                    if file_missing:
                        row_values.append(None)
                        missing_files += 1
                    else:
                        row_values.append(val / 10.0 if val is not None else None)

                rh_profile[global_i] = row_values
                valid_vals = [v for v in row_values if v is not None]
                vp, fhd, enl1d, enl2d, cr = _derive_profile_and_metrics(valid_vals, height_bin_m=request.fhd_interval)
                vertical_profile[global_i] = vp
                out[global_i]["fhd"] = fhd
                out[global_i]["enl1d"] = enl1d
                out[global_i]["enl2d"] = enl2d
                out[global_i]["cr"] = cr
                out[global_i]["missing_file_count"] = missing_files

        # print(f"[vertical-profile-line] out: {out}")
        print('num samples: ', len(sampled_points), 'missing files: ', missing_files)
        valid_row_values = [v for v in row_values if v is not None]
        print('valid row values count: ', len(valid_row_values))
        return {
            "success": True,
            "year": request.year,
            "version": request.version,
            "q_index": request.q_index,
            "sample_count": len(sampled_points),
            "total_length_m": total_length_m,
            "line_coordinates": [(float(lon), float(lat)) for lon, lat in coords],
            "rh_profile": rh_profile,
            "vertical_profile": vertical_profile,
            "samples": out,
            "max_height": MAX_HEIGHT_METERS,
            "heatmap_max_height": HEATMAP_MAX_HEIGHT,
            "fhd_interval": request.fhd_interval,
        }

    result = await asyncio.to_thread(compute_line_profiles)
    return _to_jsonable(result)


@router.options("/predictions/vertical-profile-line")
async def predictions_vertical_profile_line_options():
    return {"message": "OK"}


@router.get("/predictions/info")
async def get_predictions_cog_info(tile_name: str, rh_index: int, q_index: Union[int, str]):
    base_url = os.environ.get("PREDICTIONS_BASE_URL")
    path_template = os.environ.get("PREDICTIONS_PATH_TEMPLATE", "{tile}/RH{rh}_Q{q}.tif")
    if not base_url:
        return {"success": False, "error": "PREDICTIONS_BASE_URL is not set"}
    try:
        path = path_template.format(tile=tile_name, rh=rh_index, q=q_index)
        cog_url = base_url.rstrip("/") + "/" + path.lstrip("/")
        info_url = f"http://localhost:8006/cog/info?url={quote(cog_url)}"
        resp = requests.get(info_url, timeout=30)
        resp.raise_for_status()
        return {"success": True, "url": cog_url, "info": resp.json(), "tile_name": tile_name, "rh_index": rh_index, "q_index": q_index}
    except Exception as e:
        return {"success": False, "error": str(e)}
