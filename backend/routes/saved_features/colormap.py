"""Shared blue→orange energy colormap for transect renders.

Used by both the flat 2D heatmap (`transect_figure.py`) and the 3D wall
(`transect_figure_3d.py`) so the two stay colour-matched. Mirrors the
HSL ramp the frontend SVG heatmap uses.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np


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


def build_energy_cmap(n_steps: int = 256):
    """Blue→orange LinearSegmentedColormap matching the frontend energy ramp."""
    from matplotlib.colors import LinearSegmentedColormap

    ramp_rgb = np.array([
        _hsl_to_rgb(235 - 175 * (i / (n_steps - 1)), 0.86, 0.28 + 0.34 * (i / (n_steps - 1)))
        for i in range(n_steps)
    ])
    return LinearSegmentedColormap.from_list("transect_energy", ramp_rgb, N=n_steps)
