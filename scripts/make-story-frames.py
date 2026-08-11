#!/usr/bin/env python
"""Render the story's chapter-2 frames from real data.

    conda activate gis_app
    source scripts/env.local.sh
    python scripts/make-story-frames.py

Produces, for one identical bounding box:

  public/story/method-1-sentinel2.webp   EOX s2cloudless — genuine Sentinel-2
  public/story/method-3-predicted.webp   VSM RH98 from source.coop

  public/story/method-2-gedi.webp        real GEDI shots over the same view

Frame 2 needs the tile's GEDI export at public/story/<TILE>.parquet; without it
that frame is skipped rather than faked.

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
# Wide enough that GEDI's parallel tracks read as tracks: at the 16x11 km first
# tried, the same tile yields 72 shots, which scatter rather than line up. At
# this extent there are ~675, while Sentinel-2 still resolves the 1-3 km fields
# and forest blocks that make the structure legible.
MIN_LON, MAX_LON = -59.48, -59.02
MIN_LAT, MAX_LAT = -15.10, -14.80
YEAR = 2020
WIDTH, HEIGHT = 1400, 933          # 3:2, matching the story panel
OUT = REPO / "public" / "story"

TILE = "21LTD"
VSM_URL = f"https://data.source.coop/geoai-ucph/gvsm/{YEAR}/{TILE}/RH98_Q1.tif"
GEDI_PARQUET = OUT / f"{TILE}.parquet"

# Shared with frame 3 so the two read as the same measurement, sparse then
# dense. Metres; GEDI rh98 is metres, VSM is decimetres.
RH_RANGE_M = (0.0, 40.0)


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


def frame_gedi() -> None:
    print("frame 2 — GEDI shots (real, from the tile export)")
    if not GEDI_PARQUET.exists():
        print(f"  skipped: {GEDI_PARQUET.name} not found")
        return

    import numpy as np
    import pyarrow.parquet as pq
    from PIL import Image, ImageDraw
    from rio_tiler.colormap import cmap

    table = pq.ParquetFile(GEDI_PARQUET).read(columns=["lon", "lat", "rh98"])
    lon = np.asarray(table["lon"], dtype="float64")
    lat = np.asarray(table["lat"], dtype="float64")
    rh98 = np.asarray(table["rh98"], dtype="float64")

    inside = (lon >= MIN_LON) & (lon <= MAX_LON) & (lat >= MIN_LAT) & (lat <= MAX_LAT)
    lon, lat, rh98 = lon[inside], lat[inside], rh98[inside]
    print(f"  {inside.sum()} shots in view")

    base = Image.open(OUT / "method-1-sentinel2.webp").convert("RGB")
    # Darkened so the shots carry the frame — this one is about the sampling,
    # not the imagery underneath.
    base = Image.blend(base, Image.new("RGB", base.size, (0, 0, 0)), 0.45)
    draw = ImageDraw.Draw(base)

    lut = cmap.get("inferno")
    lo, hi = RH_RANGE_M

    for x_deg, y_deg, h in zip(lon, lat, rh98):
        x = (x_deg - MIN_LON) / (MAX_LON - MIN_LON) * WIDTH
        # Image rows run north to south.
        y = (MAX_LAT - y_deg) / (MAX_LAT - MIN_LAT) * HEIGHT
        t = 0.0 if not np.isfinite(h) else min(1.0, max(0.0, (h - lo) / (hi - lo)))
        r, g, b, _ = lut[int(t * 255)]
        draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(r, g, b), outline=(255, 255, 255))

    buf = io.BytesIO()
    base.save(buf, "PNG")
    save_webp(buf.getvalue(), "method-2-gedi.webp")


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
    # VSM is decimetres, so the shared 0-40 m range becomes 0-400 here.
    out.rescale(in_range=((RH_RANGE_M[0] * 10, RH_RANGE_M[1] * 10),))

    save_webp(out.render(img_format="PNG", colormap=cmap.get("inferno")), "method-3-predicted.webp")


if __name__ == "__main__":
    print(f"bbox {MIN_LON},{MIN_LAT} → {MAX_LON},{MAX_LAT}   {WIDTH}x{HEIGHT}\n")
    frame_sentinel2()
    frame_gedi()
    frame_predicted()
