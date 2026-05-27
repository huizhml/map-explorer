"""Per-layer matplotlib rendering for the /saved-features/area-images endpoint.

Splits a Web-Mercator AABB across one or more raster layers (single-band or
RGB / multi-band) and writes a PNG/JPG figure per layer into the saved
feature's session directory.
"""

from __future__ import annotations

import io
import re
from datetime import datetime, timezone
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


# MGRS tile identifier embedded in RH prediction COG paths (e.g.
# `.../2020/original/12SWD/RH98_Q1.tif` or `…/12-2022/12SWD/RH98_Q1.tif`).
# Matched anywhere in the URL/path so we can attach tile traceability to
# the saved per-image record without re-running the lat/lon → MGRS resolver.
_MGRS_TILE_IN_PATH_RE = re.compile(
    r"(?<![A-Z0-9])"
    r"(\d{1,3}[CDEFGHJKLMNPQRSTUVWX][ABCDEFGHJKLMNPQRSTUVWXYZ]{2})"
    r"(?![A-Z0-9])"
)


def _extract_mgrs_tile_from_path(path_or_url: Optional[str]) -> Optional[str]:
    """Best-effort MGRS tile extraction from a prediction COG path or URL.

    Returns the matched tile in canonical form (zero-padded 2-digit zone)
    or None when no tile-shaped segment is present.
    """
    if not path_or_url:
        return None
    m = _MGRS_TILE_IN_PATH_RE.search(path_or_url.upper())
    if not m:
        return None
    candidate = m.group(1)
    if len(candidate) >= 4 and candidate[1].isdigit():
        return candidate  # 3-digit zone (rare)
    return f"{int(candidate[:1]):02d}{candidate[1:]}" if len(candidate) == 4 else candidate


def _save_fig_with_preview(
    fig,
    fmt: str,
    save_kwargs: Optional[Dict[str, Any]] = None,
) -> Tuple[bytes, Optional[bytes]]:
    """Save `fig` to `fmt`; if `fmt == "pdf"`, also rasterize the same figure
    to PNG (using identical layout kwargs) and return it as a sibling preview.
    Closes the figure either way.

    Browser PDF embeds clip the page and add toolbars/scrollbars, which made
    multi-panel saved PDFs unreadable in the gallery. The sibling PNG renders
    inline cleanly at natural aspect while the PDF stays as the download
    artifact.
    """
    import matplotlib.pyplot as plt

    kwargs = dict(save_kwargs or {})
    primary_buf = io.BytesIO()
    fig.savefig(primary_buf, format=fmt, **kwargs)
    preview_bytes: Optional[bytes] = None
    if fmt == "pdf":
        preview_buf = io.BytesIO()
        fig.savefig(preview_buf, format="png", **kwargs)
        preview_bytes = preview_buf.getvalue()
    plt.close(fig)
    return primary_buf.getvalue(), preview_bytes


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


def _draw_axes_scale_bar(fig, ax, img_w_px: int, sat_meta: Dict[str, Any]) -> None:
    """Draw a restrained metric scale bar in the lower-left of an image axes.

    Shared by the tile-stitched image paths (currently Earth Engine). Mirrors the
    EOX mosaic bar: thin black line with a white halo, short end ticks, label
    centred above, sized in axes fractions so it stays proportionate at any
    source resolution. Decorative — callers wrap this so a failure never blocks
    the export.
    """
    import math
    from matplotlib.patheffects import withStroke
    from matplotlib.transforms import blended_transform_factory

    from .utils import nice_bar_length_m, step_up_bar_length_m

    min_lon = float(sat_meta.get("min_lon", 0.0))
    max_lon = float(sat_meta.get("max_lon", 0.0))
    min_lat = float(sat_meta.get("min_lat", 0.0))
    max_lat = float(sat_meta.get("max_lat", 0.0))
    mean_lat_rad = math.radians((min_lat + max_lat) / 2.0)
    span_m = (max_lon - min_lon) * 111320.0 * max(1e-6, math.cos(mean_lat_rad))
    if span_m <= 0 or img_w_px <= 0:
        return

    bar_m = nice_bar_length_m(span_m * 0.12) or 100.0
    bar_m = step_up_bar_length_m(bar_m)
    bar_px = bar_m / span_m * img_w_px
    bar_x0 = img_w_px * 0.03
    bar_x1 = bar_x0 + bar_px
    bar_y_axes = 0.05
    tick_h = 0.05
    line_halo = [withStroke(linewidth=14, foreground="white")]
    text_halo = [withStroke(linewidth=6, foreground="black")]
    trans = blended_transform_factory(ax.transData, ax.transAxes)

    ax.plot(
        [bar_x0, bar_x1], [bar_y_axes, bar_y_axes],
        color="black", linewidth=7, solid_capstyle="butt",
        transform=trans, path_effects=line_halo, zorder=5,
    )
    for xv in (bar_x0, bar_x1):
        ax.plot(
            [xv, xv], [bar_y_axes - tick_h, bar_y_axes + tick_h],
            color="black", linewidth=7, solid_capstyle="butt",
            transform=trans, path_effects=line_halo, zorder=5,
        )
    label_text = f"{int(bar_m)} m" if bar_m < 1000 else f"{bar_m / 1000:g} km"
    label_cx = (bar_x0 + bar_x1) / 2.0
    txt = ax.text(
        label_cx, bar_y_axes + tick_h + 0.03, label_text,
        transform=trans, ha="center", va="bottom",
        fontsize=34, color="white", path_effects=text_halo, zorder=6,
    )
    # Nudge the label back inside the frame only when a short bar would let it
    # spill past the image edge (mirrors the EOX / Google PNG paths).
    try:
        renderer = fig.canvas.get_renderer()
        bbox = txt.get_window_extent(renderer=renderer)
        inv = ax.transData.inverted()
        x_l = inv.transform((bbox.x0, bbox.y0))[0]
        x_r = inv.transform((bbox.x1, bbox.y0))[0]
        x_min, x_max = sorted(ax.get_xlim())
        pad = (x_max - x_min) * 0.01
        if x_l < x_min + pad:
            txt.set_x(label_cx + (x_min + pad - x_l))
        elif x_r > x_max - pad:
            txt.set_x(label_cx - (x_r - (x_max - pad)))
    except Exception:
        pass  # renderer unavailable — leave the label centred


def render_xyz_tile_figure(
    tile_url: str,
    wgs_xmin: float,
    wgs_xmax: float,
    wgs_ymin: float,
    wgs_ymax: float,
    fmt: str,
    draw_scale_bar: bool = True,
    max_width_px: int = 4096,
    max_zoom: int = 18,
) -> Tuple[bytes, Optional[bytes]]:
    """Stitch a Web-Mercator XYZ tile layer for a WGS84 bbox and render it to
    `fmt` (png/jpg/pdf) via matplotlib, with an optional vector scale bar.

    Used for Earth Engine layers, whose imagery is served as ``{z}/{x}/{y}``
    tiles with the visualization already baked in — there is no colormap /
    rescale to apply, we just composite the tiles. PNG output preserves the EE
    alpha mask (transparent nodata); JPEG is flattened over white.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image

    from .satellite import _stitch_bbox_xyz

    tile_bytes, tile_meta = _stitch_bbox_xyz(
        tile_url,
        float(wgs_xmin), float(wgs_xmax), float(wgs_ymin), float(wgs_ymax),
        buffer_m=0.0, max_width_px=max_width_px, max_zoom=max_zoom,
    )
    if tile_bytes is None:
        raise ValueError("Tile fetch returned no imagery for the selection.")

    rgba = np.asarray(Image.open(io.BytesIO(tile_bytes)).convert("RGBA"))
    if fmt == "jpg":
        # JPEG has no alpha channel — flatten the transparent (masked) pixels
        # over white so they don't render as black.
        rgb = rgba[..., :3].astype(np.float32)
        alpha = rgba[..., 3:4].astype(np.float32) / 255.0
        arr_disp = (rgb * alpha + 255.0 * (1.0 - alpha)).astype(np.uint8)
    else:
        arr_disp = rgba

    render_dpi = 300 if fmt == "pdf" else 240
    h_px, w_px = arr_disp.shape[:2]
    fig_w_in = 10.0
    fig_h_in = max(0.5, fig_w_in * (h_px / max(1, w_px)))
    fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=render_dpi)
    ax = fig.add_axes([0, 0, 1, 1])  # axes fills the figure → no margins
    ax.set_axis_off()
    ax.imshow(arr_disp, interpolation="bilinear", aspect="auto")

    if draw_scale_bar:
        try:
            _draw_axes_scale_bar(fig, ax, w_px, tile_meta)
        except Exception:
            pass  # scale bar is decorative; never block the export

    save_kwargs: Dict[str, Any] = {"pad_inches": 0}
    if fmt == "png":
        save_kwargs["transparent"] = True  # keep the EE nodata mask transparent
    return _save_fig_with_preview(fig, fmt, save_kwargs)


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
        is_rh_metric: bool = False, include_colorbar: bool = True,
        precomputed_data: Optional[np.ndarray] = None,
    ) -> Tuple[bytes, Optional[bytes]]:
        # Higher dpi for PDF — vector elements stay sharp regardless, but the
        # embedded raster (the imshow of the data) inherits the figure dpi.
        render_dpi = 300 if payload.format == "pdf" else 160

        if precomputed_data is not None:
            data = precomputed_data
        elif band_idx is not None:
            data = _read_as_float(src, window, indexes=band_idx)
        elif src.count >= 3 and cmap is None:
            # RGB / Sentinel-2 path: render edge-to-edge with no margin so the
            # output matches the Google PNG (no white border). Aspect-match the
            # figure to the data so imshow doesn't leave blank axes area.
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
            else:
                rendered = _normalize_rgb_percentile(rgb)
            h_px, w_px = rendered.shape[:2]
            fig_w_in = 10.0
            fig_h_in = max(0.5, fig_w_in * (h_px / max(1, w_px)))
            fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=render_dpi)
            ax = fig.add_axes([0, 0, 1, 1])  # axes fills figure → no margins
            ax.set_axis_off()
            ax.imshow(rendered, aspect="auto")
            return _save_fig_with_preview(fig, payload.format, {"pad_inches": 0})
        else:
            data = _read_as_float(src, window, indexes=1)

        if data.ndim == 3 and data.shape[0] == 1:
            data = data[0]

        low, high = _resolve_single_band_range(data, rmin, rmax)

        # No-colorbar path: render the colormapped data edge-to-edge with no
        # margins (axes fills the figure), matching the RGB / EOX outputs which
        # have no white border. nodata (NaN) stays transparent in PNG output.
        if not include_colorbar:
            h_px, w_px = data.shape[:2]
            fig_w_in = 10.0
            fig_h_in = max(0.5, fig_w_in * (h_px / max(1, w_px)))
            fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=render_dpi)
            ax = fig.add_axes([0, 0, 1, 1])  # axes fills figure → no margins
            ax.set_axis_off()
            ax.imshow(data, cmap=_resolve_cmap(cmap), vmin=low, vmax=high, aspect="auto")
            save_kwargs: Dict[str, Any] = {"pad_inches": 0}
            if payload.format == "png":
                save_kwargs["transparent"] = True
            return _save_fig_with_preview(fig, payload.format, save_kwargs)

        # Single-band path keeps the original layout because the colorbar
        # needs the right-hand margin matplotlib reserves by default.
        fig, ax = plt.subplots(figsize=(8, 8), dpi=render_dpi)
        ax.set_axis_off()
        im = ax.imshow(data, cmap=_resolve_cmap(cmap), vmin=low, vmax=high)
        divider = make_axes_locatable(ax)
        cax = divider.append_axes("right", size="5%", pad=0.15)
        cbar = fig.colorbar(im, cax=cax)
        # RH prediction rasters store heights in decimeters; convert tick labels
        # to meters and append the unit to the max tick (e.g. "50m") so the
        # unit reads at the same scale as the numbers — the prior approach put
        # "m" on the colorbar's outer label which rendered microscopically.
        if is_rh_metric:
            cbar.set_ticks([low, high])
            cbar.set_ticklabels([f"{low / 10:g}", f"{high / 10:g}m"])
        else:
            cbar.set_ticks([low, high])
            cbar.set_ticklabels([f"{low:g}", f"{high:g}"])
        cbar.ax.tick_params(labelsize=20)
        return _save_fig_with_preview(
            fig, payload.format,
            {"bbox_inches": "tight", "pad_inches": 0.05},
        )

    image_exports: List[Dict[str, Any]] = []
    render_errors: List[Dict[str, str]] = []
    if payload.format == "pdf":
        mime_type = "application/pdf"
    elif payload.format == "jpg":
        mime_type = "image/jpeg"
    else:
        mime_type = f"image/{payload.format}"

    def _record_export(
        file_name: str,
        layer: FigureLayerSpec,
        band_name: Optional[str] = None,
        preview_file_name: Optional[str] = None,
        tile_info: Optional[Dict[str, Any]] = None,
    ) -> None:
        relative_path = str(Path(session_dir_name) / file_name)
        entry: Dict[str, Any] = {
            "layer_id": layer.layer_id,
            "layer_name": layer.name,
            "filename": file_name,
            "relative_path": relative_path,
            "url": image_url_for(relative_path),
            "format": payload.format,
            "mime_type": mime_type,
            # Per-render timestamp used by the frontend as a cache-buster. The
            # output filename is intentionally stable (so the on-disk file is
            # overwritten in place on re-render), which means `url` is identical
            # across renders — React + the browser would keep showing the stale
            # cached image without an explicit version stamp.
            "rendered_at": datetime.now(timezone.utc).isoformat(),
        }
        if band_name is not None:
            entry["band_name"] = band_name
        if preview_file_name is not None:
            preview_rel = str(Path(session_dir_name) / preview_file_name)
            entry["preview_filename"] = preview_file_name
            entry["preview_relative_path"] = preview_rel
            entry["preview_url"] = image_url_for(preview_rel)
            entry["preview_mime_type"] = "image/png"
        # Tile-level provenance for RH prediction layers: lets the saved
        # record point back at the underlying COG without re-running the
        # PREDICTIONS_LOCAL_PATH / PREDICTIONS_REMOTE_PATH resolver later.
        if tile_info:
            for k, v in tile_info.items():
                if v is not None:
                    entry[k] = v
        image_exports.append(entry)

    def _write_with_preview(
        file_name: str,
        image_bytes: bytes,
        preview_bytes: Optional[bytes],
    ) -> Optional[str]:
        """Persist the primary bytes and, when present, a PNG preview sibling."""
        (session_dir / file_name).write_bytes(image_bytes)
        if preview_bytes is None:
            return None
        preview_file_name = f"{Path(file_name).stem}.preview.png"
        (session_dir / preview_file_name).write_bytes(preview_bytes)
        return preview_file_name

    wgs_xmin, wgs_ymin, wgs_xmax, wgs_ymax = transform_bounds(
        "EPSG:3857", "EPSG:4326", xmin, ymin, xmax, ymax,
    )

    def _render_eox_mosaic_bytes(year: int, draw_scale_bar: bool = True) -> Tuple[bytes, Optional[bytes]]:
        """Stitch the EOX s2cloudless mosaic for the selection and render via
        matplotlib so the saved file honours `payload.format` (png/jpg/pdf).
        A matplotlib-drawn scale bar sits in the lower-left corner — vector
        in PDF output, with restrained line weights / font size so it doesn't
        overpower the imagery (the burned-in PIL version was too heavy)."""
        import math
        from matplotlib.patheffects import withStroke
        from matplotlib.transforms import blended_transform_factory

        from .satellite import _stitch_bbox_eox_s2cloudless
        from .utils import nice_bar_length_m, step_up_bar_length_m
        from PIL import Image

        sat_bytes, sat_meta = _stitch_bbox_eox_s2cloudless(
            float(wgs_xmin), float(wgs_xmax), float(wgs_ymin), float(wgs_ymax),
            buffer_m=0.0, max_width_px=4096, year=int(year),
        )
        if sat_bytes is None:
            raise ValueError("EOX tile fetch returned no imagery for the selection.")
        arr = np.asarray(Image.open(io.BytesIO(sat_bytes)).convert("RGB"))
        # Render at a higher dpi for raster outputs too — the EOX stitch is up
        # to 4096 px wide, so a 160-dpi (1280 px) canvas softens both the
        # satellite imagery and the small scale-bar label.
        render_dpi = 300 if payload.format == "pdf" else 240
        # Match the figure aspect ratio to the EOX stitch and have the axes
        # cover the entire figure — otherwise the default subplot margins
        # (≈12 % per side) plus aspect-mismatched imshow leave white pixels
        # around the image, which the Google PNG path doesn't have because it
        # bypasses matplotlib entirely.
        h_px, w_px = arr.shape[:2]
        fig_w_in = 10.0
        fig_h_in = max(0.5, fig_w_in * (h_px / max(1, w_px)))
        fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=render_dpi)
        ax = fig.add_axes([0, 0, 1, 1])  # axes fills the figure → no margins
        ax.set_axis_off()
        # `aspect="auto"` lets imshow stretch to fill the axes; combined with
        # the aspect-matched figsize above, the result is pixel-accurate and
        # leaves no whitespace.
        ax.imshow(arr, interpolation="bilinear", aspect="auto")

        # ---- Scale bar (lower-left, in axes-fraction × data coords) --------
        # Mirrors the transect figure's bar: thin black line with a white halo,
        # short end ticks, label centred above. Sized in axes fractions so it
        # stays restrained regardless of source-image resolution.
        if not draw_scale_bar:
            return _save_fig_with_preview(fig, payload.format, {"pad_inches": 0})
        try:
            min_lon = float(sat_meta.get("min_lon", wgs_xmin))
            max_lon = float(sat_meta.get("max_lon", wgs_xmax))
            min_lat = float(sat_meta.get("min_lat", wgs_ymin))
            max_lat = float(sat_meta.get("max_lat", wgs_ymax))
            mean_lat_rad = math.radians((min_lat + max_lat) / 2.0)
            span_m = (max_lon - min_lon) * 111320.0 * max(1e-6, math.cos(mean_lat_rad))
            if span_m > 0:
                bar_m = nice_bar_length_m(span_m * 0.12) or 100.0
                bar_m = step_up_bar_length_m(bar_m)
                img_w = arr.shape[1]
                bar_px = bar_m / span_m * img_w
                bar_x0 = img_w * 0.03
                bar_x1 = bar_x0 + bar_px
                bar_y_axes = 0.05  # 5% from the bottom of the axes
                tick_h = 0.05
                # Thicker black stroke + a ~2× white casing so the bar lifts
                # off busy/dark mosaic imagery, without making it any taller.
                # Label is white (with a thin black halo for legibility over
                # bright patches), so its halo is the opposite colour.
                line_halo = [withStroke(linewidth=14, foreground="white")]
                text_halo = [withStroke(linewidth=12, foreground="black")]
                trans = blended_transform_factory(ax.transData, ax.transAxes)

                ax.plot(
                    [bar_x0, bar_x1], [bar_y_axes, bar_y_axes],
                    color="black", linewidth=7, solid_capstyle="butt",
                    transform=trans, path_effects=line_halo, zorder=5,
                )
                for xv in (bar_x0, bar_x1):
                    ax.plot(
                        [xv, xv], [bar_y_axes - tick_h, bar_y_axes + tick_h],
                        color="black", linewidth=7, solid_capstyle="butt",
                        transform=trans, path_effects=line_halo, zorder=5,
                    )
                label_text = (
                    f"{int(bar_m)} m" if bar_m < 1000 else f"{bar_m / 1000:g} km"
                )
                # Centred on the bar, but a short bar tucked into the left
                # inset would let half the label spill past the image edge.
                # Measure the rendered box and nudge the centre back inside —
                # only when it would actually clip, so a bar with room stays
                # visually centred. Mirrors the Google PNG path.
                label_cx = (bar_x0 + bar_x1) / 2.0
                # ~8% of the 10-in figure width (≈ 100 pt). Matches the
                # Google-satellite scale bar's `font_px = ref * 0.08` rule so
                # the label reads at a glance like in the Google export instead
                # of looking like a tiny annotation on the imagery.
                txt = ax.text(
                    label_cx, bar_y_axes + tick_h + 0.03,
                    label_text,
                    transform=trans, ha="center", va="bottom",
                    fontsize=72, color="white",
                    path_effects=text_halo, zorder=6,
                )
                try:
                    renderer = fig.canvas.get_renderer()
                    bbox = txt.get_window_extent(renderer=renderer)
                    inv = ax.transData.inverted()
                    # transData x is independent of display y on this
                    # rectilinear axes, so the y we feed in is irrelevant.
                    x_l = inv.transform((bbox.x0, bbox.y0))[0]
                    x_r = inv.transform((bbox.x1, bbox.y0))[0]
                    x_min, x_max = sorted(ax.get_xlim())
                    pad = (x_max - x_min) * 0.01
                    if x_l < x_min + pad:
                        txt.set_x(label_cx + (x_min + pad - x_l))
                    elif x_r > x_max - pad:
                        txt.set_x(label_cx - (x_r - (x_max - pad)))
                except Exception:
                    pass  # renderer unavailable — leave the label centred
        except Exception:
            pass  # Scale bar is decorative; never block the export.

        # `bbox_inches="tight"` would re-introduce the white margin we just
        # eliminated by aspect-matching the figure to the EOX stitch — use
        # the figure's actual extent and zero padding instead.
        return _save_fig_with_preview(fig, payload.format, {"pad_inches": 0})

    _EOX_URL_RE = re.compile(r"tiles\.maps\.eox\.at/.+/s2cloudless-(\d{4})_3857/")

    print(
        f"[area_images] rendering {len(payload.layers)} layer(s) into {session_dir_name} "
        f"(format={payload.format}); ids=" + ", ".join(
            f"{l.layer_id}({l.layer_subtype or l.layer_type or '?'})" for l in payload.layers
        ),
        flush=True,
    )

    for layer in payload.layers:
        try:
            is_sentinel = layer.layer_type == "sentinel2"
            # RH/prediction rasters (single-band, no `bands` payload) store
            # heights in decimeters; diversity-indices layers carry `bands` and
            # share the "prediction" layer_type but their values are unitless.
            is_rh_layer = layer.layer_type == "prediction" and not layer.bands

            # Whether single-band (colormapped) renders get a colorbar. When off,
            # the image is rendered edge-to-edge with no border (like EOX/RGB).
            # `getattr` default keeps older `FigureLayerSpec` payloads working.
            _icb = getattr(layer, "include_colorbar", None)
            include_colorbar = True if _icb is None else bool(_icb)

            # EOX s2cloudless is a WMTS tile service, not a COG — rasterio
            # cannot open its `{z}/{x}/{y}` template URL. Route it through the
            # tile-stitcher used by the transect figure instead. Subtype is the
            # primary signal; URL pattern is a fallback for older saved features
            # whose `layer_specs` predate the `layer_subtype` field (without it,
            # refresh would route the WMTS URL through `rasterio.open` and the
            # EOX image would silently fall out of `image_exports`).
            url_match = _EOX_URL_RE.search(layer.url or "")
            is_eox = (
                layer.layer_subtype == "s2cloudless_mosaic"
                or url_match is not None
            )
            if is_eox:
                year = layer.year or (
                    int(url_match.group(1)) if url_match else 2020
                )
                file_name = (
                    f"{sanitize_name(layer.name)}_"
                    f"{sanitize_name(location_tag)}.{payload.format}"
                )
                # `getattr` with default so a backend that's loaded an older
                # `FigureLayerSpec` (missing this field — e.g. mid-deploy)
                # doesn't crash the entire EOX render with AttributeError.
                _isb = getattr(layer, "include_scale_bar", None)
                draw_bar = True if _isb is None else bool(_isb)
                print(
                    f"[area_images] EOX layer detected: id={layer.layer_id} "
                    f"subtype={layer.layer_subtype} year={year} url_match={bool(url_match)} "
                    f"draw_bar={draw_bar} -> {file_name}",
                    flush=True,
                )
                image_bytes, preview_bytes = _render_eox_mosaic_bytes(year, draw_scale_bar=draw_bar)
                preview_file_name = _write_with_preview(file_name, image_bytes, preview_bytes)
                _record_export(file_name, layer, preview_file_name=preview_file_name)
                print(
                    f"[area_images] EOX layer rendered: {len(image_bytes)} bytes "
                    f"-> image_exports now {len(image_exports)} entries",
                    flush=True,
                )
                continue

            # Earth Engine layers are XYZ tile services (visualization baked into
            # the tiles), not COGs — rasterio cannot open the `{z}/{x}/{y}` URL.
            # Stitch the tiles for the selection and render via matplotlib so the
            # output honours `payload.format` (png/jpg/pdf).
            if layer.layer_type == "earthengine":
                file_name = (
                    f"{sanitize_name(layer.name)}_"
                    f"{sanitize_name(location_tag)}.{payload.format}"
                )
                _isb = getattr(layer, "include_scale_bar", None)
                draw_bar = True if _isb is None else bool(_isb)
                print(
                    f"[area_images] EE layer detected: id={layer.layer_id} "
                    f"draw_bar={draw_bar} -> {file_name}",
                    flush=True,
                )
                image_bytes, preview_bytes = render_xyz_tile_figure(
                    layer.url,
                    float(wgs_xmin), float(wgs_xmax),
                    float(wgs_ymin), float(wgs_ymax),
                    payload.format, draw_scale_bar=draw_bar,
                )
                preview_file_name = _write_with_preview(file_name, image_bytes, preview_bytes)
                _record_export(file_name, layer, preview_file_name=preview_file_name)
                print(
                    f"[area_images] EE layer rendered: {len(image_bytes)} bytes "
                    f"-> image_exports now {len(image_exports)} entries",
                    flush=True,
                )
                continue

            with rasterio.open(layer.url) as src:
                src_bounds = transform_bounds(
                    "EPSG:3857", src.crs, xmin, ymin, xmax, ymax, densify_pts=21,
                )
                window = clip_window(src, *src_bounds)
                if window.width <= 0 or window.height <= 0:
                    raise ValueError("Selection does not overlap layer extent.")

                # VSM interval (95%-5% etc.): high COG is `layer.url`, low COG is
                # `layer.url_low`. Read both windows, subtract, and feed the
                # diff to the single-band renderer via precomputed_data. Pixels
                # at the in-band sentinel (>=32767) become NaN so they render
                # transparent like normal nodata.
                if layer.url_low:
                    high_arr = _read_as_float(src, window, indexes=1)
                    with rasterio.open(layer.url_low) as src_low:
                        low_arr = _read_as_float(src_low, window, indexes=1)
                    if high_arr.shape != low_arr.shape:
                        raise ValueError(
                            f"Interval source rasters have mismatched shapes: "
                            f"{high_arr.shape} vs {low_arr.shape}"
                        )
                    SENTINEL = 32767.0
                    high_arr[high_arr >= SENTINEL] = np.nan
                    low_arr[low_arr >= SENTINEL] = np.nan
                    diff = high_arr - low_arr
                    file_name = (
                        f"{sanitize_name(layer.name)}_"
                        f"{sanitize_name(location_tag)}.{payload.format}"
                    )
                    image_bytes, preview_bytes = _render_one_bytes(
                        src, window, layer.name, file_name,
                        layer.colormap, layer.rescale_min, layer.rescale_max,
                        None, is_sentinel, layer.rgb_bands,
                        is_rh_metric=is_rh_layer, include_colorbar=include_colorbar,
                        precomputed_data=diff,
                    )
                    preview_file_name = _write_with_preview(file_name, image_bytes, preview_bytes)
                    tile_info = (
                        {
                            "tile_name": _extract_mgrs_tile_from_path(layer.url),
                            "tile_file_path": layer.url,
                            "tile_file_path_low": layer.url_low,
                            "year": layer.year,
                        }
                        if is_rh_layer else None
                    )
                    _record_export(
                        file_name, layer,
                        preview_file_name=preview_file_name,
                        tile_info=tile_info,
                    )
                    continue

                if layer.bands and len(layer.bands) > 0:
                    for band in layer.bands:
                        band_name = band.band_name or f"band{band.band_index}"
                        title = f"{layer.name} — {band_name}"
                        file_name = (
                            f"{sanitize_name(layer.name)}_"
                            f"{sanitize_name(location_tag)}_"
                            f"{sanitize_name(band_name)}.{payload.format}"
                        )
                        image_bytes, preview_bytes = _render_one_bytes(
                            src, window, title, file_name,
                            band.colormap if band.colormap is not None else layer.colormap,
                            band.rescale_min if band.rescale_min is not None else layer.rescale_min,
                            band.rescale_max if band.rescale_max is not None else layer.rescale_max,
                            band.band_index, is_sentinel, layer.rgb_bands,
                            is_rh_metric=False, include_colorbar=include_colorbar,
                        )
                        preview_file_name = _write_with_preview(file_name, image_bytes, preview_bytes)
                        _record_export(file_name, layer, band_name=band_name, preview_file_name=preview_file_name)
                else:
                    file_name = (
                        f"{sanitize_name(layer.name)}_"
                        f"{sanitize_name(location_tag)}.{payload.format}"
                    )
                    image_bytes, preview_bytes = _render_one_bytes(
                        src, window, layer.name, file_name,
                        layer.colormap, layer.rescale_min, layer.rescale_max,
                        None, is_sentinel, layer.rgb_bands,
                        is_rh_metric=is_rh_layer, include_colorbar=include_colorbar,
                    )
                    preview_file_name = _write_with_preview(file_name, image_bytes, preview_bytes)
                    tile_info = (
                        {
                            "tile_name": _extract_mgrs_tile_from_path(layer.url),
                            "tile_file_path": layer.url,
                            "year": layer.year,
                        }
                        if is_rh_layer else None
                    )
                    _record_export(
                        file_name, layer,
                        preview_file_name=preview_file_name,
                        tile_info=tile_info,
                    )
        except Exception as exc:
            import traceback as _tb
            print(
                f"[area_images] FAILED layer id={layer.layer_id} name={layer.name} "
                f"subtype={layer.layer_subtype} type={layer.layer_type}: {exc}\n"
                + _tb.format_exc(),
                flush=True,
            )
            render_errors.append({"layer_id": layer.layer_id, "name": layer.name, "error": str(exc)})

    print(
        f"[area_images] DONE: image_exports={len(image_exports)} errors={len(render_errors)}; "
        f"files=" + ", ".join(e.get('filename', '?') for e in image_exports),
        flush=True,
    )
    return image_exports, render_errors
