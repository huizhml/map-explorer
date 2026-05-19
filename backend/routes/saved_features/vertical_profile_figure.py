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

    # Match the on-screen chart: x = curve value (energy), y = z (height).
    # Plot in height order so the polyline is monotonic in y (the backend
    # already returns z-sorted points; sort defensively).
    pts = [
        (float(p.value), float(p.z))
        for p in req.curve
        if p.value is not None and p.z is not None
    ]
    pts.sort(key=lambda t: t[1])
    xs = [t[0] for t in pts]
    ys = [t[1] for t in pts]

    fs = max(6, int(req.font_size))
    plt.rcParams["font.size"] = fs
    plt.rcParams["axes.labelsize"] = fs
    plt.rcParams["axes.titlesize"] = fs
    plt.rcParams["xtick.labelsize"] = max(5, fs - 2)
    plt.rcParams["ytick.labelsize"] = max(5, fs - 2)

    fig_w_in = max(1.0, req.figure_width_px / LAYOUT_DPI)
    fig_h_in = max(1.0, req.figure_height_px / LAYOUT_DPI)
    fig, ax = plt.subplots(figsize=(fig_w_in, fig_h_in))

    if xs:
        ax.plot(xs, ys, color=req.line_color, linewidth=1.6)
    ax.set_xlabel(req.x_label)
    ax.set_ylabel(req.y_label)
    if req.title:
        ax.set_title(req.title)
    ax.grid(True, linewidth=0.5, alpha=0.4)

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
    from PIL import Image as _PILImage

    measured_w_px = _PILImage.open(probe).size[0]

    if abs(measured_w_px - target_w_px) <= 1:
        # Already exact (within rounding) — reuse pass 1, no second render.
        buf = probe
    else:
        corrected_dpi = req.dpi * (target_w_px / measured_w_px)
        fig.savefig(buf, dpi=corrected_dpi, **save_kw)

    plt.close(fig)
    return buf.getvalue(), media_type
