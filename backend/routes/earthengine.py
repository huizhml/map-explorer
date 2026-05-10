"""Earth Engine: map tiles from user-supplied assets (server-side auth only)."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Mapping
from functools import partial
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/earthengine", tags=["earthengine"])

try:
    import ee

    _EE_IMPORT_OK = True
except ImportError:
    ee = None  # type: ignore
    _EE_IMPORT_OK = False

_ee_initialized = False


class EEVisParams(BaseModel):
    min: Optional[float] = None
    max: Optional[float] = None
    palette: Optional[list[str]] = None


class EETileUrlRequest(BaseModel):
    asset_id: str = Field(..., min_length=2, description="EE asset id, e.g. projects/JRC/TMF/v1_2025/AnnualChanges")
    asset_kind: Literal["image", "image_collection"] = "image_collection"
    reduce_collection: Literal["mosaic", "median", "first"] = "mosaic"
    band: Optional[str] = Field(None, description="Band name to select, e.g. Dec2020")
    mask_self: bool = Field(False, description="Mask out zeros / nodata using the band itself")
    vis: EEVisParams = Field(default_factory=EEVisParams)


def _credentials_path() -> Optional[str]:
    p = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get("EE_CREDENTIALS_PATH")
    if not p:
        return None
    return os.path.expanduser(p)


def ee_status_dict() -> dict[str, Any]:
    path = _credentials_path()
    return {
        "ee_import_ok": _EE_IMPORT_OK,
        "credentials_path_set": bool(path),
        "credentials_file_exists": bool(path and os.path.isfile(path)),
    }


def ensure_ee() -> None:
    global _ee_initialized
    if not _EE_IMPORT_OK or ee is None:
        raise HTTPException(
            status_code=503,
            detail="Python package earthengine-api is not installed. Add it to backend/requirements.txt and pip install.",
        )
    if _ee_initialized:
        return

    key_path = _credentials_path()
    if not key_path or not os.path.isfile(key_path):
        raise HTTPException(
            status_code=503,
            detail=(
                "Earth Engine authentication not configured. Set GOOGLE_APPLICATION_CREDENTIALS "
                "or EE_CREDENTIALS_PATH to a JSON key for a Google Cloud service account that "
                "has been registered for Earth Engine access."
            ),
        )

    try:
        with open(key_path, encoding="utf-8") as f:
            sa_info = json.load(f)
        email = sa_info.get("client_email")
        credentials = ee.ServiceAccountCredentials(email, key_path)
        ee.Initialize(credentials)
    except Exception as ex:
        raise HTTPException(status_code=503, detail=f"Earth Engine Initialize failed: {ex}") from ex

    _ee_initialized = True


def _normalize_palette(palette: Optional[list[str]]) -> Optional[list[str]]:
    if not palette:
        return None
    out: list[str] = []
    for p in palette:
        s = (p or "").strip()
        if not s:
            continue
        if not s.startswith("#"):
            s = "#" + s.lstrip("#")
        out.append(s)
    return out or None


def _build_image(req: EETileUrlRequest):
    """Sync: construct ee.Image from request (runs in thread pool)."""
    ensure_ee()
    assert ee is not None

    aid = req.asset_id.strip()

    if req.asset_kind == "image":
        img: ee.Image = ee.Image(aid)
    else:
        ic = ee.ImageCollection(aid)
        if req.reduce_collection == "first":
            img = ee.Image(ic.first())
        elif req.reduce_collection == "median":
            img = ic.median()
        else:
            img = ic.mosaic()

    if req.band:
        img = img.select(req.band)

    if req.mask_self:
        img = img.updateMask(img)

    vis_params: dict[str, Any] = {}
    vmin, vmax = req.vis.min, req.vis.max
    if vmin is not None and vmax is not None:
        vis_params["min"] = vmin
        vis_params["max"] = vmax
    elif vmin is None and vmax is None:
        vis_params["min"] = 0
        vis_params["max"] = 1
    else:
        raise HTTPException(status_code=400, detail="Provide both vis.min and vis.max, or neither (defaults to 0–1).")

    pal = _normalize_palette(req.vis.palette)
    if pal:
        vis_params["palette"] = pal

    map_result = img.getMapId(vis_params)
    return map_result


def _as_clean_str(value: Any) -> Optional[str]:
    """Coerce EE RPC scalars (including bytes) to a non-empty string or None."""
    if value is None:
        return None
    if isinstance(value, dict):
        # Rare: token nested
        return _as_clean_str(value.get("access_token") or value.get("token"))
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            value = str(value)
    s = str(value).strip()
    return s if s else None


def _tile_fetcher_to_url_string(tf_raw: Any) -> Optional[str]:
    """Resolve EE getMapId tile_fetcher to a URL template string.

    Cloud API returns ee.data.TileFetcher; the OpenLayers-ready template is on
    .url_format (not str(tile_fetcher), which is useless). Legacy responses may
    pass a plain string.
    """
    if tf_raw is None:
        return None
    for attr in ("url_format", "_url_format"):
        url_fmt = getattr(tf_raw, attr, None)
        if isinstance(url_fmt, str) and url_fmt.strip():
            return url_fmt.strip()
    if isinstance(tf_raw, dict):
        nested = tf_raw.get("url_format") or tf_raw.get("urlFormat")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    if isinstance(tf_raw, (bytes, bytearray)):
        try:
            tf_raw = tf_raw.decode("utf-8")
        except Exception:
            return None
    if isinstance(tf_raw, str):
        s = tf_raw.strip()
        return s if s else None
    return None


def _normalize_tile_fetcher_to_xyz(url: str) -> Optional[str]:
    """Earth Engine tile_fetcher strings vary; OpenLayers XYZ needs {z}/{x}/{y}."""
    u = url.strip()
    if u.startswith("//"):
        u = "https:" + u
    if not u.startswith("http"):
        return None
    # Alias placeholders used by some EE / Maps API responses
    for old, new in (
        ("{zoom}", "{z}"),
        ("{level}", "{z}"),
        ("{tile_z}", "{z}"),
        ("{tile_x}", "{x}"),
        ("{tile_y}", "{y}"),
    ):
        u = u.replace(old, new)
    if "{z}" in u and "{x}" in u and "{y}" in u:
        return u
    # Older clients used three %d for z, x, y in path order
    if u.count("%d") == 3:
        u = u.replace("%d", "{z}", 1)
        u = u.replace("%d", "{x}", 1)
        u = u.replace("%d", "{y}", 1)
        return u
    return None


def _cloud_xyz_template_from_map_name(map_name: str) -> Optional[str]:
    """Rebuild Cloud Maps tile URL when TileFetcher is missing (same path as ee.data.getMapId)."""
    mn = map_name.strip()
    if not mn:
        return None
    version = "v1"
    try:
        from ee import _cloud_api_utils  # type: ignore

        version = getattr(_cloud_api_utils, "VERSION", None) or version
    except Exception:
        pass
    base = "https://earthengine.googleapis.com"
    candidate = f"{base}/{version}/{mn}/tiles/{{z}}/{{x}}/{{y}}"
    return _normalize_tile_fetcher_to_xyz(candidate)


def _map_id_dict(map_result: Any) -> dict[str, Any]:
    if isinstance(map_result, dict):
        return map_result
    if isinstance(map_result, Mapping):
        return dict(map_result)
    raise ValueError("getMapId must return a dict-like map id object.")


def map_id_to_xyz_template(map_result: Any) -> str:
    """Turn EE getMapId payload into an OpenLayers XYZ template."""
    mr = _map_id_dict(map_result)
    mapid = _as_clean_str(mr.get("mapid") or mr.get("mapId") or mr.get("name"))
    token = _as_clean_str(mr.get("token") or mr.get("access_token"))

    # Cloud API: token is often empty; template is on TileFetcher.url_format / _url_format
    tf_raw = mr.get("tile_fetcher") or mr.get("tileFetcher")
    tf_url = _tile_fetcher_to_url_string(tf_raw)
    if tf_url:
        normalized = _normalize_tile_fetcher_to_xyz(tf_url)
        if normalized:
            return normalized

    # Cloud API always returns map resource name; reconstruct if fetcher was unusable
    if mapid:
        rebuilt = _cloud_xyz_template_from_map_name(mapid)
        if rebuilt:
            return rebuilt

    # Legacy Maps API: mapid + non-empty token
    if mapid and token:
        return f"https://earthengine.googleapis.com/map/{mapid}/{{z}}/{{x}}/{{y}}?token={token}"

    raise ValueError(
        "Could not build XYZ URL from getMapId (tile_fetcher / map name / legacy token missing)."
    )


def _tile_url_payload_sync(body: EETileUrlRequest) -> dict[str, Any]:
    mr = _build_image(body)
    tile_url = map_id_to_xyz_template(mr)
    return {
        "tile_url": tile_url,
        "asset_id": body.asset_id.strip(),
        "band": body.band,
    }


@router.get("/status")
def ee_status():
    """Whether EE is importable and a credentials file path is set (no EE RPC)."""
    return ee_status_dict()


@router.post("/tile-url")
async def ee_tile_url(body: EETileUrlRequest):
    """Return an XYZ tile URL template for the given Earth Engine asset and visualization."""
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, partial(_tile_url_payload_sync, body))
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=502, detail=str(ve)) from ve
    except Exception as ex:
        raise HTTPException(status_code=502, detail=f"Earth Engine error: {ex}") from ex
