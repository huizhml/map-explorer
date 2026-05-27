"""75 m-buffered snapshot extractors used when saving popup-point features.

Three independent layers are rendered around a saved Point:

- Google Satellite basemap (no API key needed — falls back through tile providers)
- RH98 canopy-height prediction (local MGRS tile or remote COG)
- EOX s2cloudless cloud-free Sentinel-2 mosaic for the point's year (always
  fetched, independent of any Sentinel-2 layer loaded on the map)

Each extractor returns a `({export_dict | None}, error_str | None)` tuple so the
caller can log / persist the failure without aborting the rest of the save.
"""

from __future__ import annotations

import io
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from pyproj import Transformer
import rasterio
from rasterio.warp import transform_bounds
import requests

from .utils import clip_window, image_url_for, new_session_dir, sanitize_name


# ---------------------------------------------------------------------------
# Google satellite point snapshot
# ---------------------------------------------------------------------------

def _sanitize_error_message(msg: str) -> str:
    # Never persist raw API keys in metadata / log-like fields.
    return re.sub(r"(key=)[^&\s]+", r"\1<redacted>", msg)


def _extract_google_point_snapshot(
    lon: float,
    lat: float,
    buffer_m: float = 75.0,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    # Aim for a crisp square snapshot around the point.
    width_px = 1024
    target_span_m = max(10.0, buffer_m * 2.0)
    meters_per_pixel = target_span_m / width_px
    lat_rad = math.radians(lat)
    meters_per_pixel_at_zoom0 = 156543.03392 * max(0.1, math.cos(lat_rad))
    zoom = int(math.floor(math.log2(meters_per_pixel_at_zoom0 / max(0.01, meters_per_pixel))))
    zoom = max(0, min(20, zoom))

    google_key = os.environ.get("GOOGLE_STATIC_MAPS_API_KEY", "").strip()

    def _lonlat_to_pixel(lon_v: float, lat_v: float, z_v: int) -> Tuple[float, float]:
        siny = math.sin(math.radians(lat_v))
        siny = min(max(siny, -0.9999), 0.9999)
        world = 256 * (2 ** z_v)
        x = (lon_v + 180.0) / 360.0 * world
        y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * world
        return x, y

    def _stitch_xyz_tiles(url_builder, provider_name: str) -> Optional[Tuple[bytes, str]]:
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
        image_bytes: Optional[bytes] = None
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
                if "image/" in resp.headers.get("content-type", ""):
                    image_bytes = resp.content
                    provider = "google_static_maps"
            except Exception:
                image_bytes = None  # fall through to tile fallbacks

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

        session_dir, session_dir_name = new_session_dir()
        fname = f"google_satellite_point75m_{sanitize_name(f'{lat:.5f}_{lon:.5f}')}.png"
        out_path = session_dir / fname
        out_path.write_bytes(image_bytes)

        relative_path = str(Path(session_dir_name) / fname)
        return {
            "layer_id": "google_satellite",
            "layer_name": "Google Satellite",
            "filename": fname,
            "relative_path": relative_path,
            "url": image_url_for(relative_path),
            "format": "png",
            "mime_type": "image/png",
            "buffer_m": buffer_m,
            "zoom": zoom,
            "provider": provider,
        }, None
    except Exception as exc:
        return None, _sanitize_error_message(f"{type(exc).__name__}:{exc}")[:300]


# ---------------------------------------------------------------------------
# RH98 prediction snapshot
# ---------------------------------------------------------------------------

def _prediction_rh98_url_for_point(
    lat: float,
    lon: float,
    year: int,
    version: str,
    q_index: int,
    tile_name: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    tile = (tile_name or "").strip().upper()
    if not tile:
        return None, None, "missing_tile_name_for_prediction_snapshot"

    rh_index = 98
    # Unified local template (full absolute path with {version}, {tile}, {rh}, {q}).
    # Replaces the old split base + relative-template pair.
    local_tpl = os.environ.get("PREDICTIONS_LOCAL_PATH", "")
    remote_tpl = os.environ.get(
        "PREDICTIONS_REMOTE_PATH_TEMPLATE", "{zone}-{year}/{tile}/RH{rh}_Q{q}.tif"
    )
    remote_base = os.environ.get("PREDICTIONS_BASE_URL", "")
    zone = tile[:3].lower() if len(tile) >= 3 else tile.lower()

    try:
        if year == 2020:
            if not local_tpl:
                return None, tile, "predictions_local_path_not_set"
            path = local_tpl.format(tile=tile, rh=rh_index, q=q_index, version=version, year=year)
            if not os.path.isfile(path):
                return None, tile, "prediction_rh98_file_not_found"
            return path, tile, None

        if not remote_base:
            return None, tile, "predictions_remote_base_not_set"
        rel = remote_tpl.format(zone=zone, year=year, tile=tile, rh=rh_index, q=q_index, version=version)
        return remote_base.rstrip("/") + "/" + rel.lstrip("/"), tile, None
    except Exception as exc:
        return None, tile, f"prediction_path_error:{type(exc).__name__}"


_MGRS_TILE_RE = re.compile(r"^\d{1,3}[CDEFGHJKLMNPQRSTUVWX][ABCDEFGHJKLMNPQRSTUVWXYZ]{2}$")
_MGRS_TILE_SHORT_RE = re.compile(r"^\d{1,2}[CDEFGHJKLMNPQRSTUVWX][ABCDEFGHJKLMNPQRSTUVWXYZ]{2}$")


def _normalize_mgrs_tile(value: str) -> Optional[str]:
    candidate = value.strip().upper()
    if not _MGRS_TILE_RE.match(candidate):
        return None
    if _MGRS_TILE_SHORT_RE.match(candidate):
        zone = int(candidate[:2])
        return f"{zone:02d}{candidate[2:]}"
    return candidate


def _resolve_prediction_tile_name(
    metadata_payload: Dict[str, Any],
    lat: float,
    lon: float,
) -> Optional[str]:
    # 1) Explicit tile_name in metadata
    tile_name = metadata_payload.get("tile_name")
    if isinstance(tile_name, str) and tile_name.strip():
        normalized = _normalize_mgrs_tile(tile_name)
        if normalized:
            return normalized

    # 2) Common tile keys in saved feature properties
    feature_props = metadata_payload.get("feature_properties")
    if isinstance(feature_props, dict):
        for key in ("tile_name", "tile", "mgrs_tile", "name", "Name"):
            value = feature_props.get(key)
            if isinstance(value, str) and value.strip():
                normalized = _normalize_mgrs_tile(value)
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
    version: str,
    q_index: int,
    tile_name: Optional[str] = None,
    buffer_m: float = 75.0,
    rescale_min: Optional[float] = None,
    rescale_max: Optional[float] = None,
    colormap: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    path_or_url, resolved_tile, url_error = _prediction_rh98_url_for_point(
        lat, lon, year, version, q_index, tile_name,
    )
    if not path_or_url:
        return None, url_error or "prediction_path_unavailable"

    # Match the live map visualization defaults so the saved snapshot looks
    # the same as what the user sees on the map. The frontend renders RH98
    # tiles with inferno over 0..500 (raw integer units = 0.1 m per count,
    # i.e. 0..50 m canopy) — see src/constants/predictions.ts
    # (FALLBACK_RESCALE_MAX = 500). The previous implementation stretched
    # against the local 2..98 percentile of the 150 m window, which made the
    # saved image saturate completely differently from the on-screen layer.
    lo = float(rescale_min) if rescale_min is not None and np.isfinite(float(rescale_min)) else 0.0
    hi = float(rescale_max) if rescale_max is not None and np.isfinite(float(rescale_max)) else 500.0
    if hi <= lo:
        hi = lo + 1.0
    cmap_name = (colormap or "inferno").strip() or "inferno"

    try:
        with rasterio.open(path_or_url) as src:
            # The MGRS prediction tiles are stored in their local UTM CRS,
            # whose units are true ground meters. Build the buffer directly
            # in that CRS so `buffer_m` is honored as a ground-meter half-side.
            # Routing through EPSG:3857 first would shrink the box by cos(lat)
            # (Web Mercator units are stretched by 1/cos(lat)) and produce an
            # anisotropic AABB that no longer matches the satellite snapshot's
            # 75 m buffer.
            to_utm = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True)
            center_x, center_y = to_utm.transform(lon, lat)
            xmin, ymin = center_x - buffer_m, center_y - buffer_m
            xmax, ymax = center_x + buffer_m, center_y + buffer_m

            window = clip_window(src, xmin, ymin, xmax, ymax)
            if window.width <= 0 or window.height <= 0:
                return None, "prediction_window_outside_extent"

            arr = src.read(indexes=1, window=window).astype(np.float32)
            nodata = src.nodata
            if nodata is not None:
                arr[arr == nodata] = np.nan
            # Sentinel values used by the pipeline for missing/invalid pixels.
            arr[np.isin(arr, [32767.0, 32768.0, -9999.0])] = np.nan
            if not np.any(np.isfinite(arr)):
                return None, "prediction_window_all_nodata"

            norm = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)

        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
        except Exception:
            return None, "matplotlib_unavailable"

        session_dir, session_dir_name = new_session_dir()
        fname = f"prediction_rh98_q{q_index}_point75m_{sanitize_name(f'{lat:.5f}_{lon:.5f}')}.png"
        out_path = session_dir / fname

        fig, ax = plt.subplots(figsize=(4, 4), dpi=180)
        ax.set_axis_off()
        ax.imshow(norm, cmap=cmap_name, vmin=0.0, vmax=1.0)
        fig.savefig(out_path, format="png", bbox_inches="tight", pad_inches=0.03)
        plt.close(fig)

        relative_path = str(Path(session_dir_name) / fname)
        return {
            "layer_id": f"prediction_rh98_q{q_index}",
            "layer_name": f"Prediction RH98 (Q{q_index})",
            "filename": fname,
            "relative_path": relative_path,
            "url": image_url_for(relative_path),
            "format": "png",
            "mime_type": "image/png",
            "buffer_m": buffer_m,
            "year": year,
            "q_index": q_index,
            "tile_name": resolved_tile,
            # Resolved source TIF the snapshot was extracted from. Local
            # absolute path for 2020, COG URL otherwise. Persisted so the
            # saved record can re-open the underlying tile without re-running
            # the resolver (which depends on env templates that may change).
            "tile_file_path": path_or_url,
            "version": version,
            "rescale_min": lo,
            "rescale_max": hi,
            "colormap": cmap_name,
            # Per-render timestamp used by the frontend as a cache-buster (the
            # output filename is stable, so the URL is identical across re-renders
            # — React + the browser would otherwise show the stale image).
            "rendered_at": datetime.now(timezone.utc).isoformat(),
        }, None
    except Exception as exc:
        return None, f"{type(exc).__name__}:{exc}"


# ---------------------------------------------------------------------------
# Sentinel-2 point snapshot(s)
# ---------------------------------------------------------------------------

def _extract_sentinel2_point_snapshots(
    lon: float,
    lat: float,
    sentinel_layers: List[Dict[str, Any]],
    buffer_m: float = 75.0,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
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
                src_bounds = transform_bounds(
                    "EPSG:3857", src.crs, xmin, ymin, xmax, ymax, densify_pts=21,
                )
                window = clip_window(src, *src_bounds)
                if window.width <= 0 or window.height <= 0:
                    raise ValueError("selection_outside_extent")

                requested_rgb = layer.get("rgb_bands")
                if isinstance(requested_rgb, list) and len(requested_rgb) >= 3:
                    rgb_bands = [int(requested_rgb[0]), int(requested_rgb[1]), int(requested_rgb[2])]
                elif src.count >= 4:
                    # Default Sentinel-2 true-color composite when no metadata is available.
                    rgb_bands = [4, 3, 2]
                else:
                    rgb_bands = [1, 2, 3]

                rgb_bands = [
                    b for b in rgb_bands
                    if isinstance(b, int) and 1 <= b <= src.count
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

            session_dir, session_dir_name = new_session_dir()
            layer_name = str(layer.get("name") or f"sentinel2_{idx + 1}")
            fname = (
                f"sentinel2_point75m_{sanitize_name(layer_name)}_"
                f"{sanitize_name(f'{lat:.5f}_{lon:.5f}')}.png"
            )
            out_path = session_dir / fname
            Image.fromarray((np.clip(img, 0.0, 1.0) * 255).astype(np.uint8)).save(
                out_path, format="PNG",
            )

            relative_path = str(Path(session_dir_name) / fname)
            exports.append({
                "layer_id": str(layer.get("id") or f"sentinel2_{idx + 1}"),
                "layer_name": layer_name,
                "filename": fname,
                "relative_path": relative_path,
                "url": image_url_for(relative_path),
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


# ---------------------------------------------------------------------------
# EOX s2cloudless point snapshot (always-on Sentinel-2 reference)
# ---------------------------------------------------------------------------

# EOX publishes the s2cloudless cloud-free mosaic for these years only
# (tiles.maps.eox.at). Mirrors EOX_S2CLOUDLESS_YEARS in src/components/Sidebar.tsx.
_EOX_S2CLOUDLESS_YEARS = (2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024)


def _nearest_eox_year(year: int) -> int:
    """Snap an arbitrary year to the closest published EOX s2cloudless year.
    Ties resolve to the more recent year (generally better imagery)."""
    return min(_EOX_S2CLOUDLESS_YEARS, key=lambda y: (abs(y - int(year)), -y))


def _extract_eox_s2cloudless_point_snapshot(
    lon: float,
    lat: float,
    year: int,
    buffer_m: float = 75.0,
    brightness: float = 1.3,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Stitch the EOX ``s2cloudless-<year>`` cloud-free mosaic around a saved
    point so every popup-saved Point gets a Sentinel-2 reference image even
    when no Sentinel-2 layer is loaded on the map.

    The requested ``year`` is snapped to the nearest year EOX actually
    publishes. Framing/return shape mirror ``_extract_google_point_snapshot``
    (a 2×``buffer_m`` square), so the saved tile lines up with the Google /
    RH98 snapshots.
    """
    from .satellite import _stitch_bbox_eox_s2cloudless

    try:
        eox_year = _nearest_eox_year(year)
        # Degenerate point bbox: the stitcher adds `buffer_m` on every side,
        # yielding a 2*buffer_m square that matches the other point snapshots.
        sat_bytes, sat_meta = _stitch_bbox_eox_s2cloudless(
            lon, lon, lat, lat,
            buffer_m=buffer_m, max_width_px=1024, year=eox_year,
        )
        if not sat_bytes:
            return None, f"eox_s2cloudless_fetch_failed_year_{eox_year}"

        from PIL import Image

        img = Image.open(io.BytesIO(sat_bytes)).convert("RGB")

        # EOX s2cloudless JPEGs read dark over forest canopy; lift with the
        # same inverse-gamma the transect / area-image exports apply.
        if brightness and brightness > 0 and abs(brightness - 1.0) > 1e-3:
            arr = np.asarray(img).astype(np.float32) / 255.0
            arr = np.clip(arr ** (1.0 / float(brightness)), 0.0, 1.0)
            img = Image.fromarray((arr * 255.0).astype(np.uint8))

        session_dir, session_dir_name = new_session_dir()
        fname = (
            f"sentinel2_eox_s2cloudless_{eox_year}_point75m_"
            f"{sanitize_name(f'{lat:.5f}_{lon:.5f}')}.png"
        )
        out_path = session_dir / fname
        img.save(out_path, format="PNG")

        relative_path = str(Path(session_dir_name) / fname)
        return {
            "layer_id": "sentinel2_eox_s2cloudless",
            "layer_name": f"Sentinel-2 cloudless {eox_year} (EOX)",
            "filename": fname,
            "relative_path": relative_path,
            "url": image_url_for(relative_path),
            "format": "png",
            "mime_type": "image/png",
            "buffer_m": buffer_m,
            "source": "eox_s2cloudless",
            "requested_year": int(year),
            "year": eox_year,
            "zoom": sat_meta.get("zoom"),
            "brightness": float(brightness),
        }, None
    except Exception as exc:
        return None, _sanitize_error_message(f"{type(exc).__name__}:{exc}")[:300]
