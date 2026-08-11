#!/usr/bin/env python
"""Render the story's chapter-2 frames from real data.

    conda activate gis_app
    source scripts/env.local.sh
    python scripts/make-story-frames.py

Produces, for one identical bounding box:

  public/story/method-1-sentinel2.webp   EOX s2cloudless — genuine Sentinel-2
  public/story/method-3-predicted.webp   VSM RH98 from source.coop

Frame 2 — the GEDI ground tracks — is deliberately absent. It needs the GEDI
data that only exists on the cluster, and inventing plausible-looking track
positions for a figure on a paper's companion site would be presenting made-up
data as measurement.

The two frames share one bbox and one output size because the story stacks and
cross-fades them: any shift between the frames reads as a jump rather than the
same place gaining information.
"""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

# A deforestation frontier in Mato Grosso: forest and cleared land side by side,
# so the structure the model predicts is legible against the imagery.
MIN_LON, MAX_LON = -59.35, -59.20
MIN_LAT, MAX_LAT = -15.00, -14.90
YEAR = 2020
WIDTH, HEIGHT = 1400, 933          # 3:2, matching the story panel
OUT = REPO / "public" / "story"

VSM_URL = (
    "https://data.source.coop/geoai-ucph/gvsm/"
    f"{YEAR}/21LTD/RH98_Q1.tif"
)


def save_webp(png_or_jpeg: bytes, name: str, quality: int = 80) -> None:
    from PIL import Image

    img = Image.open(io.BytesIO(png_or_jpeg)).convert("RGB")
    if img.size != (WIDTH, HEIGHT):
        img = img.resize((WIDTH, HEIGHT), Image.LANCZOS)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    img.save(path, "WEBP", quality=quality, method=6)
    print(f"  {name}  {path.stat().st_size / 1024:.0f} KB  {img.size[0]}x{img.size[1]}")


def frame_sentinel2() -> None:
    print("frame 1 — Sentinel-2 (EOX s2cloudless)")
    from routes.saved_features.satellite import _stitch_bbox_eox_s2cloudless

    png, meta = _stitch_bbox_eox_s2cloudless(
        MIN_LON, MAX_LON, MIN_LAT, MAX_LAT,
        buffer_m=0.0,
        max_width_px=WIDTH,
        year=YEAR,
    )
    if png is None:
        print(f"  FAILED: {meta}")
        return
    save_webp(png, "method-1-sentinel2.webp")


def frame_predicted() -> None:
    print("frame 3 — predicted structure (VSM RH98)")
    from rio_tiler.io import Reader
    from rio_tiler.models import ImageData
    from rio_tiler.colormap import cmap

    with Reader(VSM_URL) as src:
        img = src.part(
            (MIN_LON, MIN_LAT, MAX_LON, MAX_LAT),
            dst_crs="EPSG:4326",
            width=WIDTH,
            height=HEIGHT,
        )

    # 32767 is the in-band "no prediction" sentinel; left in, it renders as a
    # saturated slab instead of transparent ground.
    import numpy as np

    data = np.asarray(img.data, dtype="float32")
    invalid = (data[0] >= 32767.0) | (~img.mask.astype(bool))
    masked = np.ma.masked_array(data, mask=np.broadcast_to(invalid, data.shape))

    # ImageData.data is read-only, so the masked array goes into a new one
    # rather than being assigned back — same as /predictions/interval-tile.
    out = ImageData(masked, crs=img.crs, bounds=img.bounds)
    # Decimetres; 400 ≈ 40 m, which covers this canopy without flattening it.
    out.rescale(in_range=((0, 400),))

    save_webp(out.render(img_format="PNG", colormap=cmap.get("inferno")), "method-3-predicted.webp")


if __name__ == "__main__":
    print(f"bbox {MIN_LON},{MIN_LAT} → {MAX_LON},{MAX_LAT}   {WIDTH}x{HEIGHT}\n")
    frame_sentinel2()
    frame_predicted()
    print(
        "\nframe 2 (GEDI tracks) not generated — needs GEDI_LOCAL_BASE_PATH, "
        "which only exists on the cluster."
    )
