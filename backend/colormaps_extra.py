"""Register the seaborn 'mako' colormap into rio_tiler and matplotlib.

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


def _register_mako() -> None:
    # sns.color_palette returns RGB floats in 0..1 — quantize to RGBA uint8.
    palette = sns.color_palette("mako", n_colors=256, as_cmap=False)
    lut = np.array(
        [[int(round(c * 255)) for c in (*rgb, 1.0)] for rgb in palette],
        dtype=np.uint8,
    )

    # rio_tiler: mutate the singleton's .data so every consumer that already
    # imported `cmap` sees mako too.
    if "mako" not in _rio_cmap.data:
        _rio_cmap.data["mako"] = {i: tuple(int(v) for v in lut[i]) for i in range(256)}

    # matplotlib: needed by the figure-save path (area_images.py) which does
    # `ax.imshow(..., cmap="mako")`.
    try:
        from matplotlib.colors import ListedColormap
        import matplotlib as mpl
    except Exception:
        return
    cmap_obj = ListedColormap(lut.astype(np.float32) / 255.0, name="mako")
    try:
        mpl.colormaps.register(cmap_obj, name="mako")
    except (ValueError, AttributeError):
        # Already registered, or older matplotlib without the new registry.
        try:
            mpl.cm.register_cmap(name="mako", cmap=cmap_obj)
        except Exception:
            pass


_register_mako()
