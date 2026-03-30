"""Prediction loading, mosaic URL, vertical-profile, and COG info endpoints."""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Dict, Optional, Union
from urllib.parse import quote
import asyncio
import os
import re
import requests

import mgrs as mgrs_lib
import rasterio
from rasterio.warp import transform as rw_transform

from utils import vertical_profile, pixel_diversity_indices
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
    try:
        with rasterio.open(path_or_url) as src:
            xs, ys = rw_transform("EPSG:4326", src.crs, [float(lon)], [float(lat)])
            try:
                vals = next(src.sample([(xs[0], ys[0])]))
            except (StopIteration, ValueError):
                return None
            v = vals[0] if len(vals) else None
            if v is None:
                return None
            if src.nodata is not None and v == src.nodata:
                return None
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return None
            if fv in (32767.0, 32768.0, -9999.0):
                return None
            return fv
    except Exception as ex:
        print(f"[vertical-profile] sample error for {path_or_url[:80]}…: {ex}")
        return None


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
    tile = (request.tile_name or "").strip().upper() or None
    if not tile:
        tile = _mgrs_tile_from_latlon(request.lat, request.lon)
    if not tile:
        return {"success": False, "error": "Could not determine MGRS tile."}

    zone = tile[:3].lower() if len(tile) >= 3 else tile.lower()
    fmt = dict(zone=zone, year=request.year, tile=tile, q=request.q_index)

    if request.year == 2020:
        local_base = PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH if request.source == "original" else PREDICTIONS_LOCAL_BASE_PATH
        if not local_base:
            return {"success": False, "error": "PREDICTIONS_LOCAL_BASE_PATH not set.", "tile_name": tile}
        local_tpl = PREDICTIONS_LOCAL_PATH_TEMPLATE
    else:
        if not PREDICTIONS_BASE_URL:
            return {"success": False, "error": "PREDICTIONS_BASE_URL not set.", "tile_name": tile}
        local_base = None
        local_tpl = None

    def path_for_rh(rh: int) -> Optional[str]:
        fmt_rh = {**fmt, "rh": rh}
        if request.year == 2020:
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

    def compute_profile():
        from concurrent.futures import ThreadPoolExecutor, as_completed
        lon, lat = request.lon, request.lat
        y2020 = request.year == 2020

        def work(rh: int):
            p = path_for_rh(rh)
            if not p:
                return rh, None, True
            if y2020 and not os.path.isfile(p):
                return rh, None, True
            return rh, _sample_rh_geotiff(p, lon, lat), False

        rh_results: Dict[int, tuple] = {}
        with ThreadPoolExecutor(max_workers=VERTICAL_PROFILE_WORKERS) as pool:
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
                # COG pixel values are in decimeters; convert to meters
                profile.append({"rh": rh, "value": val / 10.0 if val is not None else None, "missing": False})
        return profile, missing_files

    try:
        profile, missing_files = await asyncio.to_thread(compute_profile)
    except Exception as e:
        return {"success": False, "error": str(e), "tile_name": tile}

    valid_vals = [p["value"] for p in profile if p["value"] is not None and not p["missing"]]
    vp_curve = None
    if len(valid_vals) >= 3:
        try:
            x_vals, y_vals = vertical_profile(valid_vals, min_rh=-20, max_rh=50, step=1, window=3)
            vp_curve = [{"z": float(xv), "value": float(yv)} for xv, yv in zip(x_vals.tolist(), y_vals.tolist())]
        except Exception as e:
            print(f"[vertical-profile] curve compute error: {e}")

    def _safe_scalar(v: float):
        return None if (math.isnan(v) or math.isinf(v)) else v

    fhd, enl1d, enl2d = None, None, None
    if len(valid_vals) >= 3:
        try:
            fhd, enl1d, enl2d = _safe_scalar(float(pixel_diversity_indices(valid_vals, interval=5, max_height=100)))
        except Exception as e:
            print(f"[vertical-profile] pixel_diversity_indices error: {e}")

    return {
        "success": True, "tile_name": tile, "year": request.year,
        "q_index": request.q_index, "source": request.source,
        "lon": request.lon, "lat": request.lat,
        "profile": profile, "vertical_profile_curve": vp_curve,
        "fhd": fhd, "enl1d": enl1d, "enl2d": enl2d,
        "missing_file_count": missing_files,
    }


@router.options("/predictions/vertical-profile")
async def predictions_vertical_profile_options():
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
        info_url = f"http://localhost:8000/cog/info?url={quote(cog_url)}"
        resp = requests.get(info_url, timeout=30)
        resp.raise_for_status()
        return {"success": True, "url": cog_url, "info": resp.json(), "tile_name": tile_name, "rh_index": rh_index, "q_index": q_index}
    except Exception as e:
        return {"success": False, "error": str(e)}
