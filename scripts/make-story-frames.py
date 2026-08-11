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

# Height of a full-scale (40 m) GEDI bar, in pixels. Tall enough to read as
# structure, short enough that the tracks do not merge into stripes.
BAR_MAX_PX = 26

# Animation: 60 frames at 90 ms is a 5.4 s loop — long enough to read the dates
# going by, short enough not to become the page's centre of gravity.
ANIM_WIDTH = 840
ANIM_BUILD_FRAMES = 44
ANIM_HOLD_FRAMES = 16
ANIM_FRAME_MS = 90


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


def _draw_bars(base, lon, lat, rh98, upto: int):
    """Composite the first `upto` shots onto a copy of the base image."""
    import numpy as np
    from PIL import Image, ImageDraw
    from rio_tiler.colormap import cmap

    lut = cmap.get("inferno")
    lo, hi = RH_RANGE_M
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    w, h_px = base.size

    # Far to near, so nearer bars overlap farther ones.
    idx = sorted(range(upto), key=lambda i: -lat[i])
    for i in idx:
        v = rh98[i]
        if not np.isfinite(v):
            continue
        x = (lon[i] - MIN_LON) / (MAX_LON - MIN_LON) * w
        y = (MAX_LAT - lat[i]) / (MAX_LAT - MIN_LAT) * h_px
        t = min(1.0, max(0.0, (v - lo) / (hi - lo)))
        r, g, b, _ = lut[int(t * 255)]
        length = (4 + t * BAR_MAX_PX) * (h_px / HEIGHT)
        draw.line((x, y, x, y - length), fill=(r, g, b, 235), width=2)
        draw.ellipse((x - 1.4, y - 1.4, x + 1.4, y + 1.4), fill=(255, 255, 255, 200))

    return Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")


def frame_gedi_animation() -> None:
    """The same shots, revealed in the order they were actually acquired.

    GEDI's coverage here is not one pass — it is 13 overpasses between January
    and December 2020. Animating in `delta_time` order shows coverage
    accumulating the way it really did, which is a stronger statement about
    sparseness than any single sweep: after a year of passes, this is still all
    there is.
    """
    print("frame 2 (animated) — GEDI coverage accumulating")
    if not GEDI_PARQUET.exists():
        print(f"  skipped: {GEDI_PARQUET.name} not found")
        return

    import datetime as dt
    import numpy as np
    import pyarrow.parquet as pq
    from PIL import Image, ImageDraw

    table = pq.ParquetFile(GEDI_PARQUET).read(columns=["lon", "lat", "rh98", "delta_time"])
    lon = np.asarray(table["lon"], dtype="float64")
    lat = np.asarray(table["lat"], dtype="float64")
    rh98 = np.asarray(table["rh98"], dtype="float64")
    tsec = np.asarray(table["delta_time"], dtype="float64")

    inside = (lon >= MIN_LON) & (lon <= MAX_LON) & (lat >= MIN_LAT) & (lat <= MAX_LAT)
    lon, lat, rh98, tsec = lon[inside], lat[inside], rh98[inside], tsec[inside]
    order = np.argsort(tsec)
    lon, lat, rh98, tsec = lon[order], lat[order], rh98[order], tsec[order]
    n = len(lon)
    print(f"  {n} shots, {len(np.unique(np.floor(tsec / 3600)))} distinct hours")

    # Smaller than the stills: this is 60 frames, and the panel renders at about
    # 600 px anyway.
    base = Image.open(OUT / "method-1-sentinel2.webp").convert("RGB")
    base = base.resize((ANIM_WIDTH, int(ANIM_WIDTH * HEIGHT / WIDTH)), Image.LANCZOS)

    epoch = dt.datetime(2018, 1, 1)
    frames = []
    for k in range(ANIM_BUILD_FRAMES):
        upto = max(1, round(n * (k + 1) / ANIM_BUILD_FRAMES))
        img = _draw_bars(base, lon, lat, rh98, upto)
        date = (epoch + dt.timedelta(seconds=float(tsec[upto - 1]))).date()
        d = ImageDraw.Draw(img)
        label = f"{date}   {upto} shots"
        d.rectangle((8, img.size[1] - 26, 8 + 7 * len(label) + 12, img.size[1] - 6), fill=(0, 0, 0, 160))
        d.text((16, img.size[1] - 22), label, fill=(235, 242, 240))
        frames.append(img)

    # Hold on the finished state, so the loop reads as "and that is all of it"
    # before it starts over.
    frames += [frames[-1]] * ANIM_HOLD_FRAMES

    out = OUT / "method-2-gedi.webp"
    frames[0].save(
        out,
        "WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=ANIM_FRAME_MS,
        loop=0,
        quality=68,
        method=6,
    )
    print(f"  method-2-gedi.webp  {out.stat().st_size / 1024:.0f} KB  "
          f"{len(frames)} frames  {frames[0].size[0]}x{frames[0].size[1]}")


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
    # Not darkened. Frames 1 and 2 are meant to read as the same place gaining
    # information; changing the exposure between them makes them read as two
    # different pictures instead. The shots carry themselves.
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    lut = cmap.get("inferno")
    lo, hi = RH_RANGE_M

    # Each shot as a standing bar rather than a dot: GEDI's footprint is 25 m,
    # which is under a pixel at this extent, so a dot can only ever say "a
    # measurement happened here" — the wrong half of the point. Bar length
    # carries the measured rh98, which is what the chapter is about, and echoes
    # the vertical-column language of the hero render.
    order = np.argsort(-lat)  # far to near, so nearer bars overlap farther ones
    for i in order:
        x = (lon[i] - MIN_LON) / (MAX_LON - MIN_LON) * WIDTH
        y = (MAX_LAT - lat[i]) / (MAX_LAT - MIN_LAT) * HEIGHT
        h = rh98[i]
        if not np.isfinite(h):
            continue
        t = min(1.0, max(0.0, (h - lo) / (hi - lo)))
        r, g, b, _ = lut[int(t * 255)]

        # 40 m of canopy becomes BAR_MAX_PX; the scale is arbitrary but constant,
        # so relative heights across the scene are honest.
        length = 4 + t * BAR_MAX_PX
        draw.line((x, y, x, y - length), fill=(r, g, b, 235), width=2)
        # A base mark so the ground position stays readable where bars are short.
        draw.ellipse((x - 1.6, y - 1.6, x + 1.6, y + 1.6), fill=(255, 255, 255, 200))

    base = Image.alpha_composite(base.convert("RGBA"), overlay).convert("RGB")

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
    frame_gedi_animation()
    frame_predicted()
