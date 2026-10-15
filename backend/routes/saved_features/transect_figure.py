"""Server-side multi-panel transect figure (map + heatmap + ENL/FHD + CR).

Heavyweight matplotlib rendering kept out of `routes.py` so the route module
stays focused on FastAPI wiring.
"""

from __future__ import annotations

import io
import math
import threading
from collections import OrderedDict
from typing import Any, Callable, List, Optional, Tuple

import numpy as np
import requests
from fastapi import HTTPException

from .colormap import build_energy_cmap
from .config import JRC_TMF_CLASSES
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


# In-process LRU cache for the slow inputs of the map panels (tile stitching,
# Earth Engine thumbs, line-aligned resampling). Layout-only changes — figure
# width, panel heights, fonts, labels, metric toggles — then re-render from
# memory instead of re-downloading. Bounded by total bytes; failed fetches
# (None results) are not cached so they're retried next time.
_FETCH_CACHE_MAX_BYTES = 512 * 1024 * 1024
_fetch_cache: "OrderedDict[tuple, Tuple[Any, int]]" = OrderedDict()
_fetch_cache_bytes = 0
_fetch_cache_lock = threading.Lock()


def _cached(key: tuple, compute: Callable[[], Any]) -> Any:
    """Return `compute()` memoised under `key`. The value is a tuple whose
    first item is the payload (bytes / ndarray / None); cached arrays are
    made read-only since callers share them."""
    global _fetch_cache_bytes
    with _fetch_cache_lock:
        hit = _fetch_cache.get(key)
        if hit is not None:
            _fetch_cache.move_to_end(key)
            return hit[0]
    value = compute()
    payload = value[0]
    if payload is None:
        return value
    if isinstance(payload, np.ndarray):
        payload.setflags(write=False)
        size = payload.nbytes
    else:
        size = len(payload)
    with _fetch_cache_lock:
        if key not in _fetch_cache:
            _fetch_cache[key] = (value, size)
            _fetch_cache_bytes += size
            while _fetch_cache_bytes > _FETCH_CACHE_MAX_BYTES and len(_fetch_cache) > 1:
                _, (_, old_size) = _fetch_cache.popitem(last=False)
                _fetch_cache_bytes -= old_size
    return value


def _frame_key(frame: Optional[dict]) -> Optional[tuple]:
    if frame is None:
        return None
    return (
        frame["lon_c"], frame["lat_c"], frame["e0"], frame["n0"],
        float(frame["u"][0]), float(frame["u"][1]),
        frame["length"], frame["buffer_m"],
    )


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
        from PIL import Image
        # Use RGBA so the masked (transparent) pixels stay transparent on the
        # final imshow, letting matplotlib's white axes background show through.
        arr = np.asarray(Image.open(io.BytesIO(resp.content)).convert("RGBA"))
    except Exception:
        return None, {}

    return arr, {
        "min_lon": bmin_lon,
        "max_lon": bmax_lon,
        "min_lat": bmin_lat,
        "max_lat": bmax_lat,
    }


def _css_color(c: str) -> Tuple[float, float, float, float]:
    """CSS colour → matplotlib RGBA. Accepts what the frontend's colormaps use:
    hex / named colours plus `rgb(r,g,b)` / `rgba(r,g,b,a)` (0–255, alpha 0–1),
    which matplotlib itself rejects."""
    import re

    from matplotlib.colors import to_rgba

    m = re.fullmatch(r"\s*rgba?\(([^)]*)\)\s*", c)
    if m:
        parts = [float(p) for p in re.split(r"[,\s/]+", m.group(1).strip()) if p]
        r, g, b = (v / 255.0 for v in parts[:3])
        return (r, g, b, parts[3] if len(parts) > 3 else 1.0)
    return to_rgba(c)


def _fetch_map_layer(
    layer, bbox: tuple, buffer_m: float, max_width_px: int,
) -> Tuple[Optional[np.ndarray], Optional[dict]]:
    """Stitch a map layer's XYZ tiles into one north-up RGBA array. Grouped
    layers (several sources) are alpha-composited bottom-first at the finest
    source's resolution (coarse ones, e.g. an overzoomed mosaic, upsampled)."""
    from PIL import Image

    from .satellite import _stitch_bbox_xyz

    imgs: List[Image.Image] = []
    meta: Optional[dict] = None
    for src in layer.sources:
        png, m = _cached(
            ("xyz", src.url, bbox, buffer_m, max_width_px, src.tile_size, src.max_zoom),
            lambda src=src: _stitch_bbox_xyz(
                src.url, *bbox, buffer_m=buffer_m, max_width_px=max_width_px,
                max_zoom=src.max_zoom, tile_px=src.tile_size,
            ),
        )
        if png is None:
            continue
        imgs.append(Image.open(io.BytesIO(png)).convert("RGBA"))
        meta = m  # same bbox for every source
    if not imgs:
        return None, None
    size = max((im.size for im in imgs), key=lambda wh: wh[0] * wh[1])
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    for im in imgs:
        out.alpha_composite(im if im.size == size else im.resize(size, Image.NEAREST))
    return np.asarray(out), meta


def _transect_frame(
    lons: np.ndarray,
    lats: np.ndarray,
    x_vals: np.ndarray,
    x_axis: str,
    buffer_m: float,
) -> Optional[dict]:
    """Line-aligned frame for rotating the map panels so the transect runs
    horizontally: `t` = metres along the line (from the min-x sample towards
    the max-x sample), `s` = metres perpendicular to it (left of travel).

    Returns None when rotation doesn't apply: a bent polyline (the shared
    x-axis is only affine in `t` for a straight line), or a line already
    within half a degree of the x-axis direction (north-up is identical).
    Uses a local equirectangular approximation (fine for transect scales).
    """
    lat_c = float(np.mean(lats))
    lon_c = float(np.mean(lons))
    k_lon = 111320.0 * max(1e-6, math.cos(math.radians(lat_c)))
    east = (lons - lon_c) * k_lon
    north = (lats - lat_c) * 111320.0
    i0, i1 = int(np.argmin(x_vals)), int(np.argmax(x_vals))
    x0, x1 = float(x_vals[i0]), float(x_vals[i1])
    d = np.array([east[i1] - east[i0], north[i1] - north[i0]])
    length = float(np.hypot(d[0], d[1]))
    if length <= 0 or x1 <= x0:
        return None
    u = d / length
    v = np.array([-u[1], u[0]])  # u rotated +90°: keeps the map unmirrored
    rel_e = east - east[i0]
    rel_n = north - north[i0]
    perp = rel_e * v[0] + rel_n * v[1]
    if float(np.max(np.abs(perp))) > max(1.0, 0.02 * length):
        return None
    axis_dir = np.array([1.0, 0.0]) if x_axis == "lon" else np.array([0.0, 1.0])
    if math.degrees(math.acos(float(np.clip(u @ axis_dir, -1.0, 1.0)))) < 0.5:
        return None

    # Bbox of the rotated rectangle t ∈ [0, L], s ∈ [-B, B] — what has to be
    # fetched north-up before resampling into the line frame.
    corners_e, corners_n = [], []
    for t in (0.0, length):
        for s in (-buffer_m, buffer_m):
            corners_e.append(east[i0] + t * u[0] + s * v[0])
            corners_n.append(north[i0] + t * u[1] + s * v[1])
    return {
        "lon_c": lon_c, "lat_c": lat_c, "k_lon": k_lon,
        "e0": float(east[i0]), "n0": float(north[i0]),
        "u": u, "v": v, "length": length, "buffer_m": float(buffer_m),
        "x0": x0, "x1": x1, "perp": perp,
        "min_lon": lon_c + min(corners_e) / k_lon,
        "max_lon": lon_c + max(corners_e) / k_lon,
        "min_lat": lat_c + min(corners_n) / 111320.0,
        "max_lat": lat_c + max(corners_n) / 111320.0,
    }


def _resample_to_frame(
    arr: np.ndarray, meta: dict, frame: dict, order: int, max_width_px: int,
) -> np.ndarray:
    """Resample a north-up Web-Mercator image (bbox in `meta`) into the
    line-aligned frame: columns run along the transect, rows span ±buffer
    perpendicular to it (row 0 = +buffer). Keeps the source's metres/pixel."""
    from scipy.ndimage import map_coordinates

    H, W = arr.shape[:2]
    length, buf = frame["length"], frame["buffer_m"]
    m_per_px = max(1e-6, (meta["max_lon"] - meta["min_lon"]) * frame["k_lon"] / W)
    m_per_px = max(m_per_px, length / max(1, max_width_px))
    out_w = max(2, int(round(length / m_per_px)))
    out_h = max(2, int(round(2.0 * buf / m_per_px)))

    t = (np.arange(out_w) + 0.5) * (length / out_w)
    s = buf - (np.arange(out_h) + 0.5) * (2.0 * buf / out_h)
    tt, ss = np.meshgrid(t, s)
    u, v = frame["u"], frame["v"]
    lon = frame["lon_c"] + (frame["e0"] + tt * u[0] + ss * v[0]) / frame["k_lon"]
    lat = frame["lat_c"] + (frame["n0"] + tt * u[1] + ss * v[1]) / 111320.0
    del tt, ss

    def _merc(lat_deg):
        return np.log(np.tan(np.pi / 4.0 + np.radians(lat_deg) / 2.0))

    col = (lon - meta["min_lon"]) / (meta["max_lon"] - meta["min_lon"]) * W - 0.5
    m_top, m_bot = _merc(meta["max_lat"]), _merc(meta["min_lat"])
    row = (m_top - _merc(lat)) / (m_top - m_bot) * H - 0.5
    del lon, lat

    out = np.empty((out_h, out_w, arr.shape[2]), dtype=arr.dtype)
    for c in range(arr.shape[2]):
        band = map_coordinates(
            arr[..., c].astype(np.float32), [row, col],
            order=order, mode="nearest", output=np.float32,
        )
        out[..., c] = np.clip(np.round(band), 0, 255).astype(arr.dtype)
    return out


def _render_transect_figure(req: TransectFigureRequest) -> Tuple[bytes, str]:
    """Render the multi-panel transect figure with matplotlib (shared x-axis).

    Returns (binary, media_type). Runs synchronously; call from an executor.
    """
    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter, MaxNLocator

    samples = req.samples
    if len(samples) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 transect samples to render figure")

    lons = np.array([s.lon for s in samples], dtype=float)
    lats = np.array([s.lat for s in samples], dtype=float)
    x_vals = lons if req.x_axis == "lon" else lats

    # Tick label formatters: signed decimal degrees rendered with a cardinal
    # hemisphere suffix (e.g. `12.345°N`, `75.120°W`) so the labels are
    # self-identifying — no separate "Longitude"/"Latitude" axis label needed.
    def _fmt_lat(v: float, _pos=None) -> str:
        if v == 0:
            return "0.00°"
        return f"{abs(v):.2f}°{'N' if v > 0 else 'S'}"

    def _fmt_lon(v: float, _pos=None) -> str:
        if v == 0:
            return "0.00°"
        return f"{abs(v):.2f}°{'E' if v > 0 else 'W'}"

    # Shared source-label style used by every panel (satellite, JRC TMF,
    # heatmap, metrics). One helper so the look is identical and tweaks
    # (e.g. the user-requested grey edge) only need to be made in one place.
    # Always pinned to the top-right corner with a small gap below the plot
    # top so the bbox doesn't kiss the spine.
    def _source_badge(ax_obj, text: str) -> None:
        ax_obj.text(
            0.99, 0.92, text,
            transform=ax_obj.transAxes, ha="right", va="top",
            fontsize=max(5, req.font_size - 4),
            color="#222",
            bbox=dict(
                facecolor="white", alpha=0.7,
                edgecolor="#888", linewidth=0.6, pad=3.0,
            ),
            zorder=6,
        )

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
    # Map layers (as shown on the map) right under the satellite snapshot.
    for _i in range(len(req.map_layers)):
        panels.append(f"layer{_i}")
        height_ratios.append(req.map_layer_height_px)
    if req.include_ee_annualchanges:
        # JRC TMF AnnualChanges sits at the very top of the figure (forest-class
        # context first, then the natural-colour satellite snapshot below).
        panels.append("ee_annualchanges")
        height_ratios.append(req.ee_annualchanges_height_px)
    if req.include_heatmap:
        # JRC TMF class strip sits immediately above the heatmap so the two
        # share visual gridlines. Only shown when the JRC TMF map is selected;
        # also tentative — removed below if the EE fetch fails.
        if req.include_ee_annualchanges:
            panels.append("ee_strip")
            height_ratios.append(EE_STRIP_HEIGHT_PX)
        panels.append("heatmap")
        height_ratios.append(req.heatmap_height_px)
    # Merged metrics panel — FHD / 1D ENL / 2D ENL / CR.  By default all four
    # share the left y-axis (integer ticks) so trends can be compared directly;
    # set `cr_own_yaxis=True` to give CR its own twin right y-axis (0..1.1) when
    # it's plotted alongside any of the others.
    show_any_metric = req.show_fhd or req.show_enl1d or req.show_enl2d or req.show_cr
    if show_any_metric:
        panels.append("metrics")
        height_ratios.append(req.enl_fhd_height_px)
    if not panels:
        raise HTTPException(status_code=400, detail="Select at least one panel to render")

    if req.panel_order:
        _order_key = {
            p: (f"layer:{req.map_layers[int(p[5:])].id}" if p.startswith("layer") else p)
            for p in panels if p != "ee_strip"
        }
        _rank = {k: i for i, k in enumerate(req.panel_order)}
        _height = dict(zip(panels, height_ratios))
        _ordered = sorted(
            (p for p in panels if p != "ee_strip"),
            key=lambda p: (_rank.get(_order_key[p], len(_rank)), panels.index(p)),
        )
        if "ee_strip" in panels:  # stays the heatmap's header band
            _ordered.insert(_ordered.index("heatmap"), "ee_strip")
        panels = _ordered
        height_ratios = [_height[p] for p in panels]

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

    # Margins in font-relative inches (DPI-independent).
    #
    # IMPORTANT: these use a FIXED layout font size, not `req.font_size`.
    # Text is still rendered at `req.font_size` (see rcParams below), but the
    # figure's *geometry* (margins → inner_frac → auto panel heights →
    # fig_h_in) is pinned to a reference em so the figure's aspect ratio does
    # NOT change when the user picks a larger/smaller font. Otherwise a bigger
    # font grows the margins, shrinks inner_frac, shrinks the auto-sized panel
    # heights, and the whole figure morphs taller/shorter. Any text that
    # overflows these reference-sized margins is absorbed by the
    # `bbox_inches="tight"` save (it expands the canvas outward) — it never
    # clips or distorts the plotted content.
    LAYOUT_FONT_PT = 11.0                   # reference em for layout geometry
    font_in = LAYOUT_FONT_PT / 72.0         # 1 em in inches (layout only)
    left_in  = font_in * 10.0              # rotated ylabel + tick nums + padding
    # Right margin is plain whitespace — the heatmap colorbar is drawn as an
    # inset inside the heatmap panel (lower-left, see the heatmap block below),
    # so no gutter reservation is needed here.
    right_in = font_in * 1.0
    top_in   = font_in * 1.0
    bot_in   = font_in * 0.5
    hsp_in   = font_in * 0.8              # gap between subplots (in inches)
    # NOTE on the heatmap's JRC TMF strip: it's glued flush to the heatmap's
    # top by the post-layout step at the bottom of this function (so it reads
    # as the heatmap's header band), and panels above the strip are shifted
    # down by exactly the original strip↔heatmap gridspec gap — that way every
    # remaining inter-panel gap (satellite↔JRC, JRC↔strip, heatmap↔metrics)
    # stays equal to a single `hspace`. No extra floor on `hsp_in` is needed.

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

    # Line-aligned frame for the 2D map panels (None → classic north-up bbox).
    frame: Optional[dict] = None
    if req.align_map_to_transect and (
        "map" in panels or "ee_annualchanges" in panels or req.map_layers
    ):
        frame = _transect_frame(lons, lats, x_vals, req.x_axis, req.satellite_buffer_m)
    # North-up bbox each map fetch covers: the transect bbox grown by the
    # buffer, or (rotated) exactly the rotated rectangle's bbox.
    if frame is not None:
        fetch_bbox = (frame["min_lon"], frame["max_lon"], frame["min_lat"], frame["max_lat"])
        fetch_buffer_m = 0.0
    else:
        fetch_bbox = (
            float(np.min(lons)), float(np.max(lons)),
            float(np.min(lats)), float(np.max(lats)),
        )
        fetch_buffer_m = req.satellite_buffer_m

    def _process_sat_image(sat_bytes: bytes, meta: dict) -> np.ndarray:
        """Decode the stitched tiles, apply the EOX brightness curve and (when
        rotating) resample into the line-aligned frame."""
        from PIL import Image
        arr = np.asarray(Image.open(io.BytesIO(sat_bytes)).convert("RGB"))
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
            arr = (
                np.clip(np.power(arr.astype(np.float32) / 255.0, inv_g), 0.0, 1.0)
                * 255.0
            ).astype(np.uint8)
        if frame is not None:
            arr = _resample_to_frame(
                arr, meta, frame, order=1,
                max_width_px=req.satellite_max_width_px,
            )
        return arr

    # Fetch satellite image before creating the figure so we can auto-size the
    # map panel to preserve the image's geographic aspect ratio.
    sat_arr = None
    sat_meta: Optional[dict] = None
    # Tracks which basemap was actually used, for the panel's footer annotation.
    sat_source_label: Optional[str] = None
    if "map" in panels:
        _sat_key = (
            "sat", req.basemap_source,
            int(req.eox_year) if req.basemap_source == "eox_s2cloudless" else None,
            fetch_bbox, fetch_buffer_m, int(req.satellite_max_width_px),
        )
        if req.basemap_source == "eox_s2cloudless":
            _sat_bytes, sat_meta = _cached(_sat_key, lambda: _stitch_bbox_eox_s2cloudless(
                *fetch_bbox,
                buffer_m=fetch_buffer_m,
                max_width_px=req.satellite_max_width_px,
                year=int(req.eox_year),
            ))
            sat_source_label = f"Sentinel-2 cloudless {int(req.eox_year)} · EOX"
        else:
            _sat_bytes, sat_meta = _cached(_sat_key, lambda: _stitch_bbox_satellite(
                *fetch_bbox,
                buffer_m=fetch_buffer_m,
                max_width_px=req.satellite_max_width_px,
            ))
            sat_source_label = "Google Satellite (HD)"
        if _sat_bytes is not None:
            sat_arr = _cached(
                (
                    _sat_key, "processed",
                    float(req.eox_brightness) if req.basemap_source == "eox_s2cloudless" else None,
                    _frame_key(frame),
                ),
                lambda: (_process_sat_image(_sat_bytes, sat_meta),),
            )[0]
            sat_aspect = sat_arr.shape[0] / sat_arr.shape[1]
            height_ratios[panels.index("map")] = _auto_panel_height_px(sat_aspect, "map")

    # JRC TMF AnnualChanges fetch — shared by the optional 2D panel (buffered
    # bbox, full image) and the optional 1D strip above the heatmap (which
    # samples this same array at each transect (lon, lat)).  Doing one fetch
    # rather than two halves the Earth Engine round-trip when both are on.
    ee_arr = None
    ee_meta: Optional[dict] = None
    # The 2D panel's (possibly line-aligned) copy; the strip keeps sampling the
    # north-up `ee_arr` by lon/lat.
    ee_panel_arr = None
    if "ee_annualchanges" in panels or "ee_strip" in panels:
        # Use the satellite buffer when the 2D panel is on (it needs the buffered
        # context around the line); a tiny buffer is enough when only the strip
        # is on (we sample at the line, the bbox just needs to be non-degenerate).
        if "ee_annualchanges" in panels:
            _ee_bbox, _ee_buffer_m = fetch_bbox, fetch_buffer_m
        else:
            _ee_bbox = (
                float(np.min(lons)), float(np.max(lons)),
                float(np.min(lats)), float(np.max(lats)),
            )
            _ee_buffer_m = 10.0
        _ee_key = ("ee", _ee_bbox, _ee_buffer_m, 2048)
        ee_arr, ee_meta = _cached(_ee_key, lambda: _fetch_ee_annualchanges_array(
            *_ee_bbox,
            buffer_m=_ee_buffer_m,
            max_dimension=2048,
        ))
        if ee_arr is not None and "ee_annualchanges" in panels:
            ee_panel_arr = (
                _cached(
                    (_ee_key, "rotated", _frame_key(frame)),
                    lambda: (_resample_to_frame(ee_arr, ee_meta, frame, order=0, max_width_px=2048),),
                )[0]
                if frame is not None else ee_arr
            )

    # Map-layer panels: stitch each layer's XYZ tiles (composited bottom-first
    # for grouped layers) over the same bbox as the satellite, then rotate into
    # the line frame like it. None → the panel says "unavailable".
    layer_arrs: List[Optional[np.ndarray]] = []
    layer_metas: List[Optional[dict]] = []
    for _i, _layer in enumerate(req.map_layers):
        _arr, _meta = _fetch_map_layer(
            _layer, fetch_bbox, fetch_buffer_m, int(req.satellite_max_width_px),
        )
        if _arr is not None and frame is not None:
            _arr = _cached(
                (("xyz", tuple(s_.url for s_ in _layer.sources)), fetch_bbox, fetch_buffer_m,
                 int(req.satellite_max_width_px), "rotated", _frame_key(frame)),
                lambda: (_resample_to_frame(
                    _arr, _meta, frame, order=0, max_width_px=req.satellite_max_width_px,
                ),),
            )[0]
        layer_arrs.append(_arr)
        layer_metas.append(_meta)
        if _arr is not None:
            height_ratios[panels.index(f"layer{_i}")] = _auto_panel_height_px(
                _arr.shape[0] / _arr.shape[1], f"layer{_i}",
            )

    # Drop the strip from the layout if EE is unavailable — the heatmap stays;
    # we just don't insert an empty header row above it.
    if "ee_strip" in panels and ee_arr is None:
        _idx = panels.index("ee_strip")
        panels.pop(_idx)
        height_ratios.pop(_idx)

    if "ee_annualchanges" in panels and ee_panel_arr is not None:
        ee_aspect = ee_panel_arr.shape[0] / ee_panel_arr.shape[1]
        height_ratios[panels.index("ee_annualchanges")] = _auto_panel_height_px(
            ee_aspect, "ee_annualchanges",
        )

    total_h_px = sum(height_ratios)
    fig_h_in = total_h_px / LAYOUT_DPI
    avg_panel_h_in = fig_h_in / max(1, len(panels))

    # The remaining axis label ("Height (m)" on the heatmap) uses the
    # user-requested font size. Tick numerals on every axis (and the colorbar)
    # are 2 pt smaller so they sit visually subordinate to the labels.
    _tick_fs = max(6, req.font_size - 4)
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

    # No per-panel colorbar gutter — the heatmap's colorbar is an inset inside
    # the heatmap axes (lower-left), so every panel's plot rectangle ends at
    # the same x and no AxesDivider locator is in play.

    # Colormap matching the frontend hsl-based ramp (blue → orange).
    energy_cmap = build_energy_cmap()

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

    # The north arrow goes on the first line-aligned panel only.
    north_arrow_drawn = [False]

    def _draw_imshow_panel(ax, arr: np.ndarray, meta: dict, interpolation: str) -> None:
        """Draw an (H, W, 3+) array as a geographic imshow + the transect line
        on top, configured for the current `req.x_axis` orientation."""
        if frame is not None:
            # Line-aligned: columns map affinely onto the shared x-axis, rows
            # are metres across the line, so the transect is horizontal.
            buf = frame["buffer_m"]
            ax.imshow(
                arr,
                extent=(frame["x0"], frame["x1"], -buf, buf),
                aspect="auto",
                origin="upper",
                interpolation=interpolation,
            )
            ax.plot(x_vals, frame["perp"], color="#ff5252", linewidth=1.0)
            ax.set_ylim(-buf, buf)
            ax.set_yticks([])
            if not north_arrow_drawn[0]:
                _draw_north_arrow(ax)
                north_arrow_drawn[0] = True
            return
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
            ax.set_ylim(extent_lat[0], extent_lat[1])
            # Latitude axis — single mid-range tick (user-requested) with the
            # N/S-suffixed formatter. `FixedLocator`-style via `set_yticks` so
            # we get exactly one tick regardless of the data span (MaxNLocator
            # would still float between 0 and 2 ticks depending on the range).
            ax.yaxis.set_major_formatter(FuncFormatter(_fmt_lat))
            ax.set_yticks([(extent_lat[0] + extent_lat[1]) / 2.0])
        else:
            ax.imshow(
                np.transpose(arr, (1, 0, 2))[::-1],
                extent=(extent_lat[0], extent_lat[1], extent_lon[0], extent_lon[1]),
                aspect="auto",
                origin="upper",
                interpolation=interpolation,
            )
            ax.plot(lats, lons, color="#ff5252", linewidth=1.0)
            ax.set_ylim(extent_lon[0], extent_lon[1])
            # Longitude axis — user-requested 2 ticks total with E/W suffixes.
            ax.yaxis.set_major_formatter(FuncFormatter(_fmt_lon))
            ax.yaxis.set_major_locator(MaxNLocator(nbins=2, prune="both"))

    def _draw_north_arrow(ax) -> None:
        """North arrow (bottom-right) for a line-aligned panel. Drawn in data
        coordinates, so it stays geographically true even if the panel's
        aspect got clamped."""
        from matplotlib.patheffects import withStroke

        buf = frame["buffer_m"]
        # North in (t, s) metres, converted to (x-units, metres).
        n_t, n_s = frame["u"][1], frame["v"][1]
        x_per_m = (frame["x1"] - frame["x0"]) / frame["length"]
        # Bottom-right: free of the legend cards (top-left), source badges
        # (top-right) and the scale bar (bottom-left).
        cx = x_max - 0.05 * (x_max - x_min)
        cy = -0.45 * buf
        half = 0.22 * buf
        halo = [withStroke(linewidth=2.5, foreground="white")]
        ax.annotate(
            "",
            xy=(cx + half * n_t * x_per_m, cy + half * n_s),
            xytext=(cx - half * n_t * x_per_m, cy - half * n_s),
            arrowprops=dict(
                arrowstyle="-|>", color="black", lw=1.0,
                mutation_scale=8, path_effects=halo,
            ),
            zorder=6,
        )
        lab = half + 0.2 * buf
        ax.text(
            cx + lab * n_t * x_per_m, cy + lab * n_s, "N",
            ha="center", va="center",
            fontsize=max(5, req.font_size - 4), fontweight="bold",
            color="black", path_effects=halo, zorder=6,
        )

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
            if frame is not None:
                m_per_xunit = frame["length"] / (frame["x1"] - frame["x0"])
            else:
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

            # Source label (lower-right corner) — uses the shared badge style
            # so EOX vs. Google snapshots are self-identifying in exports.
            if sat_source_label and req.show_panel_labels:
                _source_badge(ax, sat_source_label)
        else:
            unavailable_label = (
                f"{sat_source_label} unavailable"
                if sat_source_label
                else "Satellite imagery unavailable"
            )
            ax.text(0.5, 0.5, unavailable_label, ha="center", va="center", transform=ax.transAxes)
            ax.set_yticks([])

    # ---- map-layer panels -----------------------------------------------
    # Legend cards need the final layout, so they're queued and drawn with
    # the heatmap's colorbar card near the end.
    layer_legend_cards: list = []
    for _i, _layer in enumerate(req.map_layers):
        ax = axes[panels.index(f"layer{_i}")]
        ax.set_facecolor("white")  # masked (transparent) pixels read as white
        if layer_arrs[_i] is not None:
            _draw_imshow_panel(ax, layer_arrs[_i], layer_metas[_i], "nearest")
            _lg = _layer.legend
            if _lg is not None and (
                (_lg.kind == "classes" and _lg.items)
                or (_lg.kind == "continuous" and len(_lg.colors) >= 2)
            ):
                layer_legend_cards.append((ax, _layer))
            elif req.show_panel_labels:
                _source_badge(ax, _layer.name)
        else:
            ax.text(
                0.5, 0.5, f"{_layer.name} unavailable",
                ha="center", va="center", transform=ax.transAxes,
                fontsize=max(7, req.font_size - 2), color="#666",
            )
            ax.set_yticks([])

    # ---- JRC TMF AnnualChanges panel ------------------------------------
    if "ee_annualchanges" in panels:
        ax = axes[panels.index("ee_annualchanges")]
        if ee_panel_arr is not None and ee_meta is not None:
            _draw_imshow_panel(ax, ee_panel_arr, ee_meta, "nearest")  # preserve sharp class boundaries
            # Footer annotation so the reader knows what they're looking at
            # (an axis title would crowd into the panel above).
            if req.show_panel_labels:
                _source_badge(ax, "JRC TMF AnnualChanges · Dec 2020")
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
        # Rows come from profiles that hold data: all-empty placeholders in
        # older saved transects can be longer (MAX_HEIGHT / bin) and would
        # squash the real profiles toward the ground.
        n_bins = max(
            1,
            max(
                (len(s.profile) for s in samples
                 if any(not p.missing and p.value is not None for p in s.profile)),
                default=int(round(max_h / max(1.0, req.height_bin_m))),
            ),
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
        # ax.set_ylabel("Height (m)")
        ax.set_ylim(0, max_h)
        ax.grid(False)
        # Sparse y-ticks so the heatmap reads as a strip; default ~6 ticks is
        # noisy at typical export sizes. Lock to exactly 3 ticks at the bottom,
        # mid-height, and top of the panel — `MaxNLocator(nbins=2)` previously
        # used here is only an *upper bound* and can still surface 4+ ticks
        # when it finds nicer round values in the data span.
        ax.set_yticks([0.0,  max_h]) # max_h / 2.0,
        ax.set_yticklabels(['0', f'{max_h:.0f}m']) # f'{max_h / 2.0:.0f}m'
        # The colorbar card (top-left) is drawn after the final layout — see
        # `_draw_colorbar_card` near the end of this function.
        heatmap_mesh = mesh
        # Top-right source label — pinned where the data is sparsest (canopy
        # top is mostly low-energy blue, so a white-backed badge sits
        # comfortably without obscuring meaningful cells).
        if req.show_panel_labels:
            _source_badge(ax, "VSM Vertical Profile")

    # ---- Merged metrics panel (FHD / 1D ENL / 2D ENL / CR) --------------
    # By default all four metrics share the left y-axis with integer ticks.
    # When `req.cr_own_yaxis` is True AND CR is plotted alongside at least one
    # of the other three, CR moves to a `twinx()` right y-axis with its own
    # 0..1.1 scale; if CR is the only metric, it stays on the primary axis.
    metrics_twin_ax = None  # populated only when CR is on a twin axis
    if "metrics" in panels:
        ax = axes[panels.index("metrics")]
        fhd = np.array([s.fhd if s.fhd is not None else np.nan for s in samples], dtype=float)
        enl1 = np.array([s.enl1d if s.enl1d is not None else np.nan for s in samples], dtype=float)
        enl2 = np.array([s.enl2d if s.enl2d is not None else np.nan for s in samples], dtype=float)
        cr = np.array([s.cr if s.cr is not None else np.nan for s in samples], dtype=float)
        has_left = req.show_fhd or req.show_enl1d or req.show_enl2d
        cr_on_twin = req.show_cr and req.cr_own_yaxis and has_left

        # Left axis lines (FHD / 1D ENL / 2D ENL, plus CR when it shares).
        if req.show_fhd and np.any(np.isfinite(fhd)):
            ax.plot(x_vals, fhd, label="FHD", color="#1f77b4", linewidth=1.5)
        if req.show_enl1d and np.any(np.isfinite(enl1)):
            ax.plot(x_vals, enl1, label="1D ENL", color="#2ca02c", linewidth=1.5)
        if req.show_enl2d and np.any(np.isfinite(enl2)):
            ax.plot(x_vals, enl2, label="2D ENL", color="#d62728", linewidth=1.5)
        if req.show_cr and not cr_on_twin and np.any(np.isfinite(cr)):
            ax.plot(x_vals, cr, label="CR", color="#9467bd", linewidth=1.5)

        # No ylabel on the metrics panel — the legend below the figure
        # identifies each line, so a redundant "Diversity indices" / "CR"
        # label would just steal horizontal real estate.
        if has_left or not req.show_cr:
            # [0, 11] fits FHD / ENL at the default 5 m bins (ENL ~3–8). Finer
            # bins push ENL much higher (≈25 at 1 m), so grow the top to the
            # 99th percentile of the plotted lines (ignores rare 2D-ENL spikes)
            # plus headroom for the legend / source badge.
            _left = [
                arr for show, arr in (
                    (req.show_fhd, fhd), (req.show_enl1d, enl1),
                    (req.show_enl2d, enl2), (req.show_cr and not cr_on_twin, cr),
                ) if show
            ]
            _vals = np.concatenate(_left) if _left else np.array([])
            _vals = _vals[np.isfinite(_vals)]
            y_top = 11.0
            if _vals.size:
                y_top = max(y_top, float(np.ceil(np.percentile(_vals, 99) * 1.25)))
            ax.set_ylim(0, y_top)
            # Integer y-ticks — sparse (≤5) so the
            # panel reads as a strip rather than a dense ladder, and
            # `integer=True` forces whole-number values regardless of the span.
            # `prune="upper"` drops the topmost tick so the source badge
            # sitting above the data doesn't visually collide with a label.
            ax.yaxis.set_major_locator(MaxNLocator(nbins=3, integer=True, prune="upper"))
        else:
            # CR-only on the primary axis — keep the dedicated 0..1.1 scale
            # so the line uses the full panel height rather than the upper
            # sliver an integer-tick auto-range would leave it in.
            ax.set_ylim(0, 1.1)
            ax.set_yticks([0.0, 0.5, 1.0])

        # CR on its own twin right y-axis (only when paired with left-axis lines).
        if cr_on_twin:
            metrics_twin_ax = ax.twinx()
            # The cbar gutter lives in subplots_adjust's right margin (not in
            # a per-axis divider), so `twinx()` naturally inherits the parent
            # axes' bbox via the shared subplotspec — no locator copy needed
            # for the twin's right spine to line up with every other panel.
            if np.any(np.isfinite(cr)):
                metrics_twin_ax.plot(
                    x_vals, cr, label="CR", color="#9467bd", linewidth=1.5,
                )
            metrics_twin_ax.set_ylim(0, 1.1)
            metrics_twin_ax.tick_params(axis="y", labelsize=_tick_fs)
            metrics_twin_ax.set_yticks([0.0, 0.5, 1.0])

        ax.grid(True, linestyle=":", linewidth=0.6, alpha=0.5)
        # Top-right source label — drawn on the twin axis (when CR sits there)
        # so it renders above the primary grid; the panel's data fits below
        # `y=8` (or `y=1.0` for CR-only) so the badge has clear space above.
        if req.show_panel_labels:
            _source_badge(
                metrics_twin_ax if metrics_twin_ax is not None else ax,
                "VSM Diversity indices"
                + (f" · {req.diversity_bin_m:g} m bins" if req.diversity_bin_m else ""),
            )

    # No x-axis label — cardinal-suffixed tick values are self-identifying.
    # Pin xlim on every axis (and the metrics twinx, when present) rather than
    # relying on `sharex=True` alone: per-axis autoscaling triggered by
    # successive `plot()` calls — especially with `twinx()` — can drift a
    # fraction of a unit past x_max, making that row's x-axis spine visibly
    # longer than the panels above.  Setting xlim explicitly here guarantees
    # an identical span everywhere.
    for ax_obj in axes:
        ax_obj.set_xlim(x_min, x_max)
    if metrics_twin_ax is not None:
        metrics_twin_ax.set_xlim(x_min, x_max)
    # Sparse x-ticks with cardinal-suffixed labels (sharex propagates this to
    # every panel above). Longitude → 2 ticks; latitude → a single mid-range
    # tick (both user-requested, since transect bboxes are typically narrow).
    if req.x_axis == "lon":
        axes[-1].xaxis.set_major_locator(MaxNLocator(nbins=2, prune="both"))
        axes[-1].xaxis.set_major_formatter(FuncFormatter(_fmt_lon))
    else:
        axes[-1].set_xticks([(x_min + x_max) / 2.0])
        axes[-1].xaxis.set_major_formatter(FuncFormatter(_fmt_lat))

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

    # The metric legend is rendered as the right column of the bottom legend
    # strip (alongside the JRC TMF class legend) — see the post-layout block
    # at the end of this function. The heatmap colorbar is no longer part of
    # this strip; it lives as an inset inside the heatmap panel.
    for ax_obj in axes[:-1]:
        ax_obj.tick_params(axis='x', labelbottom=False, length=0)

    # Glue the JRC strip flush against the top of the heatmap, then shift the
    # panels above it down by exactly the original strip↔heatmap gridspec gap
    # so every remaining inter-panel gap (satellite↔JRC, JRC↔strip,
    # heatmap↔metrics) ends up equal to one `hspace`. The strip is treated as
    # the heatmap's header band — the only zero-gap join in the figure.
    # Now that no axis carries an AxesDivider locator (the cbar gutter is
    # part of the figure's right margin), these set_position calls are
    # durable — they survive subsequent draws and savefig.
    if "ee_strip" in panels and "heatmap" in panels:
        strip_ax = axes[panels.index("ee_strip")]
        hm_ax = axes[panels.index("heatmap")]
        strip_pos = strip_ax.get_position()
        hm_pos = hm_ax.get_position()
        new_y0 = hm_pos.y0 + hm_pos.height  # bottom of strip == top of heatmap
        shift_down = strip_pos.y0 - new_y0  # how far the strip moved down (>=0)
        strip_ax.set_position([strip_pos.x0, new_y0, strip_pos.width, strip_pos.height])
        # Shift every panel above the strip down by the same amount the strip
        # itself moved. That preserves the original gridspec gap between the
        # JRC-2D panel (or whatever sits directly above) and the strip — so it
        # matches every other inter-panel gap in the figure.
        strip_idx = panels.index("ee_strip")
        for i in range(strip_idx):
            above_ax = axes[i]
            pos = above_ax.get_position()
            above_ax.set_position([pos.x0, pos.y0 - shift_down, pos.width, pos.height])

    # Belt-and-suspenders: force every panel's horizontal plot-rect extent
    # to match the heatmap's (or the first panel's). The gridspec + the
    # explicit `set_xlim` loop above SHOULD already align everything, but
    # `twinx()` plus `plot()`-triggered autoscaling on the metrics axis can
    # leave the diversity-indices panel's right spine sitting a fraction of
    # a percent past every other panel's — visible as a "longer" x-axis. A
    # single draw lets all gridspec locators settle to their final bbox;
    # then copy that reference x0/width onto every other axis (including the
    # metrics twin, when present) so all spines line up exactly.
    fig.canvas.draw()
    ref_idx = panels.index("heatmap") if "heatmap" in panels else 0
    ref_pos = axes[ref_idx].get_position()
    for ax_obj in axes:
        pos = ax_obj.get_position()
        if abs(pos.x0 - ref_pos.x0) > 1e-6 or abs(pos.width - ref_pos.width) > 1e-6:
            ax_obj.set_position([ref_pos.x0, pos.y0, ref_pos.width, pos.height])
    if metrics_twin_ax is not None:
        twin_pos = metrics_twin_ax.get_position()
        metrics_twin_ax.set_position([ref_pos.x0, twin_pos.y0, ref_pos.width, twin_pos.height])

    # ---- Bottom legend strip (2 columns) -------------------------------
    # Left column: JRC TMF class swatches  ·  Right column: stacked metric
    # line legend. Both are anchored relative to the now-finalised bottom-most
    # panel position so the row stays horizontally aligned even after the
    # strip-glue and draw-pin steps above. `bbox_inches="tight"` on save will
    # extend the canvas downward to include whatever this strip emits. The
    # heatmap colorbar previously lived between these columns; it now sits as
    # an inset inside the heatmap panel itself.
    from matplotlib.patches import Patch  # local import — only used here

    bp = axes[-1].get_position()
    _strip_fs = max(7, req.font_size - 2)
    # Top edge of the strip in figure-fraction coords. ~6% of figure height
    # below the bottom panel — enough to clear the x-tick labels.
    strip_top_y = bp.y0 - 0.06
    # Equal-width columns centered at 1/6, 3/6, 5/6 of the bottom panel's
    # horizontal extent.
    col_centers = [bp.x0 + bp.width * (2 * i + 1) / 6.0 for i in range(3)]

    # Column 1 — JRC TMF class legend (palette index i ↔ class id i+1).
    if "ee_annualchanges" in panels or "ee_strip" in panels:
        jrc_patches = [
            Patch(
                facecolor=f"#{_JRC_TMF_ANNUALCHANGES_PALETTE[i]}",
                edgecolor="#888", linewidth=0.5,
                label=JRC_TMF_CLASSES.get(i + 1, str(i + 1)),
            )
            for i in range(len(_JRC_TMF_ANNUALCHANGES_PALETTE))
        ]
        fig.legend(
            handles=jrc_patches,
            loc="upper center",
            bbox_to_anchor=(col_centers[0], strip_top_y),
            bbox_transform=fig.transFigure,
            ncol=1,
            frameon=False,
            title="JRC TMF",
            title_fontsize=_strip_fs,
            fontsize=_strip_fs,
            handlelength=1.0,
            handletextpad=0.4,
            borderaxespad=0.0,
        )

    # Legend cards (heatmap colorbar + metric legend) share the map-overlay
    # look: top-left, white rounded card, light grey edge.
    from matplotlib.patches import FancyBboxPatch

    CARD_MARGIN_PT = 4.0
    CARD_FACE, CARD_ALPHA, CARD_EDGE, CARD_LW = "white", 0.92, "#bbbbbb", 0.5

    def _draw_colorbar_card(ax, mappable, title: str, unit: str) -> None:
        """Compact horizontal colorbar like the map's legend: one title line,
        a thin gradient bar, min / mid / max underneath (unit after max).
        Sized in points from the panel's final position."""
        fs = max(6, req.font_size - 4)
        pos = ax.get_position()
        ax_w_pt = pos.width * fig.get_figwidth() * 72.0
        ax_h_pt = pos.height * fig.get_figheight() * 72.0
        pad, bar_h, gap = 4.0, 4.0, 2.0
        # Wide enough for the title (≈0.55 em per character).
        card_w = max(90.0, 11.0 * fs, 0.55 * fs * len(title) + 2 * 4.0)
        card_h = pad + fs * 1.15 + gap + bar_h + gap + fs * 1.15 + pad
        fx, fy = 1.0 / ax_w_pt, 1.0 / ax_h_pt  # points → axes fraction
        x0 = CARD_MARGIN_PT * fx
        top = 1.0 - CARD_MARGIN_PT * fy
        ax.add_patch(FancyBboxPatch(
            (x0, top - card_h * fy), card_w * fx, card_h * fy,
            boxstyle="round,pad=0,rounding_size=0.004",
            transform=ax.transAxes,
            facecolor=CARD_FACE, alpha=CARD_ALPHA,
            edgecolor=CARD_EDGE, linewidth=CARD_LW, zorder=5,
        ))
        text_kw = dict(transform=ax.transAxes, fontsize=fs, zorder=7)
        ax.text(x0 + pad * fx, top - pad * fy, title, ha="left", va="top", color="#222", **text_kw)
        bar_top = top - (pad + fs * 1.15 + gap) * fy
        bar_l = x0 + pad * fx
        bar_w = (card_w - 2 * pad) * fx
        cax = ax.inset_axes([bar_l, bar_top - bar_h * fy, bar_w, bar_h * fy])
        cax.set_zorder(6)
        cbar = fig.colorbar(mappable, cax=cax, orientation="horizontal")
        cbar.set_ticks([])
        cbar.outline.set_linewidth(0.5)
        cbar.outline.set_edgecolor("#999")
        vmin, vmax = mappable.get_clim()

        def _fmt(v: float) -> str:
            return f"{v:.3g}" if abs(v) < 100 else f"{v:.0f}"

        label_y = bar_top - (bar_h + gap) * fy
        for frac, ha, v in ((0.0, "left", vmin), (0.5, "center", (vmin + vmax) / 2), (1.0, "right", vmax)):
            ax.text(
                bar_l + frac * bar_w, label_y,
                _fmt(v) + (f" {unit}" if frac == 1.0 and unit else ""),
                ha=ha, va="top", color="#555", **text_kw,
            )

    def _draw_class_card(ax, title: str, items) -> None:
        """Class legend card (top-left, same look as the colorbar card):
        title line, then swatch + label pairs wrapped into rows."""
        fs = max(6, req.font_size - 4)
        pos = ax.get_position()
        ax_w_pt = pos.width * fig.get_figwidth() * 72.0
        ax_h_pt = pos.height * fig.get_figheight() * 72.0
        pad, sw, gap, line_h = 4.0, 0.9 * fs, 3.0, fs * 1.3
        max_row_w = max(90.0, 0.6 * ax_w_pt - 2 * pad)
        # Lay out items into rows by estimated label width (≈0.55 em/char).
        rows, row, row_w = [], [], 0.0
        for it in items:
            w = sw + gap + 0.55 * fs * len(it.label) + 8.0
            if row and row_w + w > max_row_w:
                rows.append((row, row_w))
                row, row_w = [], 0.0
            row.append((it, w))
            row_w += w
        if row:
            rows.append((row, row_w))
        title_w = 0.55 * fs * len(title)
        card_w = max([title_w] + [rw for _, rw in rows]) + 2 * pad
        card_h = pad + fs * 1.15 + gap + line_h * len(rows) + pad - 2.0
        fx, fy = 1.0 / ax_w_pt, 1.0 / ax_h_pt
        x0 = CARD_MARGIN_PT * fx
        top = 1.0 - CARD_MARGIN_PT * fy
        ax.add_patch(FancyBboxPatch(
            (x0, top - card_h * fy), card_w * fx, card_h * fy,
            boxstyle="round,pad=0,rounding_size=0.004",
            transform=ax.transAxes,
            facecolor=CARD_FACE, alpha=CARD_ALPHA,
            edgecolor=CARD_EDGE, linewidth=CARD_LW, zorder=5,
        ))
        text_kw = dict(transform=ax.transAxes, fontsize=fs, zorder=7)
        ax.text(x0 + pad * fx, top - pad * fy, title, ha="left", va="top", color="#222", **text_kw)
        y = top - (pad + fs * 1.15 + gap) * fy
        for row_items, _ in rows:
            x = x0 + pad * fx
            yc = y - (line_h / 2.0) * fy
            for it, w in row_items:
                ax.add_patch(FancyBboxPatch(
                    (x, yc - (sw / 2.0) * fy), sw * fx, sw * fy,
                    boxstyle="square,pad=0", transform=ax.transAxes,
                    facecolor=it.color, edgecolor="#999", linewidth=0.4, zorder=6,
                ))
                ax.text(x + (sw + gap) * fx, yc, it.label, ha="left", va="center", color="#555", **text_kw)
                x += w * fx
            y -= line_h * fy

    if "heatmap" in panels:
        _draw_colorbar_card(axes[panels.index("heatmap")], heatmap_mesh, "Energy", "%")

    if layer_legend_cards:
        from matplotlib.cm import ScalarMappable
        from matplotlib.colors import LinearSegmentedColormap, Normalize

        for _ax, _layer in layer_legend_cards:
            _lg = _layer.legend
            # A legend that can't be drawn (e.g. an unparseable colour) falls
            # back to the plain name badge instead of failing the figure.
            try:
                if _lg.kind == "classes":
                    items = [
                        type(it)(color=matplotlib.colors.to_hex(_css_color(it.color), keep_alpha=True), label=it.label)
                        for it in _lg.items
                    ]
                    _draw_class_card(_ax, _layer.name, items)
                    continue
                _sm = ScalarMappable(
                    norm=Normalize(vmin=_lg.min, vmax=_lg.max),
                    cmap=LinearSegmentedColormap.from_list("layer", [_css_color(c) for c in _lg.colors]),
                )
                _draw_colorbar_card(_ax, _sm, _layer.name, _lg.unit)
            except Exception as e:  # noqa: BLE001 — decorative only
                print(f"[transect-figure] legend for {_layer.name!r} skipped: {e}")
                if req.show_panel_labels:
                    _source_badge(_ax, _layer.name)

    # Metric legend — top-left of the metrics panel, same card style. Drawn
    # on the twin axis (when CR sits there) so it renders above the primary
    # grid, matching the badge's z-order trick.
    if legend_handles and "metrics" in panels:
        legend_host = (
            metrics_twin_ax
            if metrics_twin_ax is not None
            else axes[panels.index("metrics")]
        )
        leg = legend_host.legend(
            legend_handles,
            legend_labels,
            loc="upper left",
            ncol=len(legend_handles),
            fontsize=max(6, req.font_size - 4),
            handlelength=1.2,
            handletextpad=0.4,
            columnspacing=1.0,
            borderpad=0.4,
            borderaxespad=CARD_MARGIN_PT / max(6, req.font_size - 4),
            fancybox=True,
            framealpha=CARD_ALPHA,
            facecolor=CARD_FACE,
            edgecolor=CARD_EDGE,
        )
        leg.get_frame().set_linewidth(CARD_LW)
        leg.get_frame().set_boxstyle("round,pad=0,rounding_size=0.3")
        leg.set_zorder(6)

    # Output buffer.
    #
    # `bbox_inches="tight"` crops the figure to the drawn content, so the saved
    # pixel width is NOT `figure_width_px` — the axes only fill `inner_frac` of
    # the canvas and the tight crop trims the rest, leaving the output at a
    # variable ~0.83–0.92× of the requested width. That makes the "Figure
    # width (px)" control feel capped/non-linear.
    #
    # Fix: render once to learn the tight-crop pixel width, then re-save at a
    # DPI corrected so the final width hits the target EXACTLY. We re-rasterize
    # (not resample) so vector text/lines stay crisp at any width.
    #
    # Target keeps the existing preview/export split: export (req.dpi == 150 ==
    # LAYOUT_DPI) lands exactly on `figure_width_px`; preview (req.dpi == 90)
    # stays proportionally lighter at the same `req.dpi / LAYOUT_DPI` ratio it
    # has today — but now linear and predictable instead of 0.83–0.92×.
    buf = io.BytesIO()
    if req.fmt == "pdf":
        # PDF is vector — physical size is set by figsize/tight bbox, not DPI;
        # a pixel-exact pass is meaningless here, so save once as before.
        fig.savefig(buf, format="pdf", dpi=req.dpi, bbox_inches="tight", pad_inches=0.1)
        plt.close(fig)
        return buf.getvalue(), "application/pdf"

    fmt = "jpg" if req.fmt == "jpg" else "png"
    media_type = "image/jpeg" if fmt == "jpg" else "image/png"
    save_kw = dict(format=fmt, bbox_inches="tight", pad_inches=0.1, facecolor="white")

    target_w_px = max(1, int(round(req.figure_width_px * (req.dpi / LAYOUT_DPI))))

    # Pass 1: measure the tight-crop width at the requested DPI.
    probe = io.BytesIO()
    fig.savefig(probe, dpi=req.dpi, **save_kw)
    probe.seek(0)
    from PIL import Image
    measured_w_px = Image.open(probe).size[0]

    if abs(measured_w_px - target_w_px) <= 1:
        # Already exact (within rounding) — reuse pass 1, no second render.
        buf = probe
    else:
        corrected_dpi = req.dpi * (target_w_px / measured_w_px)
        fig.savefig(buf, dpi=corrected_dpi, **save_kw)

    plt.close(fig)
    return buf.getvalue(), media_type
