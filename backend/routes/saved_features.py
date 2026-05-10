"""Persistent storage for user-saved map features."""

from __future__ import annotations

from datetime import datetime, timezone
import io
import json
import os
import sqlite3
import hashlib
import math
from pathlib import Path
import re
from typing import Any, Dict, List, Literal, Optional
from uuid import uuid4

import concurrent.futures

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.windows import from_bounds, Window
from rasterio.warp import transform_bounds
import requests


router = APIRouter(tags=["saved_features"])

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "saved_features.db"
DB_PATH = Path(os.environ.get("SAVED_FEATURES_DB_PATH", str(DEFAULT_DB_PATH))).expanduser()
DEFAULT_IMAGE_ROOT = Path(__file__).resolve().parent.parent / "data" / "saved_feature_images"
IMAGE_ROOT = Path(os.environ.get("SAVED_FEATURE_IMAGES_ROOT", str(DEFAULT_IMAGE_ROOT))).expanduser()

ALLOWED_GEOMETRY_TYPES = {"Point", "LineString", "Polygon"}


class GeometryPayload(BaseModel):
    type: Literal["Point", "LineString", "Polygon"]
    coordinates: Any


class SavedFeatureCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    category: Optional[str] = Field(default=None, max_length=120)
    geometry: GeometryPayload
    metadata: Optional[Dict[str, Any]] = None
    plot_data: Optional[Dict[str, Any]] = None


class SavedFeatureUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    tags: Optional[List[str]] = None


class FigureBandSpec(BaseModel):
    band_index: int
    band_name: Optional[str] = None
    colormap: Optional[str] = None
    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None


class FigureLayerSpec(BaseModel):
    layer_id: str
    name: str
    layer_type: Optional[str] = None
    url: str
    rgb_bands: Optional[List[int]] = None
    colormap: Optional[str] = None
    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None
    bands: Optional[List[FigureBandSpec]] = None


class SaveAreaImagesRequest(BaseModel):
    extent_3857: List[float]
    format: Literal["jpg", "png"] = "png"
    layers: List[FigureLayerSpec]
    name: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    category: Optional[str] = Field(default=None, max_length=120)


def _db_connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_saved_features_db() -> None:
    with _db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_features (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                category TEXT,
                feature_key TEXT,
                geometry_type TEXT NOT NULL,
                geometry_json TEXT NOT NULL,
                metadata_json TEXT,
                plot_data_json TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        existing_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(saved_features)").fetchall()
        }
        if "metadata_json" not in existing_columns:
            conn.execute("ALTER TABLE saved_features ADD COLUMN metadata_json TEXT")
        if "plot_data_json" not in existing_columns:
            conn.execute("ALTER TABLE saved_features ADD COLUMN plot_data_json TEXT")
        if "feature_key" not in existing_columns:
            conn.execute("ALTER TABLE saved_features ADD COLUMN feature_key TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_saved_features_feature_key ON saved_features(feature_key)")
        rows = conn.execute(
            "SELECT id, geometry_type, geometry_json, metadata_json FROM saved_features WHERE feature_key IS NULL OR feature_key = ''"
        ).fetchall()
        for row in rows:
            try:
                geom = {
                    "type": row["geometry_type"],
                    "coordinates": json.loads(row["geometry_json"]),
                }
                metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else None
                feature_key = _compute_feature_key(geom, metadata)
                conn.execute("UPDATE saved_features SET feature_key = ? WHERE id = ?", (feature_key, row["id"]))
            except Exception:
                continue
        conn.commit()


def _validate_geometry(geometry: Dict[str, Any]) -> None:
    geom_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geom_type not in ALLOWED_GEOMETRY_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported geometry type")
    if coordinates is None:
        raise HTTPException(status_code=400, detail="Geometry coordinates are required")


def _row_to_feature(row: sqlite3.Row) -> Dict[str, Any]:
    geometry = {
        "type": row["geometry_type"],
        "coordinates": json.loads(row["geometry_json"]),
    }
    metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else None
    plot_data = json.loads(row["plot_data_json"]) if row["plot_data_json"] else None
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "category": row["category"],
        "geometry": geometry,
        "metadata": metadata,
        "plot_data": plot_data,
        "created_at": row["created_at"],
    }


def _sanitize_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name.strip())
    cleaned = cleaned.strip("._")
    return cleaned or "layer"


def _canonicalize_coordinates(coords: Any) -> Any:
    if isinstance(coords, (list, tuple)):
        if len(coords) == 2 and all(isinstance(v, (int, float)) for v in coords):
            return [round(float(coords[0]), 6), round(float(coords[1]), 6)]
        return [_canonicalize_coordinates(item) for item in coords]
    return coords


def _compute_feature_key(geometry: Dict[str, Any], metadata: Optional[Dict[str, Any]]) -> str:
    meta = metadata or {}
    key_payload = {
        "geometry_type": geometry.get("type"),
        "coordinates": _canonicalize_coordinates(geometry.get("coordinates")),
        "source": meta.get("source"),
        "tile_name": meta.get("tile_name"),
    }
    raw = json.dumps(key_payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _extract_google_point_snapshot(
    lon: float,
    lat: float,
    buffer_m: float = 75.0,
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    # Aim for a crisp square snapshot around the point.
    width_px = 1024
    target_span_m = max(10.0, buffer_m * 2.0)
    meters_per_pixel = target_span_m / width_px
    lat_rad = math.radians(lat)
    meters_per_pixel_at_zoom0 = 156543.03392 * max(0.1, math.cos(lat_rad))
    zoom = int(math.floor(math.log2(meters_per_pixel_at_zoom0 / max(0.01, meters_per_pixel))))
    zoom = max(0, min(20, zoom))

    google_key = os.environ.get("GOOGLE_STATIC_MAPS_API_KEY", "").strip()
    def _sanitize_error_message(msg: str) -> str:
        # Never persist raw API keys in metadata/log-like fields.
        return re.sub(r"(key=)[^&\\s]+", r"\\1<redacted>", msg)

    def _lonlat_to_pixel(lon_v: float, lat_v: float, z_v: int) -> tuple[float, float]:
        siny = math.sin(math.radians(lat_v))
        siny = min(max(siny, -0.9999), 0.9999)
        world = 256 * (2 ** z_v)
        x = (lon_v + 180.0) / 360.0 * world
        y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * world
        return x, y

    def _stitch_xyz_tiles(url_builder, provider_name: str) -> Optional[tuple[bytes, str]]:
        from PIL import Image
        center_x, center_y = _lonlat_to_pixel(lon, lat, zoom)
        half = width_px / 2
        left, top = center_x - half, center_y - half
        right, bottom = center_x + half, center_y + half

        min_tx = int(math.floor(left / 256))
        max_tx = int(math.floor((right - 1) / 256))
        min_ty = int(math.floor(top / 256))
        max_ty = int(math.floor((bottom - 1) / 256))
        world_tiles = 2 ** zoom

        stitched = Image.new("RGB", ((max_tx - min_tx + 1) * 256, (max_ty - min_ty + 1) * 256))
        for ty in range(min_ty, max_ty + 1):
            if ty < 0 or ty >= world_tiles:
                continue
            for tx in range(min_tx, max_tx + 1):
                wrapped_tx = tx % world_tiles
                tile_url = url_builder(wrapped_tx, ty, zoom)
                tile_resp = requests.get(tile_url, timeout=20)
                tile_resp.raise_for_status()
                tile_img = Image.open(io.BytesIO(tile_resp.content)).convert("RGB")
                stitched.paste(tile_img, ((tx - min_tx) * 256, (ty - min_ty) * 256))

        crop_left = int(round(left - min_tx * 256))
        crop_top = int(round(top - min_ty * 256))
        crop_box = (crop_left, crop_top, crop_left + width_px, crop_top + width_px)
        cropped = stitched.crop(crop_box)
        out = io.BytesIO()
        cropped.save(out, format="PNG")
        return out.getvalue(), provider_name

    try:
        image_bytes: bytes | None = None
        provider = "google_tiles"

        # Primary path: Google Static Maps API (if key provided).
        if google_key:
            static_url = (
                "https://maps.googleapis.com/maps/api/staticmap"
                f"?center={lat:.7f},{lon:.7f}"
                f"&zoom={zoom}"
                "&size=640x640"
                "&scale=2"
                "&maptype=satellite"
                "&format=png"
                f"&key={google_key}"
            )
            try:
                resp = requests.get(static_url, timeout=30)
                resp.raise_for_status()
                content_type = resp.headers.get("content-type", "")
                if "image/" in content_type:
                    image_bytes = resp.content
                    provider = "google_static_maps"
            except Exception:
                # Continue to tile-based fallbacks below.
                image_bytes = None

        # Fallback path 1: stitch public Google satellite tiles used by base map.
        if image_bytes is None:
            try:
                stitched = _stitch_xyz_tiles(
                    lambda tx, ty, z: f"https://mt{(tx + ty) % 4}.google.com/vt/lyrs=s&x={tx}&y={ty}&z={z}",
                    "google_tiles",
                )
                if stitched is not None:
                    image_bytes, provider = stitched
            except Exception:
                image_bytes = None

        # Fallback path 2: Esri World Imagery tiles (no API key).
        if image_bytes is None:
            try:
                stitched = _stitch_xyz_tiles(
                    lambda tx, ty, z: f"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{ty}/{tx}",
                    "esri_world_imagery",
                )
                if stitched is not None:
                    image_bytes, provider = stitched
            except Exception:
                image_bytes = None

        if image_bytes is None:
            return None, "imagery_fetch_failed_all_providers"

        session_dir_name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
        session_dir = IMAGE_ROOT / session_dir_name
        session_dir.mkdir(parents=True, exist_ok=True)
        fname = f"google_satellite_point75m_{_sanitize_name(f'{lat:.5f}_{lon:.5f}')}.png"
        out_path = session_dir / fname
        out_path.write_bytes(image_bytes)

        return {
            "layer_id": "google_satellite",
            "layer_name": "Google Satellite",
            "filename": fname,
            "relative_path": str(Path(session_dir_name) / fname),
            "url": f"/saved-features/image/{(Path(session_dir_name) / fname).as_posix()}",
            "format": "png",
            "mime_type": "image/png",
            "buffer_m": buffer_m,
            "zoom": zoom,
            "provider": provider,
        }, None
    except Exception as exc:
        return None, _sanitize_error_message(f"{type(exc).__name__}:{exc}")[:300]


def _prediction_rh98_url_for_point(
    lat: float,
    lon: float,
    year: int,
    source: str,
    q_index: int,
    tile_name: Optional[str] = None,
) -> tuple[Optional[str], Optional[str], Optional[str]]:
    tile = (tile_name or "").strip().upper()
    if not tile:
        return None, None, "missing_tile_name_for_prediction_snapshot"

    rh_index = 98
    local_tpl = os.environ.get("PREDICTIONS_LOCAL_PATH_TEMPLATE", "{tile}/RH{rh}_Q{q}.tif")
    remote_tpl = os.environ.get("PREDICTIONS_REMOTE_PATH_TEMPLATE", "{zone}-{year}/{tile}/RH{rh}_Q{q}.tif")
    local_base_blended = os.environ.get("PREDICTIONS_LOCAL_BASE_PATH", "")
    local_base_original = os.environ.get("PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH", "")
    remote_base = os.environ.get("PREDICTIONS_BASE_URL", "")
    zone = tile[:3].lower() if len(tile) >= 3 else tile.lower()

    try:
        if year == 2020:
            local_base = local_base_original if source == "original" else local_base_blended
            if not local_base:
                return None, tile, "predictions_local_base_not_set"
            rel = local_tpl.format(tile=tile, rh=rh_index, q=q_index)
            path = os.path.join(local_base, rel)
            if not os.path.isfile(path):
                return None, tile, "prediction_rh98_file_not_found"
            return path, tile, None

        if not remote_base:
            return None, tile, "predictions_remote_base_not_set"
        rel = remote_tpl.format(zone=zone, year=year, tile=tile, rh=rh_index, q=q_index)
        return remote_base.rstrip("/") + "/" + rel.lstrip("/"), tile, None
    except Exception as exc:
        return None, tile, f"prediction_path_error:{type(exc).__name__}"


def _resolve_prediction_tile_name(
    metadata_payload: Dict[str, Any],
    lat: float,
    lon: float,
) -> Optional[str]:
    def _normalize_tile(value: str) -> Optional[str]:
        candidate = value.strip().upper()
        if re.match(r"^\d{1,3}[CDEFGHJKLMNPQRSTUVWX][ABCDEFGHJKLMNPQRSTUVWXYZ]{2}$", candidate):
            if re.match(r"^\d{1,2}[CDEFGHJKLMNPQRSTUVWX][ABCDEFGHJKLMNPQRSTUVWXYZ]{2}$", candidate):
                zone = int(candidate[:2])
                return f"{zone:02d}{candidate[2:]}"
            return candidate
        return None

    # 1) Explicit tile_name in metadata
    tile_name = metadata_payload.get("tile_name")
    if isinstance(tile_name, str) and tile_name.strip():
        normalized = _normalize_tile(tile_name)
        if normalized:
            return normalized

    # 2) Common tile keys in saved feature properties
    feature_props = metadata_payload.get("feature_properties")
    if isinstance(feature_props, dict):
        for key in ("tile_name", "tile", "mgrs_tile", "name", "Name"):
            value = feature_props.get(key)
            if isinstance(value, str) and value.strip():
                normalized = _normalize_tile(value)
                if normalized:
                    return normalized

    # 3) Best-effort from lat/lon via optional mgrs dependency
    try:
        import mgrs as mgrs_lib  # local import keeps lint impact contained

        g = mgrs_lib.MGRS().toMGRS(lat, lon).replace(" ", "").upper()
        m = re.match(r"^(\d{1,2})([CDEFGHJKLMNPQRSTUVWX])([ABCDEFGHJKLMNPQRSTUVWXYZ]{2})", g)
        if m:
            return f"{int(m.group(1)):02d}{m.group(2)}{m.group(3)}"
        m = re.match(r"^(\d{3})([CDEFGHJKLMNPQRSTUVWX])([ABCDEFGHJKLMNPQRSTUVWXYZ]{2})", g)
        if m:
            return f"{m.group(1)}{m.group(2)}{m.group(3)}"
    except Exception:
        return None
    return None


def _extract_prediction_rh98_snapshot(
    lon: float,
    lat: float,
    year: int,
    source: str,
    q_index: int,
    tile_name: Optional[str] = None,
    buffer_m: float = 75.0,
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    path_or_url, resolved_tile, url_error = _prediction_rh98_url_for_point(
        lat,
        lon,
        year,
        source,
        q_index,
        tile_name,
    )
    if not path_or_url:
        return None, url_error or "prediction_path_unavailable"
    try:
        webm = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
        center_x, center_y = webm.transform(lon, lat)
        xmin, ymin = center_x - buffer_m, center_y - buffer_m
        xmax, ymax = center_x + buffer_m, center_y + buffer_m

        with rasterio.open(path_or_url) as src:
            src_bounds = transform_bounds("EPSG:3857", src.crs, xmin, ymin, xmax, ymax, densify_pts=21)
            window = from_bounds(*src_bounds, transform=src.transform)
            full_window = Window(0, 0, src.width, src.height)
            window = window.intersection(full_window).round_offsets().round_lengths()
            if window.width <= 0 or window.height <= 0:
                return None, "prediction_window_outside_extent"

            arr = src.read(indexes=1, window=window).astype(np.float32)
            nodata = src.nodata
            if nodata is not None:
                arr[arr == nodata] = np.nan
            valid = np.isfinite(arr)
            if not np.any(valid):
                return None, "prediction_window_all_nodata"

            lo = float(np.percentile(arr[valid], 2))
            hi = float(np.percentile(arr[valid], 98))
            if hi <= lo:
                hi = lo + 1.0
            norm = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)

        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except Exception:
            return None, "matplotlib_unavailable"

        session_dir_name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
        session_dir = IMAGE_ROOT / session_dir_name
        session_dir.mkdir(parents=True, exist_ok=True)
        fname = f"prediction_rh98_q{q_index}_point75m_{_sanitize_name(f'{lat:.5f}_{lon:.5f}')}.png"
        out_path = session_dir / fname

        fig, ax = plt.subplots(figsize=(4, 4), dpi=180)
        ax.set_axis_off()
        ax.imshow(norm, cmap="inferno", vmin=0.0, vmax=1.0)
        fig.savefig(out_path, format="png", bbox_inches="tight", pad_inches=0.03)
        plt.close(fig)

        return {
            "layer_id": f"prediction_rh98_q{q_index}",
            "layer_name": f"Prediction RH98 (Q{q_index})",
            "filename": fname,
            "relative_path": str(Path(session_dir_name) / fname),
            "url": f"/saved-features/image/{(Path(session_dir_name) / fname).as_posix()}",
            "format": "png",
            "mime_type": "image/png",
            "buffer_m": buffer_m,
            "year": year,
            "q_index": q_index,
            "tile_name": resolved_tile,
            "source": source,
        }, None
    except Exception as exc:
        return None, f"{type(exc).__name__}:{exc}"


def _extract_sentinel2_point_snapshots(
    lon: float,
    lat: float,
    sentinel_layers: List[Dict[str, Any]],
    buffer_m: float = 75.0,
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    exports: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    if not sentinel_layers:
        return exports, errors

    webm = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    center_x, center_y = webm.transform(lon, lat)
    xmin, ymin = center_x - buffer_m, center_y - buffer_m
    xmax, ymax = center_x + buffer_m, center_y + buffer_m

    for idx, layer in enumerate(sentinel_layers):
        try:
            url = str(layer.get("url") or "").strip()
            if not url:
                continue

            with rasterio.open(url) as src:
                src_bounds = transform_bounds("EPSG:3857", src.crs, xmin, ymin, xmax, ymax, densify_pts=21)
                window = from_bounds(*src_bounds, transform=src.transform)
                full_window = Window(0, 0, src.width, src.height)
                window = window.intersection(full_window).round_offsets().round_lengths()
                if window.width <= 0 or window.height <= 0:
                    raise ValueError("selection_outside_extent")

                requested_rgb = layer.get("rgb_bands")
                rgb_bands: List[int]
                if isinstance(requested_rgb, list) and len(requested_rgb) >= 3:
                    rgb_bands = [int(requested_rgb[0]), int(requested_rgb[1]), int(requested_rgb[2])]
                elif src.count >= 4:
                    # Default Sentinel-2 true-color composite when no metadata is available.
                    rgb_bands = [4, 3, 2]
                else:
                    rgb_bands = [1, 2, 3]

                rgb_bands = [
                    b for b in rgb_bands
                    if isinstance(b, int) and b >= 1 and b <= src.count
                ]

                if len(rgb_bands) >= 3:
                    rgb = src.read(indexes=rgb_bands[:3], window=window).astype(np.float32)
                    explicit_min = layer.get("rescale_min")
                    explicit_max = layer.get("rescale_max")
                    use_explicit_rescale = (
                        explicit_min is not None
                        and explicit_max is not None
                        and np.isfinite(float(explicit_min))
                        and np.isfinite(float(explicit_max))
                        and float(explicit_max) > float(explicit_min)
                    )
                    for b in range(3):
                        band = rgb[b]
                        nodata = src.nodata
                        if nodata is not None:
                            band[band == nodata] = np.nan
                        valid = np.isfinite(band)
                        if np.any(valid):
                            if use_explicit_rescale:
                                lo = float(explicit_min)
                                hi = float(explicit_max)
                            else:
                                lo = float(np.percentile(band[valid], 2))
                                hi = float(np.percentile(band[valid], 98))
                            if hi <= lo:
                                hi = lo + 1.0
                            band[:] = np.clip((band - lo) / (hi - lo), 0.0, 1.0)
                        else:
                            band[:] = 0
                    img = np.transpose(rgb, (1, 2, 0))
                else:
                    band = src.read(indexes=1, window=window).astype(np.float32)
                    nodata = src.nodata
                    if nodata is not None:
                        band[band == nodata] = np.nan
                    valid = np.isfinite(band)
                    if not np.any(valid):
                        raise ValueError("all_nodata")
                    lo = float(np.percentile(band[valid], 2))
                    hi = float(np.percentile(band[valid], 98))
                    if hi <= lo:
                        hi = lo + 1.0
                    norm = np.clip((band - lo) / (hi - lo), 0.0, 1.0)
                    img = np.stack([norm, norm, norm], axis=-1)

            try:
                from PIL import Image
            except Exception:
                raise ValueError("pillow_unavailable")

            session_dir_name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
            session_dir = IMAGE_ROOT / session_dir_name
            session_dir.mkdir(parents=True, exist_ok=True)
            layer_name = str(layer.get("name") or f"sentinel2_{idx + 1}")
            fname = f"sentinel2_point75m_{_sanitize_name(layer_name)}_{_sanitize_name(f'{lat:.5f}_{lon:.5f}')}.png"
            out_path = session_dir / fname
            Image.fromarray((np.clip(img, 0.0, 1.0) * 255).astype(np.uint8)).save(out_path, format="PNG")

            exports.append({
                "layer_id": str(layer.get("id") or f"sentinel2_{idx + 1}"),
                "layer_name": layer_name,
                "filename": fname,
                "relative_path": str(Path(session_dir_name) / fname),
                "url": f"/saved-features/image/{(Path(session_dir_name) / fname).as_posix()}",
                "format": "png",
                "mime_type": "image/png",
                "buffer_m": buffer_m,
                "source": "sentinel2_layer",
                "tile_name": layer.get("tile_name"),
                "datetime": layer.get("datetime"),
                "rgb_bands": rgb_bands[:3] if len(rgb_bands) >= 3 else None,
            })
        except Exception as exc:
            errors.append({
                "layer_id": layer.get("id"),
                "name": layer.get("name"),
                "error": f"{type(exc).__name__}:{exc}",
            })

    return exports, errors


@router.get("/saved-features")
async def list_saved_features() -> Dict[str, Any]:
    with _db_connect() as conn:
        rows = conn.execute(
            """
            SELECT id, name, description, category, geometry_type, geometry_json, metadata_json, plot_data_json, created_at
            FROM saved_features
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()
    return {"features": [_row_to_feature(row) for row in rows]}


@router.post("/saved-features")
async def create_saved_feature(payload: SavedFeatureCreateRequest) -> Dict[str, Any]:
    geometry_dict = payload.geometry.model_dump()
    _validate_geometry(geometry_dict)

    created_at = datetime.now(timezone.utc).isoformat()
    description = payload.description.strip() if payload.description else None
    category = payload.category.strip() if payload.category else None
    name = payload.name.strip()
    metadata_payload = dict(payload.metadata or {})
    plot_data_payload = dict(payload.plot_data or {})
    feature_key = _compute_feature_key(geometry_dict, metadata_payload)

    # For saved popup points, attempt 75m exports (satellite + RH98 prediction).
    if geometry_dict["type"] == "Point" and metadata_payload.get("source") == "feature_popup":
        try:
            lon, lat = geometry_dict["coordinates"]
            lon = float(lon)
            lat = float(lat)

            def _upsert_export(new_item: Dict[str, Any]) -> None:
                existing_exports = plot_data_payload.get("image_exports")
                if not isinstance(existing_exports, list):
                    existing_exports = []
                existing_exports = [item for item in existing_exports if isinstance(item, dict)]
                layer_id = new_item.get("layer_id")
                if layer_id:
                    existing_exports = [item for item in existing_exports if item.get("layer_id") != layer_id]
                existing_exports.append(new_item)
                plot_data_payload["image_exports"] = existing_exports
                if new_item.get("relative_path"):
                    plot_data_payload["image_session_dir"] = Path(new_item["relative_path"]).parts[0]

            snapshot, snapshot_error = _extract_google_point_snapshot(
                lon,
                lat,
                buffer_m=75.0,
            )
            if snapshot:
                _upsert_export(snapshot)
                metadata_payload["point_buffer_m"] = 75.0
                metadata_payload["satellite_snapshot"] = {
                    "provider": snapshot.get("provider"),
                    "zoom": snapshot.get("zoom"),
                }
                metadata_payload["satellite_snapshot_status"] = "ok"
            else:
                metadata_payload["satellite_snapshot_status"] = "unavailable"
                if snapshot_error:
                    metadata_payload["satellite_snapshot_error"] = snapshot_error[:300]

            pred_year = int(metadata_payload.get("year") or 2020)
            pred_source = str(metadata_payload.get("prediction_source") or "blended").strip().lower() or "blended"
            pred_q_index = int(metadata_payload.get("q_index") or 1)
            tile_name = _resolve_prediction_tile_name(metadata_payload, lat, lon)
            pred_snapshot, pred_error = _extract_prediction_rh98_snapshot(
                lon,
                lat,
                year=pred_year,
                source=pred_source,
                q_index=pred_q_index,
                tile_name=str(tile_name) if tile_name else None,
                buffer_m=75.0,
            )
            if pred_snapshot:
                _upsert_export(pred_snapshot)
                metadata_payload["prediction_snapshot_status"] = "ok"
                metadata_payload["prediction_snapshot"] = {
                    "rh": 98,
                    "q_index": pred_q_index,
                    "year": pred_year,
                    "source": pred_source,
                }
            else:
                metadata_payload["prediction_snapshot_status"] = "unavailable"
                if pred_error:
                    metadata_payload["prediction_snapshot_error"] = pred_error[:300]
                metadata_payload["prediction_snapshot_debug"] = {
                    "tile_name": tile_name,
                    "year": pred_year,
                    "q_index": pred_q_index,
                    "source": pred_source,
                }

            sentinel_layers = metadata_payload.get("sentinel2_layers")
            if isinstance(sentinel_layers, list) and len(sentinel_layers) > 0:
                sentinel_exports, sentinel_errors = _extract_sentinel2_point_snapshots(
                    lon,
                    lat,
                    [layer for layer in sentinel_layers if isinstance(layer, dict)],
                    buffer_m=75.0,
                )
                for export in sentinel_exports:
                    _upsert_export(export)
                metadata_payload["sentinel2_snapshot_status"] = "ok" if sentinel_exports else "unavailable"
                metadata_payload["sentinel2_snapshot_count"] = len(sentinel_exports)
                if sentinel_errors:
                    metadata_payload["sentinel2_snapshot_errors"] = sentinel_errors[:5]
            elif metadata_payload.get("source") == "feature_popup":
                metadata_payload["sentinel2_snapshot_status"] = "unavailable"
                metadata_payload["sentinel2_snapshot_count"] = 0
        except Exception:
            metadata_payload["satellite_snapshot_status"] = "unavailable"
            metadata_payload["satellite_snapshot_error"] = "snapshot_generation_exception"
            metadata_payload["prediction_snapshot_status"] = "unavailable"
            metadata_payload["prediction_snapshot_error"] = "prediction_snapshot_generation_exception"

    metadata_json = json.dumps(metadata_payload) if metadata_payload else None
    plot_data_json = json.dumps(plot_data_payload) if plot_data_payload else None

    if not name:
        raise HTTPException(status_code=400, detail="Feature name is required")

    with _db_connect() as conn:
        existing = conn.execute(
            """
            SELECT id
            FROM saved_features
            WHERE feature_key = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (feature_key,),
        ).fetchone()
        if existing is not None:
            feature_id = existing["id"]
            conn.execute(
                """
                UPDATE saved_features
                SET name = ?, description = ?, category = ?, geometry_type = ?, geometry_json = ?,
                    metadata_json = ?, plot_data_json = ?, created_at = ?, feature_key = ?
                WHERE id = ?
                """,
                (
                    name,
                    description,
                    category,
                    geometry_dict["type"],
                    json.dumps(geometry_dict["coordinates"]),
                    metadata_json,
                    plot_data_json,
                    created_at,
                    feature_key,
                    feature_id,
                ),
            )
        else:
            cursor = conn.execute(
                """
                INSERT INTO saved_features (name, description, category, feature_key, geometry_type, geometry_json, metadata_json, plot_data_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    description,
                    category,
                    feature_key,
                    geometry_dict["type"],
                    json.dumps(geometry_dict["coordinates"]),
                    metadata_json,
                    plot_data_json,
                    created_at,
                ),
            )
            feature_id = cursor.lastrowid
        row = conn.execute(
            """
            SELECT id, name, description, category, geometry_type, geometry_json, metadata_json, plot_data_json, created_at
            FROM saved_features
            WHERE id = ?
            """,
            (feature_id,),
        ).fetchone()
        conn.commit()

    if row is None:
        raise HTTPException(status_code=500, detail="Failed to load newly saved feature")
    return {"feature": _row_to_feature(row)}


@router.post("/saved-features/area-images")
async def create_area_images_feature(payload: SaveAreaImagesRequest) -> Dict[str, Any]:
    if len(payload.extent_3857) != 4:
        raise HTTPException(status_code=400, detail="extent_3857 must contain exactly 4 numbers.")
    if not payload.layers:
        raise HTTPException(status_code=400, detail="No layers were provided.")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from mpl_toolkits.axes_grid1 import make_axes_locatable
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Matplotlib is not available: {exc}") from exc

    titiler_to_mpl_cmap = {
        "greens": "Greens", "viridis": "viridis", "inferno": "inferno",
        "magma": "magma", "plasma": "plasma", "cividis": "cividis",
        "ylgn": "YlGn", "ylgnbu": "YlGnBu", "gnbu": "GnBu",
        "bugn": "BuGn", "pubu": "PuBu", "rdylgn": "RdYlGn",
        "spectral": "Spectral", "rdbu": "RdBu", "greys": "Greys",
        "blues": "Blues", "reds": "Reds", "oranges": "Oranges",
        "ylgn_r": "YlGn_r", "ylgnbu_r": "YlGnBu_r", "gnbu_r": "GnBu_r",
        "bugn_r": "BuGn_r", "pubu_r": "PuBu_r", "rdylgn_r": "RdYlGn_r",
        "spectral_r": "Spectral_r", "rdbu_r": "RdBu_r",
    }

    def resolve_cmap(name: Optional[str]) -> str:
        if not name:
            return "viridis"
        return titiler_to_mpl_cmap.get(name, name)

    def read_as_float(src, window, indexes=None):
        kwargs = {"window": window}
        if indexes is not None:
            kwargs["indexes"] = indexes
        raw = src.read(**kwargs).astype(np.float32)
        nodata = src.nodata
        if nodata is not None:
            raw[raw == nodata] = np.nan
        return raw

    def resolve_single_band_range(arr: np.ndarray, low: Optional[float], high: Optional[float]) -> tuple[float, float]:
        valid = np.isfinite(arr)
        if not np.any(valid):
            return 0.0, 1.0
        if low is None or high is None:
            vals = arr[valid]
            low = float(np.percentile(vals, 2))
            high = float(np.percentile(vals, 98))
        if high <= low:
            high = low + 1.0
        return float(low), float(high)

    def normalize_rgb(rgb: np.ndarray) -> np.ndarray:
        out = np.zeros_like(rgb, dtype=np.float32)
        for i in range(3):
            band = rgb[i]
            valid = np.isfinite(band)
            if not np.any(valid):
                continue
            lo = float(np.percentile(band[valid], 2))
            hi = float(np.percentile(band[valid], 98))
            if hi <= lo:
                hi = lo + 1.0
            norm = (band - lo) / (hi - lo)
            out[i] = np.clip(norm, 0.0, 1.0)
        return np.transpose(out, (1, 2, 0))

    def normalize_rgb_with_range(
        rgb: np.ndarray,
        low: float,
        high: float,
        gamma: float = 1.0,
        brightness: float = 1.0,
    ) -> np.ndarray:
        if high <= low:
            high = low + 1.0
        out = np.zeros_like(rgb, dtype=np.float32)
        for i in range(3):
            band = rgb[i]
            norm = (band - low) / (high - low)
            norm = np.clip(norm, 0.0, 1.0)
            if gamma > 0 and gamma != 1.0:
                norm = np.power(norm, 1.0 / gamma)
            if brightness != 1.0:
                norm = np.clip(norm * brightness, 0.0, 1.0)
            out[i] = norm
        return np.transpose(out, (1, 2, 0))

    def resolve_rgb_indexes(src, requested: Optional[List[int]], prefer_sentinel_rgb: bool) -> List[int]:
        if requested and len(requested) == 3 and all(isinstance(v, int) and 1 <= v <= src.count for v in requested):
            return requested
        if prefer_sentinel_rgb and src.count >= 4:
            return [4, 3, 2]
        return [1, 2, 3]

    xmin, ymin, xmax, ymax = [float(v) for v in payload.extent_3857]
    wgs_bounds = transform_bounds("EPSG:3857", "EPSG:4326", xmin, ymin, xmax, ymax)
    center_lon = (wgs_bounds[0] + wgs_bounds[2]) / 2
    center_lat = (wgs_bounds[1] + wgs_bounds[3]) / 2
    location_tag = f"{center_lat:.4f}_{center_lon:.4f}".replace("-", "m")
    session_dir_name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
    session_dir = IMAGE_ROOT / session_dir_name
    session_dir.mkdir(parents=True, exist_ok=True)
    image_exports: List[Dict[str, Any]] = []
    render_errors: List[Dict[str, str]] = []

    def render_one_image_bytes(src, window, title: str, file_name: str, cmap: Optional[str],
                               rmin: Optional[float], rmax: Optional[float], band_idx: Optional[int],
                               prefer_sentinel_rgb: bool = False, rgb_bands: Optional[List[int]] = None) -> bytes:
        fig, ax = plt.subplots(figsize=(8, 8), dpi=160)
        ax.set_axis_off()
        ax.set_title(title, fontsize=11)

        if band_idx is not None:
            data = read_as_float(src, window, indexes=band_idx)
        elif src.count >= 3 and cmap is None:
            rgb_indexes = resolve_rgb_indexes(src, rgb_bands, prefer_sentinel_rgb)
            rgb = read_as_float(src, window, indexes=rgb_indexes)
            if prefer_sentinel_rgb:
                if rmin is not None and rmax is not None:
                    rendered = normalize_rgb_with_range(
                        rgb,
                        float(rmin),
                        float(rmax),
                        gamma=1.25,
                        brightness=1.15,
                    )
                else:
                    valid = rgb[np.isfinite(rgb)]
                    auto_high = 255.0
                    if valid.size > 0 and float(np.nanmax(valid)) > 255.0:
                        auto_high = 2500.0
                    rendered = normalize_rgb_with_range(
                        rgb,
                        0.0,
                        auto_high,
                        gamma=1.25,
                        brightness=1.15,
                    )
                ax.imshow(rendered)
            else:
                ax.imshow(normalize_rgb(rgb))
            buf = io.BytesIO()
            fig.savefig(buf, format=payload.format, bbox_inches="tight", pad_inches=0.05)
            plt.close(fig)
            return buf.getvalue()
        else:
            data = read_as_float(src, window, indexes=1)

        low, high = resolve_single_band_range(data, rmin, rmax)
        im = ax.imshow(data, cmap=resolve_cmap(cmap), vmin=low, vmax=high)
        divider = make_axes_locatable(ax)
        cax = divider.append_axes("right", size="5%", pad=0.15)
        cbar = fig.colorbar(im, cax=cax)
        cbar.ax.tick_params(labelsize=8)
        buf = io.BytesIO()
        fig.savefig(buf, format=payload.format, bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        return buf.getvalue()

    for layer in payload.layers:
        try:
            is_sentinel = layer.layer_type == "sentinel2"
            with rasterio.open(layer.url) as src:
                src_bounds = transform_bounds("EPSG:3857", src.crs, xmin, ymin, xmax, ymax, densify_pts=21)
                window = from_bounds(*src_bounds, transform=src.transform)
                full_window = Window(0, 0, src.width, src.height)
                window = window.intersection(full_window).round_offsets().round_lengths()
                if window.width <= 0 or window.height <= 0:
                    raise ValueError("Selection does not overlap layer extent.")

                if layer.bands and len(layer.bands) > 0:
                    for band in layer.bands:
                        band_name = band.band_name or f"band{band.band_index}"
                        title = f"{layer.name} — {band_name}"
                        file_name = f"{_sanitize_name(layer.name)}_{_sanitize_name(location_tag)}_{_sanitize_name(band_name)}.{payload.format}"
                        image_bytes = render_one_image_bytes(
                            src, window, title, file_name,
                            band.colormap if band.colormap is not None else layer.colormap,
                            band.rescale_min if band.rescale_min is not None else layer.rescale_min,
                            band.rescale_max if band.rescale_max is not None else layer.rescale_max,
                            band.band_index, is_sentinel, layer.rgb_bands
                        )
                        out_path = session_dir / file_name
                        out_path.write_bytes(image_bytes)
                        image_exports.append({
                            "layer_id": layer.layer_id,
                            "layer_name": layer.name,
                            "band_name": band_name,
                            "filename": file_name,
                            "relative_path": str(Path(session_dir_name) / file_name),
                            "url": f"/saved-features/image/{(Path(session_dir_name) / file_name).as_posix()}",
                            "format": payload.format,
                            "mime_type": f"image/{'jpeg' if payload.format == 'jpg' else payload.format}",
                        })
                else:
                    file_name = f"{_sanitize_name(layer.name)}_{_sanitize_name(location_tag)}.{payload.format}"
                    image_bytes = render_one_image_bytes(
                        src, window, layer.name, file_name,
                        layer.colormap, layer.rescale_min, layer.rescale_max,
                        None, is_sentinel, layer.rgb_bands
                    )
                    out_path = session_dir / file_name
                    out_path.write_bytes(image_bytes)
                    image_exports.append({
                        "layer_id": layer.layer_id,
                        "layer_name": layer.name,
                        "filename": file_name,
                        "relative_path": str(Path(session_dir_name) / file_name),
                        "url": f"/saved-features/image/{(Path(session_dir_name) / file_name).as_posix()}",
                        "format": payload.format,
                        "mime_type": f"image/{'jpeg' if payload.format == 'jpg' else payload.format}",
                    })
        except Exception as exc:
            render_errors.append({"layer_id": layer.layer_id, "name": layer.name, "error": str(exc)})

    if not image_exports:
        raise HTTPException(status_code=400, detail=f"No images were generated. Errors: {render_errors[:3]}")

    ring = [
        [wgs_bounds[0], wgs_bounds[1]],
        [wgs_bounds[2], wgs_bounds[1]],
        [wgs_bounds[2], wgs_bounds[3]],
        [wgs_bounds[0], wgs_bounds[3]],
        [wgs_bounds[0], wgs_bounds[1]],
    ]
    created_at = datetime.now(timezone.utc).isoformat()
    feature_name = payload.name.strip() if payload.name else f"Area images {location_tag}"
    feature_description = (
        payload.description.strip()
        if payload.description is not None and payload.description.strip() != ""
        else "Rectangle capture with extracted images saved to disk and referenced in database."
    )
    feature_category = payload.category.strip() if payload.category else "area_images"
    metadata = {
        "source": "area_images",
        "image_count": len(image_exports),
        "format": payload.format,
        "extent_3857": payload.extent_3857,
        "image_root": str(IMAGE_ROOT),
        "image_session_dir": session_dir_name,
        "errors": render_errors,
    }
    plot_data = {
        "image_exports": image_exports,
        "extent_3857": payload.extent_3857,
        "location_tag": location_tag,
        "image_session_dir": session_dir_name,
    }

    with _db_connect() as conn:
        geom_dict = {"type": "Polygon", "coordinates": [ring]}
        feature_key = _compute_feature_key(geom_dict, metadata)
        existing = conn.execute(
            """
            SELECT id
            FROM saved_features
            WHERE feature_key = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (feature_key,),
        ).fetchone()
        if existing is not None:
            feature_id = existing["id"]
            conn.execute(
                """
                UPDATE saved_features
                SET name = ?, description = ?, category = ?, geometry_type = ?, geometry_json = ?,
                    metadata_json = ?, plot_data_json = ?, created_at = ?, feature_key = ?
                WHERE id = ?
                """,
                (
                    feature_name,
                    feature_description,
                    feature_category,
                    "Polygon",
                    json.dumps([ring]),
                    json.dumps(metadata),
                    json.dumps(plot_data),
                    created_at,
                    feature_key,
                    feature_id,
                ),
            )
        else:
            cursor = conn.execute(
                """
                INSERT INTO saved_features (name, description, category, feature_key, geometry_type, geometry_json, metadata_json, plot_data_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    feature_name,
                    feature_description,
                    feature_category,
                    feature_key,
                    "Polygon",
                    json.dumps([ring]),
                    json.dumps(metadata),
                    json.dumps(plot_data),
                    created_at,
                ),
            )
            feature_id = cursor.lastrowid
        row = conn.execute(
            """
            SELECT id, name, description, category, geometry_type, geometry_json, metadata_json, plot_data_json, created_at
            FROM saved_features
            WHERE id = ?
            """,
            (feature_id,),
        ).fetchone()
        conn.commit()

    if row is None:
        raise HTTPException(status_code=500, detail="Failed to load newly saved area image feature")
    return {"feature": _row_to_feature(row)}


@router.delete("/saved-features/{feature_id}")
async def delete_saved_feature(feature_id: int) -> Dict[str, Any]:
    with _db_connect() as conn:
        row = conn.execute(
            "SELECT plot_data_json FROM saved_features WHERE id = ?",
            (feature_id,),
        ).fetchone()
        cursor = conn.execute("DELETE FROM saved_features WHERE id = ?", (feature_id,))
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Saved feature not found")
    if row and row["plot_data_json"]:
        try:
            plot_data = json.loads(row["plot_data_json"])
            exports = plot_data.get("image_exports") if isinstance(plot_data, dict) else None
            if isinstance(exports, list):
                for item in exports:
                    rel = item.get("relative_path") if isinstance(item, dict) else None
                    if not rel:
                        continue
                    p = (IMAGE_ROOT / rel).resolve()
                    if IMAGE_ROOT.resolve() in p.parents and p.is_file():
                        p.unlink(missing_ok=True)
                session_dir = plot_data.get("image_session_dir")
                if isinstance(session_dir, str):
                    session_path = (IMAGE_ROOT / session_dir).resolve()
                    if IMAGE_ROOT.resolve() in session_path.parents and session_path.is_dir() and not any(session_path.iterdir()):
                        session_path.rmdir()
        except Exception:
            pass
    return {"success": True}


@router.patch("/saved-features/{feature_id}")
async def update_saved_feature(feature_id: int, payload: SavedFeatureUpdateRequest) -> Dict[str, Any]:
    updates: List[str] = []
    params: List[Any] = []

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Feature name is required")
        updates.append("name = ?")
        params.append(name)

    if payload.description is not None:
        description = payload.description.strip() or None
        updates.append("description = ?")
        params.append(description)

    if payload.tags is not None:
        clean_tags: List[str] = []
        for tag in payload.tags:
            t = str(tag).strip()
            if t:
                clean_tags.append(t[:60])
        clean_tags = list(dict.fromkeys(clean_tags))[:30]

        with _db_connect() as conn:
            row = conn.execute(
                "SELECT metadata_json FROM saved_features WHERE id = ?",
                (feature_id,),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Saved feature not found")
            metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
            if not isinstance(metadata, dict):
                metadata = {}
            metadata["tags"] = clean_tags
            updates.append("metadata_json = ?")
            params.append(json.dumps(metadata))

    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")

    params.append(feature_id)
    with _db_connect() as conn:
        cursor = conn.execute(
            f"UPDATE saved_features SET {', '.join(updates)} WHERE id = ?",
            tuple(params),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Saved feature not found")
        row = conn.execute(
            """
            SELECT id, name, description, category, geometry_type, geometry_json, metadata_json, plot_data_json, created_at
            FROM saved_features
            WHERE id = ?
            """,
            (feature_id,),
        ).fetchone()
        conn.commit()

    if row is None:
        raise HTTPException(status_code=500, detail="Failed to load updated feature")
    return {"feature": _row_to_feature(row)}


def _stitch_bbox_satellite(
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
    buffer_m: float = 200.0,
    max_width_px: int = 2048,
) -> tuple[Optional[bytes], dict]:
    """Fetch and stitch satellite tiles for a bbox with a uniform buffer.

    Source: Google Maps' XYZ tile service (same imagery that the frontend
    OpenLayers map uses as basemap), fetched as **retina/HD tiles via
    `&scale=2`** which return 512×512 PNGs containing 2× more detail per
    geographic area than standard 256×256 tiles.  Falls back to the regular
    256-tile Google endpoint and then Esri World Imagery (256-tile).  This is
    NOT the Static Maps API and not a screenshot — it is direct tile fetching.

    Tiles are fetched in parallel (up to 16 workers).  Returns (png_bytes, metadata).
    """
    from PIL import Image

    mean_lat = (min_lat + max_lat) / 2.0
    lat_rad = math.radians(mean_lat)
    lat_buf = buffer_m / 111320.0
    lon_buf = buffer_m / (111320.0 * max(1e-6, math.cos(lat_rad)))

    bmin_lon = min_lon - lon_buf
    bmax_lon = max_lon + lon_buf
    bmin_lat = min_lat - lat_buf
    bmax_lat = max_lat + lat_buf

    span_m = (bmax_lon - bmin_lon) * 111320.0 * max(1e-6, math.cos(lat_rad))
    m_per_px_target = max(0.01, span_m / max_width_px)
    m_per_px_zoom0 = 156543.03392 * max(0.1, math.cos(lat_rad))

    def _stitch_at(url_builder, tile_px: int, scale: int) -> Optional[bytes]:
        """Stitch tiles fetched at native `tile_px` resolution.

        `scale=1` -> 256-px tiles (standard zoom Z gives  m_per_px_zoom0 / 2^Z).
        `scale=2` -> 512-px tiles at the same zoom Z (twice the pixel density).
        We pick zoom for `scale` so the resulting image fills max_width_px.
        """
        # m_per_px_at_zoom = m_per_px_zoom0 / (2^zoom * scale)
        # Solve for zoom such that m_per_px_at_zoom == m_per_px_target.
        zoom = int(math.floor(math.log2(m_per_px_zoom0 / m_per_px_target / scale)))
        zoom = max(0, min(20, zoom))

        # `tile_px` here is the native pixel size of the *fetched* tile image
        # (256 for scale=1, 512 for scale=2). All pixel coordinates use this.
        def _ll_to_world(lon_v: float, lat_v: float) -> tuple[float, float]:
            siny = math.sin(math.radians(lat_v))
            siny = min(max(siny, -0.9999), 0.9999)
            world = tile_px * (2 ** zoom)
            return (
                (lon_v + 180.0) / 360.0 * world,
                (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * world,
            )

        left, top = _ll_to_world(bmin_lon, bmax_lat)
        right, bottom = _ll_to_world(bmax_lon, bmin_lat)
        img_w = max(1, int(round(right - left)))
        img_h = max(1, int(round(bottom - top)))

        min_tx = int(math.floor(left / tile_px))
        max_tx = int(math.floor((right - 1) / tile_px))
        min_ty = int(math.floor(top / tile_px))
        max_ty = int(math.floor((bottom - 1) / tile_px))
        world_tiles = 2 ** zoom

        tiles = [
            (tx, ty)
            for ty in range(min_ty, max_ty + 1)
            if 0 <= ty < world_tiles
            for tx in range(min_tx, max_tx + 1)
        ]

        stitched_w = (max_tx - min_tx + 1) * tile_px
        stitched_h = (max_ty - min_ty + 1) * tile_px
        stitched = Image.new("RGB", (stitched_w, stitched_h))

        def _fetch_one(tx_ty: tuple[int, int]) -> tuple[int, int, bytes]:
            tx, ty = tx_ty
            wrapped_tx = tx % world_tiles
            url = url_builder(wrapped_tx, ty, zoom)
            resp = requests.get(url, timeout=20)
            resp.raise_for_status()
            return tx, ty, resp.content

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, max(1, len(tiles)))) as exe:
            results = list(exe.map(_fetch_one, tiles))

        for tx, ty, data in results:
            tile_img = Image.open(io.BytesIO(data)).convert("RGB")
            # Defensive: if the server didn't honour scale=2, the tile will be
            # 256×256 instead of expected 512×512 — refuse to stitch in that
            # case so we can fall back to scale=1.
            if tile_img.size != (tile_px, tile_px):
                raise RuntimeError(
                    f"Tile size mismatch: expected {tile_px}×{tile_px}, got {tile_img.size}"
                )
            stitched.paste(tile_img, ((tx - min_tx) * tile_px, (ty - min_ty) * tile_px))

        crop_left = int(round(left - min_tx * tile_px))
        crop_top = int(round(top - min_ty * tile_px))
        cropped = stitched.crop((crop_left, crop_top, crop_left + img_w, crop_top + img_h))
        out = io.BytesIO()
        cropped.save(out, format="PNG")
        meta_local = {
            "min_lon": bmin_lon,
            "max_lon": bmax_lon,
            "min_lat": bmin_lat,
            "max_lat": bmax_lat,
            "zoom": zoom,
            "width_px": img_w,
            "height_px": img_h,
        }
        return out.getvalue(), meta_local

    image_bytes: Optional[bytes] = None
    meta: dict = {
        "min_lon": bmin_lon,
        "max_lon": bmax_lon,
        "min_lat": bmin_lat,
        "max_lat": bmax_lat,
        "zoom": 0,
        "width_px": 0,
        "height_px": 0,
    }

    # Primary: Google retina/HD tiles via &scale=2 (512×512, ~2× detail).
    try:
        image_bytes, meta = _stitch_at(
            lambda tx, ty, z: f"https://mt{(tx + ty) % 4}.google.com/vt/lyrs=s&x={tx}&y={ty}&z={z}&scale=2",
            tile_px=512,
            scale=2,
        )
    except Exception:
        image_bytes = None

    # Fallback 1: standard Google satellite tiles (256×256).
    if image_bytes is None:
        try:
            image_bytes, meta = _stitch_at(
                lambda tx, ty, z: f"https://mt{(tx + ty) % 4}.google.com/vt/lyrs=s&x={tx}&y={ty}&z={z}",
                tile_px=256,
                scale=1,
            )
        except Exception:
            image_bytes = None

    # Fallback 2: Esri World Imagery (no API key required, 256×256).
    if image_bytes is None:
        try:
            image_bytes, meta = _stitch_at(
                lambda tx, ty, z: (
                    f"https://services.arcgisonline.com/ArcGIS/rest/services/"
                    f"World_Imagery/MapServer/tile/{z}/{ty}/{tx}"
                ),
                tile_px=256,
                scale=1,
            )
        except Exception:
            image_bytes = None

    return image_bytes, meta


class TransectSatelliteRequest(BaseModel):
    min_lon: float
    max_lon: float
    min_lat: float
    max_lat: float
    buffer_m: float = 200.0
    max_width_px: int = 2048


@router.post("/transect/satellite-snapshot")
async def transect_satellite_snapshot(req: TransectSatelliteRequest):
    """Return a stitched satellite PNG for a transect bounding box with buffer.

    Tile fetching is parallelised; typical transects (8-16 tiles) complete in
    under two seconds vs. the OL-canvas approach which can block the browser for
    tens of seconds.
    """
    import asyncio

    loop = asyncio.get_event_loop()
    image_bytes, meta = await loop.run_in_executor(
        None,
        lambda: _stitch_bbox_satellite(
            req.min_lon,
            req.max_lon,
            req.min_lat,
            req.max_lat,
            req.buffer_m,
            req.max_width_px,
        ),
    )
    if image_bytes is None:
        raise HTTPException(
            status_code=503,
            detail="Satellite imagery fetch failed from all providers",
        )
    return Response(
        content=image_bytes,
        media_type="image/png",
        headers={
            "X-Image-Min-Lon": f"{meta['min_lon']:.7f}",
            "X-Image-Max-Lon": f"{meta['max_lon']:.7f}",
            "X-Image-Min-Lat": f"{meta['min_lat']:.7f}",
            "X-Image-Max-Lat": f"{meta['max_lat']:.7f}",
            "X-Image-Zoom": str(meta["zoom"]),
            "X-Image-Width": str(meta["width_px"]),
            "X-Image-Height": str(meta["height_px"]),
        },
    )


# ---------------------------------------------------------------------------
# Combined transect figure (matplotlib subplots, server-rendered).
# ---------------------------------------------------------------------------


class TransectProfilePoint(BaseModel):
    rh: int
    value: Optional[float] = None
    missing: Optional[bool] = None


class TransectFigureSample(BaseModel):
    lon: float
    lat: float
    distance_m: Optional[float] = None
    profile: List[TransectProfilePoint] = Field(default_factory=list)
    fhd: Optional[float] = None
    enl1d: Optional[float] = None
    enl2d: Optional[float] = None
    cr: Optional[float] = None


class TransectFigureRequest(BaseModel):
    samples: List[TransectFigureSample]
    x_axis: Literal["lon", "lat"] = "lon"
    height_bin_m: float = 5.0
    heatmap_max_height_m: float = 50.0
    heatmap_colormap_max: float = 10.0
    include_map: bool = True
    include_heatmap: bool = True
    include_enl_fhd: bool = True
    include_cr: bool = True
    # Optional: JRC TMF AnnualChanges (Dec 2020) for the same buffered bbox as
    # the satellite snapshot.  Renders as an additional sharex panel right
    # below the satellite map.  Shares `satellite_buffer_m`.
    include_ee_annualchanges: bool = False
    figure_width_px: int = 1200
    map_height_px: int = 220
    heatmap_height_px: int = 240
    enl_fhd_height_px: int = 300
    cr_height_px: int = 140
    ee_annualchanges_height_px: int = 220
    font_size: int = 11
    dpi: int = 150
    fmt: Literal["png", "jpg", "pdf"] = "png"
    satellite_buffer_m: float = 200.0
    # Higher resolution = sharper satellite imagery.  4096 px ≈ zoom level 17–18
    # for typical 200 m-buffered transects, which is near Google's max detail.
    satellite_max_width_px: int = 4096


# JRC TMF AnnualChanges visualisation parameters — kept in sync with the
# frontend `EarthEngineLayerSection.tsx` preset so the exported figure matches
# what the user sees on the interactive map.
_JRC_TMF_ANNUALCHANGES_ASSET = "projects/JRC/TMF/v1_2025/AnnualChanges"
_JRC_TMF_ANNUALCHANGES_BAND = "Dec2020"
_JRC_TMF_ANNUALCHANGES_PALETTE = [
    "005A00", "648723", "FFBE2D", "D2FA3C", "008CBE", "FFFFFF",
]
_JRC_TMF_ANNUALCHANGES_VIS_MIN = 1
_JRC_TMF_ANNUALCHANGES_VIS_MAX = 6


def _fetch_ee_annualchanges_array(
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
    buffer_m: float = 200.0,
    max_dimension: int = 2048,
) -> tuple[Optional[np.ndarray], dict]:
    """Fetch the JRC TMF AnnualChanges Dec 2020 layer for the bbox as a styled
    PNG via Earth Engine `getThumbURL`, decoded into a `(H, W, 3)` numpy array.

    Returns (None, {}) if Earth Engine is not initialised or the fetch fails —
    callers should treat this as "panel unavailable" and fall back gracefully.
    """
    try:
        from routes.earthengine import ensure_ee  # noqa: WPS433 (local import)
        ensure_ee()
        import ee  # type: ignore
    except Exception:
        return None, {}

    mean_lat = (min_lat + max_lat) / 2.0
    lat_rad = math.radians(mean_lat)
    lat_buf = buffer_m / 111320.0
    lon_buf = buffer_m / (111320.0 * max(1e-6, math.cos(lat_rad)))
    bmin_lon = min_lon - lon_buf
    bmax_lon = max_lon + lon_buf
    bmin_lat = min_lat - lat_buf
    bmax_lat = max_lat + lat_buf

    try:
        region = ee.Geometry.Rectangle(
            [bmin_lon, bmin_lat, bmax_lon, bmax_lat], "EPSG:4326", False,
        )
        img = (
            ee.ImageCollection(_JRC_TMF_ANNUALCHANGES_ASSET)
            .select(_JRC_TMF_ANNUALCHANGES_BAND)
            .mosaic()
        )
        # Mask zero/nodata so the underlying basemap colour shows through (as
        # white) — matches `mask_self=true` in the frontend preset.
        img = img.updateMask(img.neq(0))
        vis = img.visualize(
            min=_JRC_TMF_ANNUALCHANGES_VIS_MIN,
            max=_JRC_TMF_ANNUALCHANGES_VIS_MAX,
            palette=list(_JRC_TMF_ANNUALCHANGES_PALETTE),
        )
        url = vis.getThumbURL({
            "region": region,
            "dimensions": str(int(max_dimension)),
            "format": "png",
        })
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        from PIL import Image as _PILImage
        # Use RGBA so the masked (transparent) pixels stay transparent on the
        # final imshow, letting matplotlib's white axes background show through.
        arr = np.asarray(_PILImage.open(io.BytesIO(resp.content)).convert("RGBA"))
    except Exception:
        return None, {}

    return arr, {
        "min_lon": bmin_lon,
        "max_lon": bmax_lon,
        "min_lat": bmin_lat,
        "max_lat": bmax_lat,
    }


def _render_transect_figure(req: TransectFigureRequest) -> tuple[bytes, str]:
    """Render the multi-panel transect figure with matplotlib (shared x-axis).

    Returns (binary, media_type). Runs synchronously; call from an executor.
    """
    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap
    from matplotlib.ticker import FuncFormatter, MaxNLocator
    from mpl_toolkits.axes_grid1 import make_axes_locatable

    samples = req.samples
    if len(samples) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 transect samples to render figure")

    lons = np.array([s.lon for s in samples], dtype=float)
    lats = np.array([s.lat for s in samples], dtype=float)
    x_vals = lons if req.x_axis == "lon" else lats
    x_label = "Longitude" if req.x_axis == "lon" else "Latitude"

    # Panel selection (each becomes a row in plt.subplots).
    panels: List[str] = []
    height_ratios: List[float] = []
    if req.include_ee_annualchanges:
        # JRC TMF AnnualChanges sits at the very top of the figure (forest-class
        # context first, then the natural-colour satellite snapshot below).
        panels.append("ee_annualchanges")
        height_ratios.append(req.ee_annualchanges_height_px)
    if req.include_map:
        panels.append("map")
        height_ratios.append(req.map_height_px)
    if req.include_heatmap:
        panels.append("heatmap")
        height_ratios.append(req.heatmap_height_px)
    if req.include_enl_fhd:
        panels.append("enl_fhd")
        height_ratios.append(req.enl_fhd_height_px)
    if req.include_cr:
        panels.append("cr")
        height_ratios.append(req.cr_height_px)
    if not panels:
        raise HTTPException(status_code=400, detail="Select at least one panel to render")

    # ---- Layout DPI ------------------------------------------------------
    # Figure inch dimensions are computed from a FIXED layout DPI matching the
    # export DPI (150), NOT from `req.dpi`.  This way preview (req.dpi=90) and
    # export (req.dpi=150) produce IDENTICAL layouts — only the saved pixel
    # resolution differs (preview ≈ 720 px wide, export = `figure_width_px`).
    # Without this pin, preview and export have different physical figure
    # widths in inches and the same font/margins occupy different fractions,
    # so labels overlap differently.
    LAYOUT_DPI = 150
    fig_w_in = req.figure_width_px / LAYOUT_DPI

    # Margins in font-size-relative inches (DPI-independent).
    font_in = req.font_size / 72.0          # 1 em in inches
    left_in  = font_in * 10.0              # rotated ylabel + tick nums + padding
    right_in = font_in * 4.5              # colorbar label + pad
    top_in   = font_in * 1.0
    bot_in   = font_in * 0.5
    hsp_in   = font_in * 0.8              # gap between subplots (in inches)

    left_frac  = max(0.06, min(0.28, left_in  / fig_w_in))
    right_frac = max(0.04, min(0.18, right_in / fig_w_in))
    inner_frac = 1.0 - left_frac - right_frac

    # Fetch satellite image before creating the figure so we can auto-size the
    # map panel to preserve the image's geographic aspect ratio.  Uses the
    # actual computed inner_frac (not a hard-coded 0.85) so the panel height
    # matches what subplots_adjust will produce.
    sat_arr = None
    sat_meta: Optional[dict] = None
    if "map" in panels:
        _sat_lons = np.array([s.lon for s in samples], dtype=float)
        _sat_lats = np.array([s.lat for s in samples], dtype=float)
        _sat_bytes, sat_meta = _stitch_bbox_satellite(
            float(np.min(_sat_lons)),
            float(np.max(_sat_lons)),
            float(np.min(_sat_lats)),
            float(np.max(_sat_lats)),
            buffer_m=req.satellite_buffer_m,
            max_width_px=req.satellite_max_width_px,
        )
        if _sat_bytes is not None:
            from PIL import Image as _PILImage
            sat_arr = np.asarray(_PILImage.open(io.BytesIO(_sat_bytes)).convert("RGB"))
            # In a sharex grid, the rendered axes height for panel i is
            #   panel_h_in = X / LAYOUT_DPI × n / (n + (n-1)·hspace)
            # so for the map panel's inner rect to be inner_w × (img_h/img_w):
            #   X = figure_width_px × inner_frac × (img_h/img_w) × (n+(n-1)·hspace)/n
            # `hspace` itself depends on X via avg_panel_h, so we iterate twice.
            sat_aspect = sat_arr.shape[0] / sat_arr.shape[1]
            target_panel_px = req.figure_width_px * inner_frac * sat_aspect
            n_panels = len(panels)
            map_idx = panels.index("map")
            S_other = sum(height_ratios) - height_ratios[map_idx]
            auto_h = target_panel_px  # initial guess (no hspace correction)
            for _ in range(3):
                _avg_panel_h_in = ((auto_h + S_other) / LAYOUT_DPI) / max(1, n_panels)
                _hspace_est = max(0.10, min(0.60, hsp_in / _avg_panel_h_in))
                _correction = (n_panels + (n_panels - 1) * _hspace_est) / n_panels
                auto_h = target_panel_px * _correction
            height_ratios[map_idx] = max(60, int(round(auto_h)))

    # Optional JRC TMF AnnualChanges panel — same buffered bbox as the
    # satellite map, auto-sized using the same hspace-aware formula.
    ee_arr = None
    ee_meta: Optional[dict] = None
    if "ee_annualchanges" in panels:
        _ee_lons = np.array([s.lon for s in samples], dtype=float)
        _ee_lats = np.array([s.lat for s in samples], dtype=float)
        ee_arr, ee_meta = _fetch_ee_annualchanges_array(
            float(np.min(_ee_lons)),
            float(np.max(_ee_lons)),
            float(np.min(_ee_lats)),
            float(np.max(_ee_lats)),
            buffer_m=req.satellite_buffer_m,
            max_dimension=2048,
        )
        if ee_arr is not None:
            ee_aspect = ee_arr.shape[0] / ee_arr.shape[1]
            target_panel_px = req.figure_width_px * inner_frac * ee_aspect
            n_panels = len(panels)
            ee_idx = panels.index("ee_annualchanges")
            S_other = sum(height_ratios) - height_ratios[ee_idx]
            auto_h = target_panel_px
            for _ in range(3):
                _avg_panel_h_in = ((auto_h + S_other) / LAYOUT_DPI) / max(1, n_panels)
                _hspace_est = max(0.10, min(0.60, hsp_in / _avg_panel_h_in))
                _correction = (n_panels + (n_panels - 1) * _hspace_est) / n_panels
                auto_h = target_panel_px * _correction
            height_ratios[ee_idx] = max(60, int(round(auto_h)))

    total_h_px = sum(height_ratios)
    fig_h_in = total_h_px / LAYOUT_DPI
    avg_panel_h_in = fig_h_in / max(1, len(panels))

    # Axis labels (Latitude / Height (m) / ENL/FHD / CR / Longitude) use the
    # user-requested font size. Tick numerals on every axis (and the colorbar)
    # are 2 pt smaller so they sit visually subordinate to the labels.
    _tick_fs = max(6, req.font_size - 2)
    plt.rcParams["font.size"]        = req.font_size
    plt.rcParams["axes.labelsize"]   = req.font_size
    plt.rcParams["axes.titlesize"]   = req.font_size
    plt.rcParams["xtick.labelsize"]  = _tick_fs
    plt.rcParams["ytick.labelsize"]  = _tick_fs
    plt.rcParams["legend.fontsize"]  = _tick_fs

    fig, axes_obj = plt.subplots(
        len(panels),
        1,
        figsize=(fig_w_in, fig_h_in),
        gridspec_kw={"height_ratios": height_ratios},
        sharex=True,
    )
    axes = axes_obj if isinstance(axes_obj, np.ndarray) else np.array([axes_obj])

    fig.subplots_adjust(
        left   = left_frac,
        right  = 1.0 - right_frac,
        top    = 1.0 - max(0.01, top_in / fig_h_in),
        bottom = max(0.02, bot_in  / fig_h_in),
        hspace = max(0.03, min(0.40, hsp_in / avg_panel_h_in)),
    )

    # Reserve a colorbar-sized gutter on every panel so the heatmap's plotting
    # rectangle (x-axis) lines up exactly with map / ENL/FHD / CR panels.
    # Only the heatmap renders into its gutter; the others stay invisible.
    cbar_gutters = []
    for ax_obj in axes:
        divider = make_axes_locatable(ax_obj)
        cax = divider.append_axes("right", size="2%", pad=0.05)
        cax.set_visible(False)
        cbar_gutters.append(cax)

    # Colormap matching the frontend hsl-based ramp (blue → orange).
    n_steps = 256
    ramp_hsv = np.zeros((n_steps, 3))
    for i in range(n_steps):
        t = i / (n_steps - 1)
        hue_deg = 235 - 175 * t
        ramp_hsv[i] = [hue_deg / 360.0, 0.86, 0.28 + 0.34 * t]
    # HLS-style: convert by interpolating between l-based RGB. Use simple manual conversion.
    def _hsl_to_rgb(h_deg: float, s: float, l: float) -> tuple[float, float, float]:
        h = (h_deg % 360) / 360.0
        if s == 0:
            return l, l, l
        q = l * (1 + s) if l < 0.5 else l + s - l * s
        p = 2 * l - q
        def _h2c(t: float) -> float:
            if t < 0:
                t += 1
            if t > 1:
                t -= 1
            if t < 1 / 6:
                return p + (q - p) * 6 * t
            if t < 1 / 2:
                return q
            if t < 2 / 3:
                return p + (q - p) * (2 / 3 - t) * 6
            return p
        return _h2c(h + 1 / 3), _h2c(h), _h2c(h - 1 / 3)

    ramp_rgb = np.array([_hsl_to_rgb(235 - 175 * (i / (n_steps - 1)), 0.86, 0.28 + 0.34 * (i / (n_steps - 1))) for i in range(n_steps)])
    energy_cmap = LinearSegmentedColormap.from_list("transect_energy", ramp_rgb, N=n_steps)

    x_min = float(np.min(x_vals))
    x_max = float(np.max(x_vals))

    # ---- map panel ------------------------------------------------------
    if "map" in panels:
        ax = axes[panels.index("map")]
        if sat_arr is not None and sat_meta is not None:
            extent_lon = (sat_meta["min_lon"], sat_meta["max_lon"])
            extent_lat = (sat_meta["min_lat"], sat_meta["max_lat"])
            if req.x_axis == "lon":
                ax.imshow(
                    sat_arr,
                    extent=(extent_lon[0], extent_lon[1], extent_lat[0], extent_lat[1]),
                    aspect="auto",
                    origin="upper",
                    interpolation="bilinear",
                )
                ax.plot(lons, lats, color="#ff5252", linewidth=1.0)
                ax.set_ylabel("Lat.")
                ax.set_ylim(extent_lat[0], extent_lat[1])
                ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.3f}"))
                ax.yaxis.set_major_locator(MaxNLocator(nbins=2, prune="both"))
            else:
                ax.imshow(
                    np.transpose(sat_arr, (1, 0, 2))[::-1],
                    extent=(extent_lat[0], extent_lat[1], extent_lon[0], extent_lon[1]),
                    aspect="auto",
                    origin="upper",
                    interpolation="bilinear",
                )
                ax.plot(lats, lons, color="#ff5252", linewidth=1.0)
                ax.set_ylabel("Lon.")
                ax.set_ylim(extent_lon[0], extent_lon[1])
                ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.3f}"))
                ax.yaxis.set_major_locator(MaxNLocator(nbins=2, prune="both"))

            # ---- scale bar (lower-left of the satellite panel) ----------
            from matplotlib.patheffects import withStroke
            from matplotlib.transforms import blended_transform_factory

            mean_lat_rad = math.radians((float(np.min(lats)) + float(np.max(lats))) / 2.0)
            # Convert one unit of the panel's x-axis (lon or lat degrees) to meters.
            if req.x_axis == "lon":
                m_per_xunit = 111320.0 * max(1e-6, math.cos(mean_lat_rad))
            else:
                m_per_xunit = 111320.0
            visible_x_span = x_max - x_min
            visible_x_span_m = visible_x_span * m_per_xunit
            # Aim for a bar that's ~10% of the visible width, rounded to a nice
            # 1/2/5 × 10^k value (typical map scale-bar convention).
            target_m = visible_x_span_m * 0.10
            if target_m > 0:
                pow10 = 10 ** math.floor(math.log10(target_m))
                leading = target_m / pow10
                if leading < 1.5:
                    bar_m = 1.0 * pow10
                elif leading < 3.5:
                    bar_m = 2.0 * pow10
                elif leading < 7.5:
                    bar_m = 5.0 * pow10
                else:
                    bar_m = 10.0 * pow10
            else:
                bar_m = 100.0
            bar_xunit = bar_m / m_per_xunit

            bar_x0 = x_min + visible_x_span * 0.03
            bar_x1 = bar_x0 + bar_xunit
            bar_y_axes = 0.10  # 10% from bottom of the panel
            tick_h = 0.03
            trans = blended_transform_factory(ax.transData, ax.transAxes)
            halo = [withStroke(linewidth=2, foreground="white")]

            ax.plot(
                [bar_x0, bar_x1], [bar_y_axes, bar_y_axes],
                color="black", linewidth=1.0,
                transform=trans, solid_capstyle="butt",
                path_effects=halo, zorder=5,
            )
            for xv in (bar_x0, bar_x1):
                ax.plot(
                    [xv, xv], [bar_y_axes - tick_h, bar_y_axes + tick_h],
                    color="black", linewidth=1.0,
                    transform=trans, solid_capstyle="butt",
                    path_effects=halo, zorder=5,
                )
            label_text = (
                f"{int(bar_m)} m" if bar_m < 1000 else
                f"{bar_m / 1000:g} km"
            )
            ax.text(
                (bar_x0 + bar_x1) / 2.0,
                bar_y_axes + 0.04,
                label_text,
                transform=trans, ha="center", va="bottom",
                fontsize=max(5, req.font_size - 4),
                color="black",
                path_effects=halo, zorder=6,
            )
        else:
            ax.text(0.5, 0.5, "Satellite imagery unavailable", ha="center", va="center", transform=ax.transAxes)
            ax.set_yticks([])

    # ---- JRC TMF AnnualChanges panel ------------------------------------
    if "ee_annualchanges" in panels:
        ax = axes[panels.index("ee_annualchanges")]
        if ee_arr is not None and ee_meta is not None:
            ee_extent_lon = (ee_meta["min_lon"], ee_meta["max_lon"])
            ee_extent_lat = (ee_meta["min_lat"], ee_meta["max_lat"])
            if req.x_axis == "lon":
                ax.imshow(
                    ee_arr,
                    extent=(ee_extent_lon[0], ee_extent_lon[1], ee_extent_lat[0], ee_extent_lat[1]),
                    aspect="auto",
                    origin="upper",
                    interpolation="nearest",  # preserve sharp class boundaries
                )
                ax.plot(lons, lats, color="#ff5252", linewidth=1.0)
                ax.set_ylabel("Lat.")
                ax.set_ylim(ee_extent_lat[0], ee_extent_lat[1])
                ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.3f}"))
                ax.yaxis.set_major_locator(MaxNLocator(nbins=2, prune="both"))
            else:
                ax.imshow(
                    np.transpose(ee_arr, (1, 0, 2))[::-1],
                    extent=(ee_extent_lat[0], ee_extent_lat[1], ee_extent_lon[0], ee_extent_lon[1]),
                    aspect="auto",
                    origin="upper",
                    interpolation="nearest",
                )
                ax.plot(lats, lons, color="#ff5252", linewidth=1.0)
                ax.set_ylabel("Lon.")
                ax.set_ylim(ee_extent_lon[0], ee_extent_lon[1])
                ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.3f}"))
                ax.yaxis.set_major_locator(MaxNLocator(nbins=2, prune="both"))
            # Tiny corner annotation so the reader knows what they're looking at
            # (axis title would crowd into the panel above; do a small footer).
            ax.text(
                0.99, 0.04, "JRC TMF AnnualChanges · Dec 2020",
                transform=ax.transAxes, ha="right", va="bottom",
                fontsize=max(6, req.font_size - 4),
                color="#222",
                bbox=dict(facecolor="white", alpha=0.7, edgecolor="none", pad=1.2),
            )
        else:
            ax.text(
                0.5, 0.5,
                "JRC TMF AnnualChanges unavailable\n(Earth Engine not configured)",
                ha="center", va="center",
                transform=ax.transAxes,
                fontsize=max(7, req.font_size - 2),
                color="#666",
            )
            ax.set_yticks([])

    # ---- heatmap panel --------------------------------------------------
    if "heatmap" in panels:
        ax = axes[panels.index("heatmap")]
        max_h = max(1.0, req.heatmap_max_height_m)
        n_bins = max(
            1,
            max((len(s.profile) for s in samples), default=int(round(max_h / max(1.0, req.height_bin_m)))),
        )
        grid = np.full((n_bins, len(samples)), np.nan, dtype=float)
        for i, s in enumerate(samples):
            for p in s.profile:
                if p.missing or p.value is None:
                    continue
                rh = int(p.rh)
                if 0 <= rh < n_bins:
                    grid[rh, i] = float(p.value)
        # Y axis starts at 0 at bottom; matplotlib origin='lower' achieves that.
        z_min = float(np.nanmin(grid)) if np.isfinite(np.nanmin(grid)) else 0.0
        z_max = float(req.heatmap_colormap_max)
        # Build extent so x-axis maps directly to lon/lat (shared with all panels).
        # Place each sample at its actual coord; pcolormesh handles non-uniform spacing.
        x_edges = np.empty(len(samples) + 1)
        if len(samples) >= 2:
            mid = (x_vals[:-1] + x_vals[1:]) / 2.0
            x_edges[1:-1] = mid
            x_edges[0] = x_vals[0] - (mid[0] - x_vals[0])
            x_edges[-1] = x_vals[-1] + (x_vals[-1] - mid[-1])
        else:
            x_edges[:] = x_vals[0]
        y_edges = np.linspace(0, max_h, n_bins + 1)
        mesh = ax.pcolormesh(
            x_edges,
            y_edges,
            np.where(np.isnan(grid), np.nan, grid),
            cmap=energy_cmap,
            vmin=z_min,
            vmax=z_max,
            shading="auto",
            edgecolors="none",
            linewidth=0,
            antialiased=False,
            # PDF/SVG vector output renders each pcolormesh quad separately and
            # leaves visible hairline gaps between adjacent cells (the "grid"
            # lines the user sees in PDF). Rasterising just this artist embeds
            # the mesh as one image inside the PDF — eliminates the seams while
            # keeping every other element (axes, ticks, labels, lines) vector.
            rasterized=True,
        )
        ax.set_facecolor("#fafafa")
        ax.set_ylabel("Height (m)")
        ax.set_ylim(0, max_h)
        ax.grid(False)
        # Use the pre-reserved gutter so the heatmap's plot rectangle keeps
        # the same width as the other panels.
        cax = cbar_gutters[panels.index("heatmap")]
        cax.set_visible(True)
        cbar = fig.colorbar(mesh, cax=cax)
        cbar.set_label("Energy (%)")

    # ---- ENL/FHD panel --------------------------------------------------
    if "enl_fhd" in panels:
        ax = axes[panels.index("enl_fhd")]
        fhd = np.array([s.fhd if s.fhd is not None else np.nan for s in samples], dtype=float)
        enl1 = np.array([s.enl1d if s.enl1d is not None else np.nan for s in samples], dtype=float)
        enl2 = np.array([s.enl2d if s.enl2d is not None else np.nan for s in samples], dtype=float)
        if np.any(np.isfinite(fhd)):
            ax.plot(x_vals, fhd, label="FHD", color="#1f77b4", linewidth=1.5)
        if np.any(np.isfinite(enl1)):
            ax.plot(x_vals, enl1, label="1D ENL", color="#2ca02c", linewidth=1.5)
        if np.any(np.isfinite(enl2)):
            ax.plot(x_vals, enl2, label="2D ENL", color="#d62728", linewidth=1.5)
        ax.set_ylabel("ENL / FHD")
        ax.grid(True, linestyle=":", linewidth=0.6, alpha=0.5)

    # ---- CR panel -------------------------------------------------------
    if "cr" in panels:
        ax = axes[panels.index("cr")]
        cr = np.array([s.cr if s.cr is not None else np.nan for s in samples], dtype=float)
        if np.any(np.isfinite(cr)):
            ax.plot(x_vals, cr, color="#9467bd", linewidth=1.5, label="CR")
        ax.set_ylabel("CR")
        # Slight headroom above 1.0 so points sitting at CR=1 stay visible.
        ax.set_ylim(0, 1.1)
        ax.grid(True, linestyle=":", linewidth=0.6, alpha=0.5)

    # All sharex panels — only label the bottom-most.
    axes[-1].set_xlabel(x_label)
    axes[-1].set_xlim(x_min, x_max)
    # Sparse x-ticks (sharex propagates this to every panel above).
    axes[-1].xaxis.set_major_locator(MaxNLocator(nbins=5, prune="both"))
    axes[-1].xaxis.set_major_formatter(FuncFormatter(lambda v, _pos: f"{v:.3f}"))

    # Align all y-axis labels to the same x position so they form a neat column.
    fig.align_ylabels(list(axes))

    # Collect legend entries from all data panels in order: FHD / ENL / CR.
    legend_handles: list = []
    legend_labels: list = []
    for ax_obj in axes:
        h, l = ax_obj.get_legend_handles_labels()
        for hi, li in zip(h, l):
            if li not in legend_labels:
                legend_handles.append(hi)
                legend_labels.append(li)

    if legend_handles:
        # Anchor relative to the bottom-most axis so the legend always sits below
        # its x-label regardless of figure height. bbox_inches="tight" on save
        # will extend the canvas to include it.
        fig.legend(
            legend_handles,
            legend_labels,
            loc="upper center",
            bbox_to_anchor=(0.5, -0.8),
            bbox_transform=axes[-1].transAxes,
            ncol=len(legend_handles),
            frameon=False,
            fontsize=max(7, req.font_size - 2),
            handlelength=1.2,
            columnspacing=1.2,
            handletextpad=0.35,
        )
    for ax_obj in axes[:-1]:
        ax_obj.tick_params(axis='x', labelbottom=False, length=0)
    # Output buffer.
    buf = io.BytesIO()
    if req.fmt == "pdf":
        fig.savefig(buf, format="pdf", dpi=req.dpi, bbox_inches="tight", pad_inches=0.1)
        media_type = "application/pdf"
    elif req.fmt == "jpg":
        fig.savefig(buf, format="jpg", dpi=req.dpi, bbox_inches="tight", pad_inches=0.1, facecolor="white")
        media_type = "image/jpeg"
    else:
        fig.savefig(buf, format="png", dpi=req.dpi, bbox_inches="tight", pad_inches=0.1, facecolor="white")
        media_type = "image/png"
    plt.close(fig)
    return buf.getvalue(), media_type


@router.post("/transect/figure")
async def transect_figure(req: TransectFigureRequest):
    """Render the full transect figure (map + heatmap + metrics) as one image.

    All panels share the same x-axis (longitude or latitude) by construction
    via matplotlib's `sharex=True`, so longitudes line up exactly without any
    margin gymnastics on the frontend.
    """
    import asyncio

    loop = asyncio.get_event_loop()
    payload, media_type = await loop.run_in_executor(None, lambda: _render_transect_figure(req))
    suffix = {"image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf"}.get(media_type, "bin")
    return Response(
        content=payload,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="transect-figure.{suffix}"'},
    )


@router.get("/saved-features/image/{relative_path:path}")
async def get_saved_feature_image(relative_path: str):
    if not relative_path or relative_path.strip() == "":
        raise HTTPException(status_code=400, detail="Image path is required")
    candidate = (IMAGE_ROOT / relative_path).resolve()
    root = IMAGE_ROOT.resolve()
    if root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Invalid image path")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    media_type = "image/jpeg" if candidate.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    return FileResponse(candidate, media_type=media_type)
