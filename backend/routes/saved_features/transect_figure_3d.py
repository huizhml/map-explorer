"""BIOMASS-style 3D transect figure: satellite ground plane + vertical heatmap wall.

A perspective render where the satellite snapshot is draped flat as the ground
and the vertical-profile heatmap stands up as a wall along the transect line —
echoing ESA's BIOMASS canopy-structure visualisations.

Caveats (matplotlib's mplot3d is a painter's-algorithm renderer, not depth
buffered):
  * The satellite is downsampled to `req.ground_max_px` because every texel
    becomes a surface quad — so the ground is lower-res than the flat 2D panel.
  * With only two surfaces (flat ground + one wall) z-sorting is usually correct,
    but extreme camera angles can make the wall poke through the ground. The
    default camera is chosen to stay in the well-behaved range.
"""

from __future__ import annotations

import io
import math
from typing import Optional, Tuple

import numpy as np
from fastapi import HTTPException

from .colormap import build_energy_cmap
from .models import TransectFigureRequest
from .satellite import _stitch_bbox_eox_s2cloudless, _stitch_bbox_satellite


# Floor for the ground strip's perpendicular half-width, as a fraction of the
# transect length. Keeps the satellite reading as a flat plane even when the
# requested buffer is tiny relative to a long line (otherwise the strip is so
# thin it sits edge-on at the wall base and looks coplanar with the heatmap).
_MIN_GROUND_HALFWIDTH_FRAC = 0.12


def _local_meters(
    lons: np.ndarray,
    lats: np.ndarray,
    lon0: float,
    lat0: float,
    mean_lat_rad: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """Equirectangular lon/lat → local (east, north) metres about (lon0, lat0)."""
    x = (lons - lon0) * 111320.0 * math.cos(mean_lat_rad)
    y = (lats - lat0) * 111320.0
    return x, y


def _render_transect_figure_3d(req: TransectFigureRequest) -> Tuple[bytes, str]:
    """Render the 3D perspective transect figure. Returns (binary, media_type).

    Runs synchronously; call from an executor.
    """
    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt
    from matplotlib.cm import ScalarMappable
    from matplotlib.colors import Normalize
    from PIL import Image

    samples = req.samples
    if len(samples) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 transect samples to render figure")

    lons = np.array([s.lon for s in samples], dtype=float)
    lats = np.array([s.lat for s in samples], dtype=float)

    # ---- common local-metre frame (anchored at the samples) -------------
    lon0 = float(np.min(lons))
    lat0 = float(np.min(lats))
    mean_lat_rad = math.radians(float(np.mean(lats)))
    m_per_lon = 111320.0 * max(1e-6, math.cos(mean_lat_rad))
    wx, wy = _local_meters(lons, lats, lon0, lat0, mean_lat_rad)

    def _local_to_lonlat(xm: np.ndarray, ym: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        return lon0 + xm / m_per_lon, lat0 + ym / 111320.0

    # ---- oriented ground strip along the transect chord -----------------
    # The buffer widens the swath ONLY perpendicular to the line: the ground is
    # a strip whose long axis is the start→end chord and whose half-width is the
    # buffer. Increasing the buffer never extends ground past the line ends.
    sx, sy = float(wx[0]), float(wy[0])
    ex, ey = float(wx[-1]), float(wy[-1])
    chord = math.hypot(ex - sx, ey - sy) or 1.0
    ux, uy = (ex - sx) / chord, (ey - sy) / chord   # along-track unit vector
    perp_x, perp_y = -uy, ux                         # perpendicular unit vector
    # Perpendicular half-width. A razor-thin strip (small buffer on a long line)
    # sits edge-on at the wall's base and reads as if the satellite were on the
    # vertical plane, so floor the width to a fraction of the line length — the
    # ground then always reads as a flat plane. Larger explicit buffers win.
    hw = max(float(req.satellite_buffer_m), chord * _MIN_GROUND_HALFWIDTH_FRAC, 1.0)

    # Strip corners → axis-aligned bbox to fetch imagery for (small margin so
    # cell-centre sampling near the edges still lands on valid pixels).
    corner_s = np.array([0.0, 0.0, chord, chord])
    corner_w = np.array([hw, -hw, hw, -hw])
    c_lon, c_lat = _local_to_lonlat(
        sx + corner_s * ux + corner_w * perp_x,
        sy + corner_s * uy + corner_w * perp_y,
    )

    if req.basemap_source == "eox_s2cloudless":
        sat_bytes, sat_meta = _stitch_bbox_eox_s2cloudless(
            float(np.min(c_lon)), float(np.max(c_lon)),
            float(np.min(c_lat)), float(np.max(c_lat)),
            buffer_m=20.0, max_width_px=req.satellite_max_width_px,
            year=int(req.eox_year),
        )
        sat_source_label = f"Sentinel-2 cloudless {int(req.eox_year)} · EOX"
    else:
        sat_bytes, sat_meta = _stitch_bbox_satellite(
            float(np.min(c_lon)), float(np.max(c_lon)),
            float(np.min(c_lat)), float(np.max(c_lat)),
            buffer_m=20.0, max_width_px=req.satellite_max_width_px,
        )
        sat_source_label = "Google Satellite (HD)"

    if sat_bytes is None or sat_meta is None:
        raise HTTPException(status_code=502, detail="Satellite imagery unavailable for the transect bbox")

    sat_arr = np.asarray(Image.open(io.BytesIO(sat_bytes)).convert("RGB"))
    if (
        req.basemap_source == "eox_s2cloudless"
        and req.eox_brightness > 0
        and abs(req.eox_brightness - 1.0) > 1e-3
    ):
        inv_g = 1.0 / float(req.eox_brightness)
        sat_arr = (
            np.clip(np.power(sat_arr.astype(np.float32) / 255.0, inv_g), 0.0, 1.0) * 255.0
        ).astype(np.uint8)

    # Strip mesh resolution: each cell becomes a ground quad. Along-track is
    # capped by `ground_max_px`; cross-track scales with the strip aspect ratio.
    n_along = max(2, int(req.ground_max_px))
    n_cross = max(2, min(200, int(round(n_along * (2.0 * hw) / chord))))
    s_edges = np.linspace(0.0, chord, n_along + 1)
    w_edges = np.linspace(-hw, hw, n_cross + 1)
    S_e, W_e = np.meshgrid(s_edges, w_edges)        # (n_cross+1, n_along+1)
    GX = sx + S_e * ux + W_e * perp_x
    GY = sy + S_e * uy + W_e * perp_y
    GZ = np.zeros_like(GX)

    # Colour each cell by sampling the fetched image at its centre lon/lat.
    s_c = (s_edges[:-1] + s_edges[1:]) / 2.0
    w_c = (w_edges[:-1] + w_edges[1:]) / 2.0
    S_c, W_c = np.meshgrid(s_c, w_c)                 # (n_cross, n_along)
    cell_lon, cell_lat = _local_to_lonlat(
        sx + S_c * ux + W_c * perp_x,
        sy + S_c * uy + W_c * perp_y,
    )
    H_img, W_img = sat_arr.shape[:2]
    lon_span = max(1e-12, sat_meta["max_lon"] - sat_meta["min_lon"])
    lat_span = max(1e-12, sat_meta["max_lat"] - sat_meta["min_lat"])
    col = np.clip(
        np.round((cell_lon - sat_meta["min_lon"]) / lon_span * (W_img - 1)).astype(int),
        0, W_img - 1,
    )
    row = np.clip(  # image is origin='upper': row 0 = max_lat
        np.round((sat_meta["max_lat"] - cell_lat) / lat_span * (H_img - 1)).astype(int),
        0, H_img - 1,
    )
    ground_facecolors = np.empty((n_cross, n_along, 4), dtype=float)
    ground_facecolors[..., :3] = sat_arr[row, col, :].astype(float) / 255.0
    ground_facecolors[..., 3] = 1.0

    # 3D box extent = strip bounding box in local metres.
    gx0, gx1 = float(GX.min()), float(GX.max())
    gy0, gy1 = float(GY.min()), float(GY.max())
    Lx = max(1.0, gx1 - gx0)
    Ly = max(1.0, gy1 - gy0)

    # ---- heatmap wall ---------------------------------------------------
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

    # Edge positions along the polyline path (midpoints + extrapolated ends), so
    # each grid column maps to exactly one quad — same scheme as the 2D figure.
    # `wx`, `wy` (sample positions in local metres) are computed above.
    def _edges(vals: np.ndarray) -> np.ndarray:
        e = np.empty(len(vals) + 1)
        mid = (vals[:-1] + vals[1:]) / 2.0
        e[1:-1] = mid
        e[0] = vals[0] - (mid[0] - vals[0])
        e[-1] = vals[-1] + (vals[-1] - mid[-1])
        return e

    wx_e = _edges(wx)
    wy_e = _edges(wy)
    z_edges = np.linspace(0.0, max_h, n_bins + 1)

    # Wall vertices: (n_bins+1) rows (height) × (N+1) cols (along path).
    WX = np.tile(wx_e, (n_bins + 1, 1))
    WY = np.tile(wy_e, (n_bins + 1, 1))
    WZ = np.tile(z_edges.reshape(-1, 1), (1, len(samples) + 1))

    energy_cmap = build_energy_cmap()
    z_max = float(req.heatmap_colormap_max)
    z_min = float(np.nanmin(grid)) if np.isfinite(np.nanmin(grid)) else 0.0
    norm = Normalize(vmin=z_min, vmax=z_max)
    wall_facecolors = energy_cmap(norm(grid))           # (n_bins, N, 4)
    wall_facecolors[np.isnan(grid)] = (0.0, 0.0, 0.0, 0.0)  # missing → transparent

    # ---- figure / camera ------------------------------------------------
    LAYOUT_DPI = 150
    fig_w_in = req.figure_width_px / LAYOUT_DPI
    fig_h_in = fig_w_in * 0.5
    plt.rcParams["font.size"] = req.font_size

    fig = plt.figure(figsize=(fig_w_in, fig_h_in))
    ax = fig.add_subplot(111, projection="3d", computed_zorder=False)

    # `rasterized=True` + `edgecolor="none"`: in vector output (PDF/SVG) each
    # surface quad is its own polygon and antialiased polygon edges leave visible
    # hairline seams between cells — the "grid" artifact. Rasterising embeds each
    # surface as one image inside the PDF, killing the seams while axes/text stay
    # vector (same rationale as the 2D heatmap's rasterized pcolormesh).
    # `clip_on=False`: when the scene is zoomed in, content extends past the 3D
    # axes' 2D bounding rectangle; by default matplotlib clips it there, leaving
    # a hard straight cut at the frame edge. Disabling clip lets the full surface
    # draw; `bbox_inches="tight"` then crops the figure to the real content.
    ax.plot_surface(
        GX, GY, GZ,
        facecolors=ground_facecolors,
        rstride=1, cstride=1,
        shade=False, antialiased=False, linewidth=0,
        edgecolor="none", rasterized=True, clip_on=False,
    )
    ax.plot_surface(
        WX, WY, WZ,
        facecolors=wall_facecolors,
        rstride=1, cstride=1,
        shade=False, antialiased=False, linewidth=0,
        edgecolor="none", rasterized=True, clip_on=False,
    )

    # Exaggerate the wall height so a ~100 m canopy reads against a multi-km swath.
    # `zoom` (>1) enlarges the scene in the frame so it isn't lost in whitespace.
    wall_visual = max(Lx, Ly) * max(0.01, req.vertical_exag)
    ax.set_box_aspect((Lx, Ly, wall_visual), zoom=max(0.5, float(req.view_zoom)))
    ax.set_xlim(gx0, gx1)
    ax.set_ylim(gy0, gy1)
    ax.set_zlim(0.0, max_h)

    # Camera: auto-azimuth gives the BIOMASS 3/4 view — perpendicular to the
    # transect (wall readable) plus a 30° swing so the swath recedes diagonally
    # rather than sitting dead face-on. Overridable via `view_azim`.
    if req.view_azim is None:
        bearing = math.degrees(math.atan2(wy[-1] - wy[0], wx[-1] - wx[0]))
        azim = bearing - 90.0 + 30.0
    else:
        azim = float(req.view_azim)
    ax.view_init(elev=float(req.view_elev), azim=azim)

    # Clean chrome: transparent panes, no grid. Geographic lon/lat ticks run
    # along the ground edges; the height axis is drawn manually below as a ruler
    # at the wall's near edge (the native z-axis lands behind the wall at a far
    # box corner, which is what we're avoiding).
    ax.grid(False)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_visible(False)
    ax.set_zticks([])
    ax.zaxis.line.set_color((1, 1, 1, 0))

    # Lon/lat ticks: convert the local-metre tick positions back to degrees and
    # label with a cardinal suffix (matches the 2D figure's self-identifying
    # axis labels, so no separate "Longitude"/"Latitude" title is needed).
    # `m_per_lon` is defined with the local frame above.
    def _fmt_lon(v: float) -> str:
        return "0.00°" if v == 0 else f"{abs(v):.2f}°{'E' if v > 0 else 'W'}"

    def _fmt_lat(v: float) -> str:
        return "0.00°" if v == 0 else f"{abs(v):.2f}°{'N' if v > 0 else 'S'}"

    x_ticks = np.linspace(gx0, gx1, 3)
    y_ticks = np.linspace(gy0, gy1, 2)
    lon_labels = [_fmt_lon(lon0 + xv / m_per_lon) for xv in x_ticks]
    # Native 3D tick labels render horizontal and drift off the axis. Keep the
    # tick positions (so the grey ground edge reads as an axis) but hide the
    # native labels — they're redrawn by hand, rotated parallel to each edge,
    # in the geo-label block once the projection has settled (after canvas.draw).
    ax.set_xticks(x_ticks)
    ax.set_yticks(y_ticks)
    ax.set_xticklabels([])
    ax.set_yticklabels([])
    _geo_fs = max(6, req.font_size - 3)
    ax.tick_params(axis="x", labelsize=_geo_fs, length=0)
    ax.tick_params(axis="y", labelsize=_geo_fs, length=0)
    # Subtle ground edge lines so the lon/lat ticks read against an axis.
    ax.xaxis.line.set_color("#9e9e9e")
    ax.yaxis.line.set_color("#9e9e9e")

    # ---- project the wall's near edge to figure coords -------------------
    # Both the height ruler and the colourbar anchor to this, so compute it
    # first. Projected to 2D so the ruler sits ON the heatmap's near edge rather
    # than behind it at a far box corner (where mpl's native z-axis would land).
    from matplotlib.lines import Line2D
    from mpl_toolkits.mplot3d import proj3d

    fig.canvas.draw()  # settle the projection so get_proj() is current

    def _to_fig(x: float, y: float, z: float) -> Tuple[float, float]:
        xp, yp, _ = proj3d.proj_transform(x, y, z, ax.get_proj())
        dx, dy = ax.transData.transform((xp, yp))
        fx, fy = fig.transFigure.inverted().transform((dx, dy))
        return float(fx), float(fy)

    # The wall's two vertical end-edges; the ruler goes on the left-most one
    # (the wall body then extends to its right, matching the reference figure).
    ends = [(float(wx_e[0]), float(wy_e[0])), (float(wx_e[-1]), float(wy_e[-1]))]
    near = min(ends, key=lambda e: _to_fig(e[0], e[1], 0.0)[0])
    # Two ticks only — base and top — the top carrying the unit ("50m").
    tick_vals = [0.0, max_h]
    tick_labels = ["0", f"{int(round(max_h))}m"]
    tick_fig = [_to_fig(near[0], near[1], zz) for zz in tick_vals]

    # Colourbar (energy scale) — top-left, ticks/label on its left side. Anchored
    # to the wall so its top stays at/under the max-height (e.g. 50 m) mark
    # instead of floating above it: the bar top sits just below that tick and
    # drops down from there, its height tracking the 0→max visual span (clamped).
    base_y, top_y = tick_fig[0][1], tick_fig[-1][1]
    cbar_h = min(0.30, max(0.16, top_y - base_y))
    cbar_top = top_y - 0.01  # small gap so the top tick label can't poke past 50 m
    cax = fig.add_axes([0.10, max(0.02, cbar_top - cbar_h), 0.013, cbar_h])
    sm = ScalarMappable(norm=norm, cmap=energy_cmap)
    sm.set_array([])
    cbar = fig.colorbar(sm, cax=cax)
    cax.yaxis.set_ticks_position("left")
    cax.yaxis.set_label_position("left")
    cbar.set_label("Energy (%)", fontsize=max(7, req.font_size - 2))
    cbar.ax.tick_params(labelsize=max(6, req.font_size - 3))

    # Source badge — top-left, clear of the bottom-right lon/lat tick labels.
    fig.text(
        0.01, 0.98, sat_source_label,
        ha="left", va="top", fontsize=max(6, req.font_size - 4), color="#444",
    )

    # ---- height axis: the ruler at the wall's near (left-most) vertical edge --
    _axis_fs = max(7, req.font_size - 1)
    fig.add_artist(Line2D(  # vertical spine along the wall's near edge
        [tick_fig[0][0], tick_fig[-1][0]], [tick_fig[0][1], tick_fig[-1][1]],
        color="#333", lw=1.0, transform=fig.transFigure, clip_on=False,
    ))
    for (fx, fy), label in zip(tick_fig, tick_labels):
        fig.add_artist(Line2D(
            [fx - 0.009, fx], [fy, fy], color="#333", lw=1.0,
            transform=fig.transFigure, clip_on=False,
        ))
        fig.text(fx - 0.013, fy, label, ha="right", va="center", fontsize=_axis_fs)

    # ---- lon/lat labels: rotated to run parallel to their ground edge --------
    # Place each label just outside its edge and rotate it to the edge's on-screen
    # angle so the text follows the axis. Longitude rides the front (lower) x-edge,
    # pushed out and nudged left; latitude rides the right y-edge, pulled in close.
    def _to_disp(x: float, y: float, z: float = 0.0) -> Tuple[float, float]:
        xp, yp, _ = proj3d.proj_transform(x, y, z, ax.get_proj())
        dx, dy = ax.transData.transform((xp, yp))
        return float(dx), float(dy)

    cx_d, cy_d = _to_disp((gx0 + gx1) / 2.0, (gy0 + gy1) / 2.0)

    def _axis_angle(wx0: float, wy0: float, wx1: float, wy1: float) -> float:
        ax0, ay0 = _to_disp(wx0, wy0)
        ax1, ay1 = _to_disp(wx1, wy1)
        ang = math.degrees(math.atan2(ay1 - ay0, ax1 - ax0))
        if ang > 90:        # keep text upright rather than upside-down
            ang -= 180
        elif ang < -90:
            ang += 180
        return ang

    def _edge_normal(wx0: float, wy0: float, wx1: float, wy1: float) -> Tuple[float, float]:
        """Unit screen-space normal of an edge, flipped to point away from the
        ground centre. Offsetting along this (fixed per edge) moves every tick on
        the edge uniformly off the axis — unlike a radial-from-centre offset,
        which only clears the mid-edge tick while corner ticks slide along it."""
        d0x, d0y = _to_disp(wx0, wy0)
        d1x, d1y = _to_disp(wx1, wy1)
        ex, ey = d1x - d0x, d1y - d0y
        el = math.hypot(ex, ey) or 1.0
        nx, ny = -ey / el, ex / el
        mx, my = (d0x + d1x) / 2.0, (d0y + d1y) / 2.0
        if (mx - cx_d) * nx + (my - cy_d) * ny < 0:   # ensure it points outward
            nx, ny = -nx, -ny
        return nx, ny

    def _place_geo(wx_: float, wy_: float, text: str, ang: float,
                   nx: float, ny: float, offset_px: float, left_px: float = 0.0) -> None:
        px, py = _to_disp(wx_, wy_)
        px += nx * offset_px - left_px           # offset along the edge's normal
        py += ny * offset_px
        fx, fy = fig.transFigure.inverted().transform((px, py))
        fig.text(float(fx), float(fy), text, ha="center", va="center",
                 rotation=ang, rotation_mode="anchor", fontsize=_geo_fs, color="#222")

    # Longitude: the y-constant edge sitting lower on screen (the front edge).
    y_lon = gy0 if _to_disp((gx0 + gx1) / 2.0, gy0)[1] <= _to_disp((gx0 + gx1) / 2.0, gy1)[1] else gy1
    lon_ang = _axis_angle(gx0, y_lon, gx1, y_lon)
    lon_nx, lon_ny = _edge_normal(gx0, y_lon, gx1, y_lon)
    for xv, lab in zip(x_ticks, lon_labels):
        _place_geo(xv, y_lon, lab, lon_ang, lon_nx, lon_ny, offset_px=32.0, left_px=0.0)

    # Latitude: a single tick at the wall's far-end base (the transect-line point
    # opposite the height ruler), instead of two ticks on the ground strip's outer
    # edges. The transect is ~constant latitude, so one reading right at the wall
    # is clearer. Rotation follows the north (y) direction on screen.
    wall_ends = [
        (float(wx[0]), float(wy[0]), float(lats[0])),
        (float(wx[-1]), float(wy[-1]), float(lats[-1])),
    ]
    far_x, far_y, far_lat = max(wall_ends, key=lambda e: _to_disp(e[0], e[1])[0])
    lat_ang = _axis_angle(far_x, gy0, far_x, gy1)
    lat_nx, lat_ny = _edge_normal(far_x, gy0, far_x, gy1)
    _place_geo(far_x, far_y, _fmt_lat(far_lat), lat_ang, lat_nx, lat_ny, offset_px=12.0)

    # ---- output ---------------------------------------------------------
    buf = io.BytesIO()
    if req.fmt == "pdf":
        fig.savefig(buf, format="pdf", dpi=req.dpi, bbox_inches="tight", pad_inches=0.1)
        plt.close(fig)
        return buf.getvalue(), "application/pdf"

    fmt = "jpg" if req.fmt == "jpg" else "png"
    media_type = "image/jpeg" if fmt == "jpg" else "image/png"
    target_w_px = max(1, int(round(req.figure_width_px * (req.dpi / LAYOUT_DPI))))
    fig.savefig(buf, format=fmt, dpi=target_w_px / fig_w_in, bbox_inches="tight",
                pad_inches=0.1, facecolor="white")
    plt.close(fig)
    return buf.getvalue(), media_type
