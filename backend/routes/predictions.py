"""Prediction loading, mosaic URL, vertical-profile, and COG info endpoints."""

from fastapi import APIRouter
from pydantic import BaseModel, Field
from typing import Dict, Optional, Union, List, Tuple
from urllib.parse import quote
import asyncio
import os
import re
import requests

import mgrs as mgrs_lib
import rasterio
from rasterio.warp import transform as rw_transform

from utils import MAX_HEIGHT, pixel_vertical_profile_and_metrics, pixel_diversity_indices
import math

router = APIRouter(tags=["predictions"])

# ---------------------------------------------------------------------------
# Module-level env vars (read at import time; same as before)
# ---------------------------------------------------------------------------

PREDICTIONS_LOCAL_BASE_PATH = os.environ.get("PREDICTIONS_LOCAL_BASE_PATH", "")
PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH = os.environ.get("PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH", "")
PREDICTIONS_LOCAL_PATH_TEMPLATE = os.environ.get("PREDICTIONS_LOCAL_PATH_TEMPLATE", "{tile}/RH{rh}_Q{q}.tif")
PREDICTIONS_BASE_URL = os.environ.get("PREDICTIONS_BASE_URL", "")
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
    try:
        if not lon_lat_points:
            return []
        with rasterio.open(path_or_url) as src:
            lons = [float(p[0]) for p in lon_lat_points]
            lats = [float(p[1]) for p in lon_lat_points]
            xs, ys = rw_transform("EPSG:4326", src.crs, lons, lats)
            xy_points = list(zip(xs, ys))
            samples = src.sample(xy_points)
            out: List[Optional[float]] = []
            for arr in samples:
                v = arr[0] if len(arr) else None
                if v is None:
                    out.append(None)
                    continue
                if src.nodata is not None and v == src.nodata:
                    out.append(None)
                    continue
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    out.append(None)
                    continue
                if fv in (32767.0, 32768.0, -9999.0):
                    out.append(None)
                    continue
                out.append(fv)
            return out
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


def _build_profile_paths(year: int, source: str, q_index: int, tile_name: str):
    zone = tile_name[:3].lower() if len(tile_name) >= 3 else tile_name.lower()
    fmt_base = dict(zone=zone, year=year, tile=tile_name, q=q_index)

    if year == 2020:
        local_base = PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH if source == "original" else PREDICTIONS_LOCAL_BASE_PATH
        if not local_base:
            return None, None, fmt_base, "PREDICTIONS_LOCAL_BASE_PATH not set."
        return local_base, PREDICTIONS_LOCAL_PATH_TEMPLATE, fmt_base, None

    if not PREDICTIONS_BASE_URL:
        return None, None, fmt_base, "PREDICTIONS_BASE_URL not set."
    return None, None, fmt_base, None


def _path_for_rh(year: int, local_base: Optional[str], local_tpl: Optional[str], fmt_base: Dict[str, Union[str, int]], rh: int) -> Optional[str]:
    fmt_rh = {**fmt_base, "rh": rh}
    if year == 2020:
        if not local_base or not local_tpl:
            return None
        try:
            rel = local_tpl.format(**fmt_rh)
        except Exception:
            return None
        return os.path.join(local_base, rel)
    try:
        rel = PREDICTIONS_REMOTE_PATH_TEMPLATE.format(**fmt_rh)
    except Exception:
        return None
    return PREDICTIONS_BASE_URL.rstrip("/") + "/" + rel.lstrip("/")


def _compute_profile_at_point(
    lon: float,
    lat: float,
    year: int,
    source: str,
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

    local_base, local_tpl, fmt_base, setup_error = _build_profile_paths(year, source, q_index, tile)
    if setup_error:
        return {"success": False, "error": setup_error, "tile_name": tile}

    from concurrent.futures import ThreadPoolExecutor, as_completed

    def work(rh: int):
        p = _path_for_rh(year, local_base, local_tpl, fmt_base, rh)
        if not p:
            return rh, None, True
        if year == 2020 and not os.path.isfile(p):
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
    vertical_profile, fhd, enl1d, enl2d, cr = _derive_profile_and_metrics(valid_vals, height_bin_m=fhd_interval)
    vertical_profile_curve = [
        {"z": z, "value": v}
        for z, v in enumerate(vertical_profile)
        if v is not None
    ]
    return {
        "success": True,
        "tile_name": tile,
        "year": year,
        "q_index": q_index,
        "source": source,
        "lon": lon,
        "lat": lat,
        "profile": profile,
        "vertical_profile_curve": vertical_profile_curve,
        "fhd": fhd,
        "enl1d": enl1d,
        "enl2d": enl2d,
        "cr": cr,
        "missing_file_count": missing_files,
        "max_height": MAX_HEIGHT,
        "fhd_interval": fhd_interval,
    }


def _derive_profile_and_metrics(valid_vals: List[float], height_bin_m: int = 5, max_height: int = MAX_HEIGHT):

    def _safe_scalar(v: float):
        return None if (math.isnan(v) or math.isinf(v)) else v

    hb = max(1, min(int(height_bin_m), int(max_height)))
    # Always return a fixed profile shape derived from configured MAX_HEIGHT.
    # even when there are not enough valid samples or metrics computation fails.
    n_bins = max(1, int(max_height / hb))
    vertical_profile: List[Optional[float]] = [None] * n_bins
    fhd, enl1d, enl2d, cr = None, None, None, None
    if len(valid_vals) >= 3:
        try:
            vertical_profile, raw_fhd, raw_enl1d, raw_enl2d, raw_cr = pixel_vertical_profile_and_metrics(
                valid_vals,
                interval=hb,
                max_height=max_height,
            )
            vertical_profile = vertical_profile.tolist()
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
    source: str = "blended"


class VerticalProfileRequest(BaseModel):
    lon: float
    lat: float
    year: int = 2020
    source: str = "blended"
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
    source: str = "blended"
    q_index: int = 1
    sample_count: Optional[int] = None
    fhd_interval: int = Field(default=5, ge=1, le=50)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/predictions/mosaic-url")
async def get_mosaic_url(year: int, rh_index: int = 98, q_index: Union[int, str] = 1):
    fmt = dict(year=year, rh=rh_index, q=q_index)

    if year == 2020:
        template = os.environ.get("PREDICTIONS_MOSAIC_LOCAL_PATH", "")
        if not template:
            return {"success": False, "error": "PREDICTIONS_MOSAIC_LOCAL_PATH env var is not set"}
        try:
            path = template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_MOSAIC_LOCAL_PATH: {e}"}
        if not os.path.isfile(path):
            return {"success": False, "error": f"Mosaic file not found: {path}"}
        return {"success": True, "url": path, "year": year, "source": "local"}
    else:
        template = os.environ.get("PREDICTIONS_MOSAIC_REMOTE_URL", "")
        if not template:
            return {"success": False, "error": "PREDICTIONS_MOSAIC_REMOTE_URL env var is not set"}
        try:
            url = template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_MOSAIC_REMOTE_URL: {e}"}
        return {"success": True, "url": url, "year": year, "source": "remote"}


@router.post("/predictions/load")
async def load_predictions(request: PredictionsRequest):
    zone = request.tile_name[:3].lower()
    fmt = dict(zone=zone, year=request.year, tile=request.tile_name, rh=request.rh_index, q=request.q_index)

    if request.year == 2020:
        local_base = PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH if request.source == "original" else PREDICTIONS_LOCAL_BASE_PATH
        if not local_base:
            return {"success": False, "error": "PREDICTIONS_LOCAL_BASE_PATH env var is not set."}
        try:
            local_rel = PREDICTIONS_LOCAL_PATH_TEMPLATE.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid template: {e}"}
        local_path = os.path.join(local_base, local_rel)
        if os.path.isfile(local_path):
            return {"success": True, "url": local_path, "tile_name": request.tile_name, "rh_index": request.rh_index, "q_index": request.q_index, "year": request.year, "source": "local"}
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
            return {"success": True, "url": cog_url, "tile_name": request.tile_name, "rh_index": request.rh_index, "q_index": request.q_index, "year": request.year, "source": "remote"}
        except Exception as e:
            return {"success": False, "error": str(e), "url": cog_url}


@router.options("/predictions/load")
async def predictions_load_options():
    return {"message": "OK"}


@router.post("/predictions/vertical-profile")
async def predictions_vertical_profile(request: VerticalProfileRequest):
    return await asyncio.to_thread(
        _compute_profile_at_point,
        request.lon,
        request.lat,
        request.year,
        request.source,
        request.q_index,
        request.tile_name,
        VERTICAL_PROFILE_WORKERS,
        request.fhd_interval,
    )


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
            local_base, local_tpl, fmt_base, setup_error = _build_profile_paths(
                request.year, request.source, request.q_index, tile_name
            )
            if setup_error:
                return {"success": False, "error": setup_error, "tile_name": tile_name}

            tile_points = [(out[i]["lon"], out[i]["lat"]) for i in indices]

            def work_rh(rh: int):
                p = _path_for_rh(request.year, local_base, local_tpl, fmt_base, rh)
                if not p:
                    return rh, [None] * len(tile_points), True
                if request.year == 2020 and not os.path.isfile(p):
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
            "source": request.source,
            "q_index": request.q_index,
            "sample_count": len(sampled_points),
            "total_length_m": total_length_m,
            "line_coordinates": [(float(lon), float(lat)) for lon, lat in coords],
            "rh_profile": rh_profile,
            "vertical_profile": vertical_profile,
            "samples": out,
            "max_height": MAX_HEIGHT,
            "fhd_interval": request.fhd_interval,
        }

    return await asyncio.to_thread(compute_line_profiles)


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
