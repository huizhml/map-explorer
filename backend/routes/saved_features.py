"""Persistent storage for user-saved map features."""

from __future__ import annotations

from datetime import datetime, timezone
import io
import json
import os
import sqlite3
from pathlib import Path
import re
from typing import Any, Dict, List, Literal, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import numpy as np
import rasterio
from rasterio.windows import from_bounds, Window
from rasterio.warp import transform_bounds


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
    metadata_json = json.dumps(payload.metadata) if payload.metadata is not None else None
    plot_data_json = json.dumps(payload.plot_data) if payload.plot_data is not None else None

    if not name:
        raise HTTPException(status_code=400, detail="Feature name is required")

    with _db_connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO saved_features (name, description, category, geometry_type, geometry_json, metadata_json, plot_data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        cursor = conn.execute(
            """
            INSERT INTO saved_features (name, description, category, geometry_type, geometry_json, metadata_json, plot_data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
