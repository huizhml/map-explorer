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
# Under art/, not public/: Vite copies everything in public/ into the build
# verbatim, so a build input left there gets published alongside the images.
GEDI_PARQUET = REPO / "art" / f"{TILE}.parquet"

# Shared with frame 3 so the two read as the same measurement, sparse then
# dense. Metres; GEDI rh98 is metres, VSM is decimetres.
RH_RANGE_M = (0.0, 40.0)

# Height of a full-scale (40 m) GEDI bar, in pixels. Tall enough to read as
# structure, short enough that the tracks do not merge into stripes.
BAR_MAX_PX = 26

# Animation: 60 frames at 90 ms is a 5.4 s loop — long enough to read the dates
# going by, short enough not to become the page's centre of gravity.
ANIM_WIDTH = 760
ANIM_BUILD_FRAMES = 26
ANIM_HOLD_FRAMES = 14
ANIM_FPS = 11
# How far the camera leans over. Past ~60 deg the far half of the scene
# collapses into a sliver and the bars there stop being readable.
TILT_MAX_DEG = 54


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


def _homography(src, dst):
    """Forward 3x3 mapping src → dst from four point correspondences."""
    import numpy as np

    a = []
    b = []
    for (sx, sy), (dx, dy) in zip(src, dst):
        a.append([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx])
        b.append(dx)
        a.append([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy])
        b.append(dy)
    h = np.linalg.solve(np.asarray(a, dtype="float64"), np.asarray(b, dtype="float64"))
    return np.append(h, 1.0).reshape(3, 3)


def frame_gedi_animation() -> None:
    """Tilt from nadir into an oblique view, so the measurements stand up.

    The point of the chapter is that GEDI measures the vertical dimension, and
    a map cannot show a vertical dimension — from straight down, a 40 m canopy
    and bare ground look the same. So the camera starts at nadir, where the bars
    have zero length because that is honestly what you can see from there, and
    tilts until they are standing. The tilt is the information; the same visual
    grammar as the hero render.

    An earlier version animated the shots appearing in acquisition order. That
    was motion without an argument: the chapter is about spatial sparseness, and
    watching coverage accumulate over a year suggests the opposite.
    """
    print("frame 2 (animated) — nadir tilting into oblique")
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
    print(f"  {inside.sum()} shots")

    base = Image.open(OUT / "method-1-sentinel2.webp").convert("RGB")
    W = ANIM_WIDTH
    H = int(ANIM_WIDTH * HEIGHT / WIDTH)
    base = base.resize((W, H), Image.LANCZOS)

    lut = cmap.get("inferno")
    lo, hi = RH_RANGE_M
    # Ground positions in the flat image, and each shot's height fraction.
    gx = (lon - MIN_LON) / (MAX_LON - MIN_LON) * W
    gy = (MAX_LAT - lat) / (MAX_LAT - MIN_LAT) * H
    frac = np.clip((rh98 - lo) / (hi - lo), 0, 1)
    frac[~np.isfinite(rh98)] = np.nan

    src_corners = [(0, 0), (W, 0), (W, H), (0, H)]
    frames = []

    for k in range(ANIM_BUILD_FRAMES):
        # Ease-in-out so the tilt starts and ends calmly.
        u = k / max(1, ANIM_BUILD_FRAMES - 1)
        eased = 0.5 - 0.5 * np.cos(np.pi * u)
        theta = np.radians(TILT_MAX_DEG) * eased

        squash = float(np.cos(theta))          # ground foreshortening
        narrow = 0.42 * float(np.sin(theta))   # far edge pulled in
        lift = float(np.sin(theta))            # how much of a bar is visible

        # The ground keeps most of the canvas as it tilts, rather than shrinking
        # by cos(theta) and leaving the top 40% black. It gives up only as much
        # room as the bars need to stand in.
        band_h = H * (1 - 0.17 * float(np.sin(theta)))
        y_bot = H - 6
        y_top = y_bot - band_h
        dst_corners = [
            (W * 0.5 * narrow, y_top),
            (W - W * 0.5 * narrow, y_top),
            (W, y_bot),
            (0, y_bot),
        ]

        # PIL's PERSPECTIVE takes the inverse mapping (output → input).
        inv = _homography(dst_corners, src_corners)
        coeffs = (inv / inv[2, 2]).flatten()[:8]
        ground = base.transform((W, H), Image.PERSPECTIVE, coeffs, resample=Image.BICUBIC)

        canvas = Image.new("RGB", (W, H), (8, 11, 10))
        canvas.paste(ground, (0, 0))

        fwd = _homography(src_corners, dst_corners)
        pts = np.stack([gx, gy, np.ones_like(gx)])
        proj = fwd @ pts
        px = proj[0] / proj[2]
        py = proj[1] / proj[2]

        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        # Far to near, so nearer bars occlude farther ones.
        for i in np.argsort(py):
            f = frac[i]
            if not np.isfinite(f):
                continue
            # Zero at nadir: from straight down there is no height to see. That
            # is the whole point of the tilt, so it is not faked in early.
            # Scaled so a full-height (40 m) shot reaches roughly the headroom the
            # ground gives up — bars that read as columns, not as tick marks.
            length = f * BAR_MAX_PX * (H / HEIGHT) * lift * 6.2
            if length < 0.5:
                continue
            r, g, b, _ = lut[int(f * 255)]
            x, y = float(px[i]), float(py[i])
            draw.line((x, y, x, y - length), fill=(r, g, b, 240), width=2)
            draw.ellipse((x - 1.3, y - 1.3, x + 1.3, y + 1.3), fill=(255, 255, 255, 190))

        frames.append(Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB"))

    # Ping-pong: up, hold, back down. The loop is then seamless — no cut from
    # full tilt back to nadir — and it re-states the comparison every cycle:
    # flat shows nothing, tilted shows the measurement.
    frames = frames + [frames[-1]] * ANIM_HOLD_FRAMES + frames[-2:0:-1]

    # A still doubles as the poster, so something is on screen before the video
    # has loaded, or if it never plays.
    frames[len(frames) // 3].save(OUT / "method-2-gedi.webp", "WEBP", quality=80, method=6)

    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        for i, f in enumerate(frames):
            f.save(f"{tmp}/{i:03d}.png")
        for name, args in (
            ("method-2-gedi.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "28",
                                   "-movflags", "+faststart"]),
            ("method-2-gedi.webm", ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p",
                                    "-crf", "40", "-b:v", "0"]),
        ):
            dest = OUT / name
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(ANIM_FPS),
                 "-i", f"{tmp}/%03d.png", *args, str(dest)],
                check=True,
            )
            print(f"  {name}  {dest.stat().st_size / 1024:.0f} KB  {len(frames)} frames  {W}x{H}")


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
