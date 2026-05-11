"""Per-layer matplotlib rendering for the /saved-features/area-images endpoint.

Splits a Web-Mercator AABB across one or more raster layers (single-band or
RGB / multi-band) and writes a PNG/JPG figure per layer into the saved
feature's session directory.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import rasterio
from rasterio.warp import transform_bounds

from .models import FigureLayerSpec, SaveAreaImagesRequest
from .utils import clip_window, image_url_for, sanitize_name


# Frontend → matplotlib colormap names. Anything not listed is passed through
# to matplotlib unchanged (which silently falls back to "viridis" if invalid).
_TITILER_TO_MPL_CMAP = {
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


def _resolve_cmap(name: Optional[str]) -> str:
    if not name:
        return "viridis"
    return _TITILER_TO_MPL_CMAP.get(name, name)


def _read_as_float(src, window, indexes=None) -> np.ndarray:
    kwargs: Dict[str, Any] = {"window": window}
    if indexes is not None:
        kwargs["indexes"] = indexes
    raw = src.read(**kwargs).astype(np.float32)
    nodata = src.nodata
    if nodata is not None:
        raw[raw == nodata] = np.nan
    return raw


def _resolve_single_band_range(
    arr: np.ndarray, low: Optional[float], high: Optional[float],
) -> Tuple[float, float]:
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


def _normalize_rgb_percentile(rgb: np.ndarray) -> np.ndarray:
    """Auto-stretch each channel to its 2–98 percentile (true-colour default)."""
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
        out[i] = np.clip((band - lo) / (hi - lo), 0.0, 1.0)
    return np.transpose(out, (1, 2, 0))


def _normalize_rgb_with_range(
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


def _resolve_rgb_indexes(src, requested: Optional[List[int]], prefer_sentinel_rgb: bool) -> List[int]:
    if (
        requested
        and len(requested) == 3
        and all(isinstance(v, int) and 1 <= v <= src.count for v in requested)
    ):
        return requested
    if prefer_sentinel_rgb and src.count >= 4:
        return [4, 3, 2]
    return [1, 2, 3]


def render_area_images(
    payload: SaveAreaImagesRequest,
    session_dir: Path,
    session_dir_name: str,
    location_tag: str,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    """Render every requested layer into `session_dir` and return
    (image_exports, render_errors). Caller is responsible for the satellite
    overlay (handled separately because it shares utilities with auxiliary.py).
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.axes_grid1 import make_axes_locatable

    xmin, ymin, xmax, ymax = [float(v) for v in payload.extent_3857]

    def _render_one_bytes(
        src, window, title: str, file_name: str, cmap: Optional[str],
        rmin: Optional[float], rmax: Optional[float], band_idx: Optional[int],
        prefer_sentinel_rgb: bool = False, rgb_bands: Optional[List[int]] = None,
    ) -> bytes:
        fig, ax = plt.subplots(figsize=(8, 8), dpi=160)
        ax.set_axis_off()
        ax.set_title(title, fontsize=11)

        if band_idx is not None:
            data = _read_as_float(src, window, indexes=band_idx)
        elif src.count >= 3 and cmap is None:
            rgb_indexes = _resolve_rgb_indexes(src, rgb_bands, prefer_sentinel_rgb)
            rgb = _read_as_float(src, window, indexes=rgb_indexes)
            if prefer_sentinel_rgb:
                if rmin is not None and rmax is not None:
                    rendered = _normalize_rgb_with_range(
                        rgb, float(rmin), float(rmax), gamma=1.25, brightness=1.15,
                    )
                else:
                    valid = rgb[np.isfinite(rgb)]
                    auto_high = 255.0
                    if valid.size > 0 and float(np.nanmax(valid)) > 255.0:
                        auto_high = 2500.0
                    rendered = _normalize_rgb_with_range(
                        rgb, 0.0, auto_high, gamma=1.25, brightness=1.15,
                    )
                ax.imshow(rendered)
            else:
                ax.imshow(_normalize_rgb_percentile(rgb))
            buf = io.BytesIO()
            fig.savefig(buf, format=payload.format, bbox_inches="tight", pad_inches=0.05)
            plt.close(fig)
            return buf.getvalue()
        else:
            data = _read_as_float(src, window, indexes=1)

        low, high = _resolve_single_band_range(data, rmin, rmax)
        im = ax.imshow(data, cmap=_resolve_cmap(cmap), vmin=low, vmax=high)
        divider = make_axes_locatable(ax)
        cax = divider.append_axes("right", size="5%", pad=0.15)
        cbar = fig.colorbar(im, cax=cax)
        cbar.ax.tick_params(labelsize=8)
        buf = io.BytesIO()
        fig.savefig(buf, format=payload.format, bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        return buf.getvalue()

    image_exports: List[Dict[str, Any]] = []
    render_errors: List[Dict[str, str]] = []
    mime_type = f"image/{'jpeg' if payload.format == 'jpg' else payload.format}"

    def _record_export(file_name: str, layer: FigureLayerSpec, band_name: Optional[str] = None) -> None:
        relative_path = str(Path(session_dir_name) / file_name)
        entry: Dict[str, Any] = {
            "layer_id": layer.layer_id,
            "layer_name": layer.name,
            "filename": file_name,
            "relative_path": relative_path,
            "url": image_url_for(relative_path),
            "format": payload.format,
            "mime_type": mime_type,
        }
        if band_name is not None:
            entry["band_name"] = band_name
        image_exports.append(entry)

    for layer in payload.layers:
        try:
            is_sentinel = layer.layer_type == "sentinel2"
            with rasterio.open(layer.url) as src:
                src_bounds = transform_bounds(
                    "EPSG:3857", src.crs, xmin, ymin, xmax, ymax, densify_pts=21,
                )
                window = clip_window(src, *src_bounds)
                if window.width <= 0 or window.height <= 0:
                    raise ValueError("Selection does not overlap layer extent.")

                if layer.bands and len(layer.bands) > 0:
                    for band in layer.bands:
                        band_name = band.band_name or f"band{band.band_index}"
                        title = f"{layer.name} — {band_name}"
                        file_name = (
                            f"{sanitize_name(layer.name)}_"
                            f"{sanitize_name(location_tag)}_"
                            f"{sanitize_name(band_name)}.{payload.format}"
                        )
                        image_bytes = _render_one_bytes(
                            src, window, title, file_name,
                            band.colormap if band.colormap is not None else layer.colormap,
                            band.rescale_min if band.rescale_min is not None else layer.rescale_min,
                            band.rescale_max if band.rescale_max is not None else layer.rescale_max,
                            band.band_index, is_sentinel, layer.rgb_bands,
                        )
                        (session_dir / file_name).write_bytes(image_bytes)
                        _record_export(file_name, layer, band_name=band_name)
                else:
                    file_name = (
                        f"{sanitize_name(layer.name)}_"
                        f"{sanitize_name(location_tag)}.{payload.format}"
                    )
                    image_bytes = _render_one_bytes(
                        src, window, layer.name, file_name,
                        layer.colormap, layer.rescale_min, layer.rescale_max,
                        None, is_sentinel, layer.rgb_bands,
                    )
                    (session_dir / file_name).write_bytes(image_bytes)
                    _record_export(file_name, layer)
        except Exception as exc:
            render_errors.append({"layer_id": layer.layer_id, "name": layer.name, "error": str(exc)})

    return image_exports, render_errors
