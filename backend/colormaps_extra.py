"""Register extra colormaps (seaborn 'mako', flooded-forest ramps) into
rio_tiler and matplotlib.

Mako isn't built into either registry, but we want it usable as a tile-renderer
name (via /cog/tiles and /predictions/interval-tile) AND a matplotlib name (via
the save-figures path in area_images.py). Doing both keeps a single colormap
identifier flowing from the frontend dropdown all the way through tile
rendering and PNG/PDF export.
"""
from __future__ import annotations

import numpy as np
import seaborn as sns
from rio_tiler.colormap import cmap as _rio_cmap


def _register_lut(name: str, lut: np.ndarray) -> None:
    """Register a 256x4 uint8 RGBA lookup table under `name`."""
    # rio_tiler: mutate the singleton's .data so every consumer that already
    # imported `cmap` sees it too.
    if name not in _rio_cmap.data:
        _rio_cmap.data[name] = {i: tuple(int(v) for v in lut[i]) for i in range(256)}

    # matplotlib: needed by the figure-save path (area_images.py) which does
    # `ax.imshow(..., cmap=name)`.
    try:
        from matplotlib.colors import ListedColormap
        import matplotlib as mpl
    except Exception:
        return
    cmap_obj = ListedColormap(lut.astype(np.float32) / 255.0, name=name)
    try:
        mpl.colormaps.register(cmap_obj, name=name)
    except (ValueError, AttributeError):
        # Already registered, or older matplotlib without the new registry.
        try:
            mpl.cm.register_cmap(name=name, cmap=cmap_obj)
        except Exception:
            pass


def _register_mako() -> None:
    # sns.color_palette returns RGB floats in 0..1 — quantize to RGBA uint8.
    palette = sns.color_palette("mako", n_colors=256, as_cmap=False)
    lut = np.array(
        [[int(round(c * 255)) for c in (*rgb, 1.0)] for rgb in palette],
        dtype=np.uint8,
    )
    _register_lut("mako", lut)


def _lut_from_stops(stops: list[tuple[str, int]]) -> np.ndarray:
    """Linearly interpolate evenly spaced (hex, alpha) stops into a 256-entry LUT."""
    rgba = np.array(
        [[int(h[i:i + 2], 16) for i in (1, 3, 5)] + [a] for h, a in stops],
        dtype=np.float64,
    )
    xs = np.linspace(0, 255, len(stops))
    lut = np.stack([np.interp(np.arange(256), xs, rgba[:, c]) for c in range(4)], axis=1)
    return np.round(lut).astype(np.uint8)


# Flooded-forest layers: colour ramps copied from the QGIS styles (*.qml) that
# ship next to the rasters. Stops are evenly spaced over each layer's rescale
# range, which is set in src/constants/floodedForest.ts — keep the two in sync.
FLOODED_FOREST_RAMPS: dict[str, list[tuple[str, int]]] = {
    # 0..366 days
    "ff_flood_duration": [
        ("#f2ead3", 255), ("#d6dca0", 255), ("#9bc16b", 255),
        ("#4f9a4a", 255), ("#1e5b34", 255), ("#0b0b0b", 255),
    ],
    # 0..100 %; 0 % fades out so only observed water shows.
    "ff_water_occurrence": [
        ("#deebf7", 0), ("#9ecae1", 255), ("#4292c6", 255),
        ("#2171b5", 255), ("#08306b", 255),
    ],
    # 31.73..57.69 m
    "ff_dtm": [
        ("#2c5aa0", 255), ("#4a9fc1", 255), ("#7cc7a4", 255),
        ("#b4dd9a", 255), ("#e4eb9f", 255), ("#f3d58a", 255),
        ("#d9a05b", 255), ("#a8693a", 255), ("#6b4226", 255),
    ],
}


_register_mako()
for _name, _stops in FLOODED_FOREST_RAMPS.items():
    _register_lut(_name, _lut_from_stops(_stops))
