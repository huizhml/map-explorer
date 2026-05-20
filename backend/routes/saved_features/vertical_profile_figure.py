"""Matplotlib rendering for the single derived vertical-profile curve.

Kept out of routes.py for the same reason as transect_figure.py: the
heavyweight matplotlib import stays off the hot module-load path.
"""

from __future__ import annotations

import io
from typing import Tuple

from .models import VerticalProfileFigureRequest

# Export DPI. Preview passes a lower req.dpi for a snappy refresh; the
# width-exact correction below makes "figure width (px)" land precisely
# regardless of dpi (identical layout for preview and export — same trick
# transect_figure.py uses).
LAYOUT_DPI = 150


def _render_vertical_profile_figure(req: VerticalProfileFigureRequest) -> Tuple[bytes, str]:
    """Render the derived vertical-profile curve (energy on x, height on y).

    Returns (binary, media_type). Synchronous — call from an executor.
    """
    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    # Match the on-screen chart: x = energy %, y = z (height). Per point:
    # `value` = smoothed envelope, `binned` = raw per-bin energy %. Plot in
    # height order so the polyline is monotonic in y (backend already returns
    # z-sorted points; sort defensively).
    pts = [
        (float(p.z), float(p.value), None if p.binned is None else float(p.binned))
        for p in req.curve
        if p.value is not None and p.z is not None
    ]
    pts.sort(key=lambda t: t[0])
    zs = [t[0] for t in pts]
    smoothed = [t[1] for t in pts]
    binned = [t[2] for t in pts]
    has_bars = bool(pts) and all(b is not None for b in binned)

    # Bar thickness = the bin spacing (median Δz), so contiguous bars read
    # as a filled silhouette like the on-screen chart.
    if len(zs) >= 2:
        diffs = sorted(zs[i + 1] - zs[i] for i in range(len(zs) - 1))
        bar_h = diffs[len(diffs) // 2] or 0.4
    else:
        bar_h = 0.4

    fs = max(6, int(req.font_size))
    plt.rcParams["font.size"] = fs
    plt.rcParams["axes.labelsize"] = fs
    plt.rcParams["axes.titlesize"] = fs
    plt.rcParams["xtick.labelsize"] = max(5, fs - 2)
    plt.rcParams["ytick.labelsize"] = max(5, fs - 2)

    fig_w_in = max(1.0, req.figure_width_px / LAYOUT_DPI)
    fig_h_in = max(1.0, req.figure_height_px / LAYOUT_DPI)
    fig, ax = plt.subplots(figsize=(fig_w_in, fig_h_in))

    if has_bars:
        ax.barh(
            zs,
            binned,
            height=bar_h,
            align="center",
            color=req.bar_color,
            edgecolor="none",
            label="Binned",
            zorder=1,
        )
    if smoothed:
        ax.plot(
            smoothed,
            zs,
            color=req.line_color,
            linewidth=1.8,
            label="Smoothed",
            zorder=3,
        )
    # Ground reference (z = 0). Only draw if within the visible y-range.
    lo = req.y_min if req.y_min is not None else (min(zs) if zs else 0.0)
    hi = req.y_max if req.y_max is not None else (max(zs) if zs else 1.0)
    if lo <= 0.0 <= hi:
        ax.axhline(
            0.0, linestyle="--", color="#8a6d4b", linewidth=1.2, zorder=2
        )

    ax.set_xlabel(req.x_label)
    ax.set_ylabel(req.y_label)
    if req.title:
        ax.set_title(req.title)
    # Fixed y-axis (head/foot room); energy starts at 0.
    if req.y_min is not None and req.y_max is not None:
        ax.set_ylim(req.y_min, req.y_max)
    ax.set_xlim(left=0.0)
    ax.grid(True, linewidth=0.5, alpha=0.4)
    if has_bars or smoothed:
        ax.legend(loc="lower right", frameon=True, fontsize=max(5, fs - 2))

    buf = io.BytesIO()
    if req.fmt == "pdf":
        # PDF is vector — physical size is figsize/tight-bbox, not dpi; the
        # pixel-exact pass is meaningless, so save once.
        fig.savefig(buf, format="pdf", dpi=req.dpi, bbox_inches="tight", pad_inches=0.1)
        plt.close(fig)
        return buf.getvalue(), "application/pdf"

    fmt = "jpg" if req.fmt == "jpg" else "png"
    media_type = "image/jpeg" if fmt == "jpg" else "image/png"
    save_kw = dict(format=fmt, bbox_inches="tight", pad_inches=0.1, facecolor="white")
    target_w_px = max(1, int(round(req.figure_width_px * (req.dpi / LAYOUT_DPI))))

    # Pass 1: measure the tight-crop width at the requested dpi.
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
