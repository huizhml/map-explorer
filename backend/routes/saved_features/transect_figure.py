"""Server-side multi-panel transect figure (map + heatmap + ENL/FHD + CR).

Heavyweight matplotlib rendering kept out of `routes.py` so the route module
stays focused on FastAPI wiring.
"""

from __future__ import annotations

import io
import math
from typing import List, Optional, Tuple

import numpy as np
import requests
from fastapi import HTTPException

from .models import TransectFigureRequest
from .satellite import _stitch_bbox_eox_s2cloudless, _stitch_bbox_satellite


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
) -> Tuple[Optional[np.ndarray], dict]:
    """Fetch the JRC TMF AnnualChanges Dec 2020 layer for the bbox as a styled
    PNG via Earth Engine `getThumbURL`, decoded into a `(H, W, 4)` numpy array.

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


def _render_transect_figure(req: TransectFigureRequest) -> Tuple[bytes, str]:
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

    # JRC TMF 1D strip glued to the top of the heatmap — same plotting-rect
    # width and x-axis, so the user can read forest class transitions directly
    # against the energy heatmap. Tentatively reserved; dropped below if the
    # EE fetch fails (e.g. EE not configured in this environment).
    EE_STRIP_HEIGHT_PX = 15

    # Panel selection (each becomes a row in plt.subplots).
    panels: List[str] = []
    height_ratios: List[float] = []
    if req.include_map:
        panels.append("map")
        height_ratios.append(req.map_height_px)
    if req.include_ee_annualchanges:
        # JRC TMF AnnualChanges sits at the very top of the figure (forest-class
        # context first, then the natural-colour satellite snapshot below).
        panels.append("ee_annualchanges")
        height_ratios.append(req.ee_annualchanges_height_px)
    if req.include_heatmap:
        # Strip is tentative — removed below if EE fetch fails. Sits immediately
        # above the heatmap so the two share visual gridlines.
        panels.append("ee_strip")
        height_ratios.append(EE_STRIP_HEIGHT_PX)
        panels.append("heatmap")
        height_ratios.append(req.heatmap_height_px)
    # Merged metrics panel — FHD/1D ENL/2D ENL share the left y-axis; CR uses
    # a twinx right y-axis when it's selected alongside any of the others, or
    # the primary axis when it's the only selected metric.
    show_any_metric = req.show_fhd or req.show_enl1d or req.show_enl2d or req.show_cr
    if show_any_metric:
        panels.append("metrics")
        height_ratios.append(req.enl_fhd_height_px)
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

    def _auto_panel_height_px(image_aspect: float, panel_key: str) -> int:
        """Compute the height_ratios entry that makes panel `panel_key`'s
        inner rectangle match `image_aspect` (h/w). Iterates a few times to
        converge with the variable `hspace`.
        """
        target_panel_px = req.figure_width_px * inner_frac * image_aspect
        n_panels = len(panels)
        idx = panels.index(panel_key)
        s_other = sum(height_ratios) - height_ratios[idx]
        auto_h = target_panel_px  # initial guess (no hspace correction)
        for _ in range(3):
            _avg_panel_h_in = ((auto_h + s_other) / LAYOUT_DPI) / max(1, n_panels)
            _hspace_est = max(0.10, min(0.60, hsp_in / _avg_panel_h_in))
            _correction = (n_panels + (n_panels - 1) * _hspace_est) / n_panels
            auto_h = target_panel_px * _correction
        return max(60, int(round(auto_h)))

    # Fetch satellite image before creating the figure so we can auto-size the
    # map panel to preserve the image's geographic aspect ratio.
    sat_arr = None
    sat_meta: Optional[dict] = None
    # Tracks which basemap was actually used, for the panel's footer annotation.
    sat_source_label: Optional[str] = None
    if "map" in panels:
        if req.basemap_source == "eox_s2cloudless":
            _sat_bytes, sat_meta = _stitch_bbox_eox_s2cloudless(
                float(np.min(lons)),
                float(np.max(lons)),
                float(np.min(lats)),
                float(np.max(lats)),
                buffer_m=req.satellite_buffer_m,
                max_width_px=req.satellite_max_width_px,
                year=int(req.eox_year),
            )
            sat_source_label = f"Sentinel-2 cloudless {int(req.eox_year)} · EOX"
        else:
            _sat_bytes, sat_meta = _stitch_bbox_satellite(
                float(np.min(lons)),
                float(np.max(lons)),
                float(np.min(lats)),
                float(np.max(lats)),
                buffer_m=req.satellite_buffer_m,
                max_width_px=req.satellite_max_width_px,
            )
            sat_source_label = "Google Satellite (HD)"
        if _sat_bytes is not None:
            from PIL import Image as _PILImage
            sat_arr = np.asarray(_PILImage.open(io.BytesIO(_sat_bytes)).convert("RGB"))
            # EOX s2cloudless JPEGs read dark over forest canopy; brighten via a
            # gamma curve so midtones lift without clipping the (rare) highlights
            # like clouds/snow. Skip when factor is ~1.0 to avoid pointless work.
            if (
                req.basemap_source == "eox_s2cloudless"
                and req.eox_brightness > 0
                and abs(req.eox_brightness - 1.0) > 1e-3
            ):
                inv_g = 1.0 / float(req.eox_brightness)
                # uint8 → float [0,1] → gamma → uint8.
                sat_arr = (
                    np.clip(np.power(sat_arr.astype(np.float32) / 255.0, inv_g), 0.0, 1.0)
                    * 255.0
                ).astype(np.uint8)
            sat_aspect = sat_arr.shape[0] / sat_arr.shape[1]
            height_ratios[panels.index("map")] = _auto_panel_height_px(sat_aspect, "map")

    # JRC TMF AnnualChanges fetch — shared by the optional 2D panel (buffered
    # bbox, full image) and the always-on 1D strip above the heatmap (which
    # samples this same array at each transect (lon, lat)).  Doing one fetch
    # rather than two halves the Earth Engine round-trip when both are on.
    ee_arr = None
    ee_meta: Optional[dict] = None
    if "ee_annualchanges" in panels or "ee_strip" in panels:
        # Use the satellite buffer when the 2D panel is on (it needs the buffered
        # context around the line); a tiny buffer is enough when only the strip
        # is on (we sample at the line, the bbox just needs to be non-degenerate).
        _ee_buffer_m = req.satellite_buffer_m if "ee_annualchanges" in panels else 10.0
        ee_arr, ee_meta = _fetch_ee_annualchanges_array(
            float(np.min(lons)),
            float(np.max(lons)),
            float(np.min(lats)),
            float(np.max(lats)),
            buffer_m=_ee_buffer_m,
            max_dimension=2048,
        )

    # Drop the strip from the layout if EE is unavailable — the heatmap stays;
    # we just don't insert an empty header row above it.
    if "ee_strip" in panels and ee_arr is None:
        _idx = panels.index("ee_strip")
        panels.pop(_idx)
        height_ratios.pop(_idx)

    if "ee_annualchanges" in panels and ee_arr is not None:
        ee_aspect = ee_arr.shape[0] / ee_arr.shape[1]
        height_ratios[panels.index("ee_annualchanges")] = _auto_panel_height_px(
            ee_aspect, "ee_annualchanges",
        )

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

    def _hsl_to_rgb(h_deg: float, s: float, l: float) -> Tuple[float, float, float]:
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

    ramp_rgb = np.array([
        _hsl_to_rgb(235 - 175 * (i / (n_steps - 1)), 0.86, 0.28 + 0.34 * (i / (n_steps - 1)))
        for i in range(n_steps)
    ])
    energy_cmap = LinearSegmentedColormap.from_list("transect_energy", ramp_rgb, N=n_steps)

    x_min = float(np.min(x_vals))
    x_max = float(np.max(x_vals))

    # Shared x-edges (one per sample, midpoints between adjacent samples). Used
    # by both the heatmap (pcolormesh) and the EE strip above it so the two are
    # column-aligned to the pixel.
    shared_x_edges = np.empty(len(samples) + 1)
    if len(samples) >= 2:
        _mid = (x_vals[:-1] + x_vals[1:]) / 2.0
        shared_x_edges[1:-1] = _mid
        shared_x_edges[0] = x_vals[0] - (_mid[0] - x_vals[0])
        shared_x_edges[-1] = x_vals[-1] + (x_vals[-1] - _mid[-1])
    else:
        shared_x_edges[:] = x_vals[0]

    def _draw_imshow_panel(ax, arr: np.ndarray, meta: dict, interpolation: str) -> None:
        """Draw an (H, W, 3+) array as a geographic imshow + the transect line
        on top, configured for the current `req.x_axis` orientation."""
        extent_lon = (meta["min_lon"], meta["max_lon"])
        extent_lat = (meta["min_lat"], meta["max_lat"])
        if req.x_axis == "lon":
            ax.imshow(
                arr,
                extent=(extent_lon[0], extent_lon[1], extent_lat[0], extent_lat[1]),
                aspect="auto",
                origin="upper",
                interpolation=interpolation,
            )
            ax.plot(lons, lats, color="#ff5252", linewidth=1.0)
            ax.set_ylabel("Lat.")
            ax.set_ylim(extent_lat[0], extent_lat[1])
        else:
            ax.imshow(
                np.transpose(arr, (1, 0, 2))[::-1],
                extent=(extent_lat[0], extent_lat[1], extent_lon[0], extent_lon[1]),
                aspect="auto",
                origin="upper",
                interpolation=interpolation,
            )
            ax.plot(lats, lons, color="#ff5252", linewidth=1.0)
            ax.set_ylabel("Lon.")
            ax.set_ylim(extent_lon[0], extent_lon[1])
        ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.3f}"))
        ax.yaxis.set_major_locator(MaxNLocator(nbins=2, prune="both"))

    # ---- map panel ------------------------------------------------------
    if "map" in panels:
        ax = axes[panels.index("map")]
        if sat_arr is not None and sat_meta is not None:
            _draw_imshow_panel(ax, sat_arr, sat_meta, "bilinear")

            # ---- scale bar (lower-left of the satellite panel) ----------
            from matplotlib.patheffects import withStroke
            from matplotlib.transforms import blended_transform_factory
            from .utils import nice_bar_length_m

            mean_lat_rad = math.radians((float(np.min(lats)) + float(np.max(lats))) / 2.0)
            # Convert one unit of the panel's x-axis (lon or lat degrees) to meters.
            m_per_xunit = (
                111320.0 * max(1e-6, math.cos(mean_lat_rad))
                if req.x_axis == "lon" else 111320.0
            )
            visible_x_span = x_max - x_min
            visible_x_span_m = visible_x_span * m_per_xunit
            # Aim for a bar that's ~10% of the visible width.
            bar_m = nice_bar_length_m(visible_x_span_m * 0.10) or 100.0
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
                f"{int(bar_m)} m" if bar_m < 1000 else f"{bar_m / 1000:g} km"
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

            # Source label (lower-right corner) — matches the JRC strip footer
            # style so EOX vs. Google snapshots are self-identifying in exports.
            if sat_source_label:
                ax.text(
                    0.99, 0.04, sat_source_label,
                    transform=ax.transAxes, ha="right", va="bottom",
                    fontsize=max(5, req.font_size - 4),
                    color="#222",
                    bbox=dict(facecolor="white", alpha=0.7, edgecolor="none", pad=1.2),
                    zorder=6,
                )
        else:
            unavailable_label = (
                f"{sat_source_label} unavailable"
                if sat_source_label
                else "Satellite imagery unavailable"
            )
            ax.text(0.5, 0.5, unavailable_label, ha="center", va="center", transform=ax.transAxes)
            ax.set_yticks([])

    # ---- JRC TMF AnnualChanges panel ------------------------------------
    if "ee_annualchanges" in panels:
        ax = axes[panels.index("ee_annualchanges")]
        if ee_arr is not None and ee_meta is not None:
            _draw_imshow_panel(ax, ee_arr, ee_meta, "nearest")  # preserve sharp class boundaries
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

    # ---- JRC TMF 1D strip (above heatmap) -------------------------------
    # Samples the (already-styled, palette-applied) EE thumb RGBA at each
    # transect (lon, lat) and renders as a Quadmesh that shares x-edges with
    # the heatmap below, so every strip cell sits exactly above its heatmap
    # column (works even when sample spacing along x is non-uniform).
    if "ee_strip" in panels and ee_arr is not None and ee_meta is not None:
        from matplotlib.colors import ListedColormap

        ax = axes[panels.index("ee_strip")]
        H_px, W_px = ee_arr.shape[:2]
        ee_lon0 = ee_meta["min_lon"]
        ee_lon1 = ee_meta["max_lon"]
        ee_lat0 = ee_meta["min_lat"]
        ee_lat1 = ee_meta["max_lat"]
        # Image is origin='upper': row 0 = max_lat, row H-1 = min_lat.
        lon_span = max(1e-12, ee_lon1 - ee_lon0)
        lat_span = max(1e-12, ee_lat1 - ee_lat0)
        cols = np.clip(
            np.round((lons - ee_lon0) / lon_span * (W_px - 1)).astype(int),
            0, W_px - 1,
        )
        rows = np.clip(
            np.round((ee_lat1 - lats) / lat_span * (H_px - 1)).astype(int),
            0, H_px - 1,
        )
        # Per-sample RGB(A); flatten alpha onto white so masked (no-forest)
        # pixels read as solid white rather than letting the figure facecolor
        # bleed through.
        sampled = ee_arr[rows, cols, :].astype(float)
        if sampled.shape[1] == 4:
            a = sampled[:, 3:4] / 255.0
            rgb = sampled[:, :3] * a + 255.0 * (1.0 - a)
        else:
            rgb = sampled[:, :3]
        palette = (rgb.clip(0, 255) / 255.0)  # (N, 3) float for ListedColormap

        # Each sample is one quad. We pass column indices as the scalar field
        # and a ListedColormap so quad i is drawn with palette[i] — sidesteps
        # imshow's uniform-cell limitation and matches the heatmap's edges.
        N = len(samples)
        strip_cmap = ListedColormap(palette)
        indices = np.arange(N, dtype=float).reshape(1, N)
        ax.pcolormesh(
            shared_x_edges,
            np.array([0.0, 1.0]),
            indices,
            cmap=strip_cmap,
            vmin=-0.5,
            vmax=N - 0.5,
            shading="flat",
            edgecolors="none",
            linewidth=0,
            antialiased=False,
            # Same rationale as the heatmap below: rasterise the quadmesh so
            # PDF exports don't show hairline gaps between adjacent cells.
            rasterized=True,
        )
        ax.set_ylim(0.0, 1.0)
        ax.set_yticks([])
        ax.tick_params(axis="y", left=False, labelleft=False)
        # No ylabel — the strip reads as the heatmap's header band; the JRC
        # palette is documented in the surrounding figure caption / legend.

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
        x_edges = shared_x_edges
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

    # ---- Merged metrics panel (FHD / 1D ENL / 2D ENL / CR) --------------
    # CR uses a separate y-scale (0..1.1) so when it's plotted alongside the
    # left-axis metrics it lives on `ax.twinx()` (right axis). If CR is the
    # ONLY selected metric, it gets the primary axis to avoid the visual
    # clutter of an empty left axis.
    metrics_twin_ax = None  # populated only when CR is on a twin axis
    if "metrics" in panels:
        ax = axes[panels.index("metrics")]
        fhd = np.array([s.fhd if s.fhd is not None else np.nan for s in samples], dtype=float)
        enl1 = np.array([s.enl1d if s.enl1d is not None else np.nan for s in samples], dtype=float)
        enl2 = np.array([s.enl2d if s.enl2d is not None else np.nan for s in samples], dtype=float)
        cr = np.array([s.cr if s.cr is not None else np.nan for s in samples], dtype=float)
        has_left = req.show_fhd or req.show_enl1d or req.show_enl2d

        # Left axis: FHD / 1D ENL / 2D ENL.
        if has_left:
            if req.show_fhd and np.any(np.isfinite(fhd)):
                ax.plot(x_vals, fhd, label="FHD", color="#1f77b4", linewidth=1.5)
            if req.show_enl1d and np.any(np.isfinite(enl1)):
                ax.plot(x_vals, enl1, label="1D ENL", color="#2ca02c", linewidth=1.5)
            if req.show_enl2d and np.any(np.isfinite(enl2)):
                ax.plot(x_vals, enl2, label="2D ENL", color="#d62728", linewidth=1.5)
            ax.set_ylabel("ENL / FHD")

        # CR: twin right axis when paired with left-axis metrics; otherwise
        # primary axis.
        if req.show_cr and has_left:
            metrics_twin_ax = ax.twinx()
            if np.any(np.isfinite(cr)):
                metrics_twin_ax.plot(
                    x_vals, cr, label="CR", color="#9467bd", linewidth=1.5,
                )
            metrics_twin_ax.set_ylabel("CR")
            metrics_twin_ax.set_ylim(0, 1.1)
            # Match left-axis tick label font size; mpl picks up rcParams by default.
            metrics_twin_ax.tick_params(axis="y", labelsize=_tick_fs)
        elif req.show_cr:
            # CR only — use primary axis.
            if np.any(np.isfinite(cr)):
                ax.plot(x_vals, cr, label="CR", color="#9467bd", linewidth=1.5)
            ax.set_ylabel("CR")
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
    # Include the metrics-panel twin axis (when CR sits on a right-side axis)
    # so its handle is gathered alongside the primary-axis FHD/ENL handles.
    legend_handles: list = []
    legend_labels: list = []
    legend_sources: list = list(axes)
    if metrics_twin_ax is not None:
        legend_sources.append(metrics_twin_ax)
    for ax_obj in legend_sources:
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

    # Glue the JRC strip flush against the top of the heatmap (zero hspace
    # only for this pair — other panels keep the normal inter-panel gap).
    # Done by overriding the strip's axes position post-layout: shift it down
    # so its bottom edge touches the heatmap's top edge while keeping its
    # original height. The hidden colorbar gutter follows automatically since
    # `make_axes_locatable` tracks the parent axis position via a locator.
    if "ee_strip" in panels and "heatmap" in panels:
        strip_ax = axes[panels.index("ee_strip")]
        hm_ax = axes[panels.index("heatmap")]
        strip_pos = strip_ax.get_position()
        hm_pos = hm_ax.get_position()
        new_y0 = hm_pos.y0 + hm_pos.height  # bottom of strip == top of heatmap
        strip_ax.set_position([strip_pos.x0, new_y0, strip_pos.width, strip_pos.height])

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
