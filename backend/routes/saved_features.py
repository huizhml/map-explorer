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

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
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
