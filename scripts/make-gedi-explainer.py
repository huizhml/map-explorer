#!/usr/bin/env python
"""Animate what one GEDI bar actually is.

    conda activate gis_app
    source scripts/env.local.sh
    python scripts/make-gedi-explainer.py

The tilt animation showed the bars standing up but never said what a bar is —
a reader saw a coloured stick and had to take it on faith. A bar is a whole
returned waveform collapsed into one number, and that collapse is the thing
worth showing, because chapter 3 then reads RH98 off exactly this curve.

Four beats, all from one real shot in the tile export:

  1. one footprint on the image, ringed          "one GEDI shot, 25 m across"
  2. its energy-with-height profile draws in     "this is what it records"
  3. RH98 marked on the profile                  "98% of the energy is below here"
  4. the profile collapses into the bar          "which is the bar"

Then the other 723 appear at the same scale, so the sparseness lands after the
meaning rather than instead of it.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

import numpy as np  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from rio_tiler.colormap import cmap  # noqa: E402

OUT = REPO / "public" / "story"
TILE = "21LTD"
GEDI = REPO / "art" / f"{TILE}.parquet"

MIN_LON, MAX_LON = -59.48, -59.02
MIN_LAT, MAX_LAT = -15.10, -14.80

W, H = 760, 506
FPS = 12
PANEL_X = int(W * 0.60)          # profile panel occupies the right 40%
RH_RANGE_M = (0.0, 40.0)
PROFILE_MAX_M = 45.0

STEP_NAMES = [
    "method-2a-shot.webp",
    "method-2b-profile.webp",
    "method-2c-rh98.webp",
    "method-2d-bar.webp",
    "method-2e-all.webp",
]

LUT = cmap.get("inferno")
FG = (235, 242, 240)
MUTED = (150, 165, 158)


def font(size: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


F_SMALL, F_BODY = font(12), font(15)


def colour_for(frac: float):
    r, g, b, _ = LUT[int(np.clip(frac, 0, 1) * 255)]
    return (r, g, b)


def load_shots():
    cols = ["lon", "lat", "rh98"] + [f"rh{i}" for i in range(101)]
    table = pq.ParquetFile(GEDI).read(columns=sorted(set(cols)))
    lon = np.asarray(table["lon"], dtype="float64")
    lat = np.asarray(table["lat"], dtype="float64")
    rh98 = np.asarray(table["rh98"], dtype="float64")
    rh = np.stack([np.asarray(table[f"rh{i}"], dtype="float64") for i in range(101)], axis=1)

    inside = (
        (lon >= MIN_LON) & (lon <= MAX_LON) & (lat >= MIN_LAT) & (lat <= MAX_LAT)
        & np.isfinite(rh98)
    )
    return lon[inside], lat[inside], rh98[inside], rh[inside]


def to_screen(lon, lat):
    x = (lon - MIN_LON) / (MAX_LON - MIN_LON) * PANEL_X
    y = (MAX_LAT - lat) / (MAX_LAT - MIN_LAT) * H
    return x, y


def bar_px(frac: float) -> float:
    """Bar length in pixels. Shared by the map bars and the collapsed profile,
    so the two are literally the same length — that is the point being made."""
    return 12 + frac * 150


def draw_profile(draw, rh_row, reveal: float, mark_rh98: float, collapse: float):
    """The right-hand panel: energy against height for one shot.

    `reveal` draws the curve in, `mark_rh98` fades in the RH98 line, `collapse`
    morphs the filled curve into the bar it becomes.
    """
    from utils import pixel_vertical_profile

    prof = np.asarray(pixel_vertical_profile(rh_row, interval=1, max_height=int(PROFILE_MAX_M)),
                      dtype="float64")
    if prof.max() > 0:
        prof = prof / prof.max()

    x0 = PANEL_X + 54
    x1 = W - 28
    y0, y1 = 60, H - 58          # y0 = top of the axis, y1 = ground
    span = y1 - y0

    draw.line((x0, y0, x0, y1), fill=(90, 104, 98))
    draw.line((x0, y1, x1, y1), fill=(90, 104, 98))
    draw.text((x0 - 46, y0 - 6), f"{PROFILE_MAX_M:.0f} m", font=F_SMALL, fill=MUTED)
    draw.text((x0 - 22, y1 - 7), "0", font=F_SMALL, fill=MUTED)
    draw.text((x0, y1 + 12), "returned energy", font=F_SMALL, fill=MUTED)

    rh98 = float(rh_row[98])
    frac98 = np.clip(rh98 / RH_RANGE_M[1], 0, 1)
    col = colour_for(frac98)

    n = len(prof)
    shown = int(n * np.clip(reveal, 0, 1))
    for i in range(shown):
        h_m = (i + 0.5) * PROFILE_MAX_M / n
        y = y1 - (h_m / PROFILE_MAX_M) * span
        # Collapse: the curve's width shrinks to the bar's width while its
        # colour stays, so it reads as the same object being summarised.
        width = (x1 - x0) * prof[i] * (1 - collapse) + 6 * collapse
        if width < 1:
            continue
        draw.line((x0 + 1, y, x0 + 1 + width, y), fill=col, width=2)

    if mark_rh98 > 0.02:
        y98 = y1 - (np.clip(rh98, 0, PROFILE_MAX_M) / PROFILE_MAX_M) * span
        dash = int((x1 - x0) * mark_rh98)
        for dx in range(0, dash, 10):
            draw.line((x0 + dx, y98, x0 + min(dx + 5, dash), y98), fill=FG, width=1)
        if mark_rh98 > 0.5:
            draw.text((x0 + 6, y98 - 17), f"RH98 = {rh98:.1f} m", font=F_BODY, fill=FG)


def compose(base, shots, stage: dict):
    """One frame. `stage` carries the four beats as 0-1 dials."""
    lon, lat, rh98, rh = shots
    img = Image.new("RGB", (W, H), (8, 11, 10))
    img.paste(base, (0, 0))

    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    hero = stage["hero_index"]
    hx, hy = to_screen(lon[hero], lat[hero])
    frac_h = np.clip(rh98[hero] / RH_RANGE_M[1], 0, 1)

    # Panel backdrop, so the curve is readable over the imagery.
    if stage["panel"] > 0.02:
        a = int(215 * stage["panel"])
        draw.rectangle((PANEL_X, 0, W, H), fill=(8, 11, 10, a))

    # The other shots arrive last.
    if stage["others"] > 0.02:
        take = int(len(lon) * stage["others"])
        for i in np.argsort(lat)[::-1][:take]:
            if i == hero:
                continue
            x, y = to_screen(lon[i], lat[i])
            if x > PANEL_X - 6:
                continue
            f = np.clip(rh98[i] / RH_RANGE_M[1], 0, 1)
            draw.line((x, y, x, y - bar_px(f) * 0.42), fill=colour_for(f) + (225,), width=2)

    # The footprint: 25 m on the ground, which at this extent is about a pixel.
    # Drawn as a ring well above true scale, with the number said out loud.
    if stage["ring"] > 0.02:
        r = 4 + 26 * (1 - stage["ring"])
        draw.ellipse((hx - r, hy - r, hx + r, hy + r), outline=FG + (int(230 * stage["ring"]),), width=2)
        if stage["ring"] > 0.6:
            draw.text((hx + 12, hy + 8), "one shot · 25 m footprint", font=F_SMALL, fill=FG)

    if stage["hero_bar"] > 0.02:
        length = bar_px(frac_h) * stage["hero_bar"] * 0.42
        draw.line((hx, hy, hx, hy - length), fill=colour_for(frac_h) + (255,), width=3)

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    if stage["panel"] > 0.02:
        d2 = ImageDraw.Draw(img)
        draw_profile(d2, rh[hero], stage["curve"], stage["rh98"], stage["collapse"])
        if stage["caption"]:
            d2.text((PANEL_X + 54, 26), stage["caption"], font=F_BODY, fill=FG)

    return img


def ease(t):
    return 0.5 - 0.5 * np.cos(np.pi * np.clip(t, 0, 1))


def build():
    if not GEDI.exists():
        print(f"missing {GEDI}"); return
    shots = load_shots()
    lon, lat, rh98, rh = shots
    print(f"  {len(lon)} shots in view")

    # A shot with a tall, structured canopy — the profile is the point, and a
    # 4 m return has nothing to show.
    hero = int(np.argsort(rh98)[int(len(rh98) * 0.93)])
    print(f"  hero shot rh98 = {rh98[hero]:.1f} m")

    base = Image.open(OUT / "method-1-sentinel2.webp").convert("RGB").resize(
        (PANEL_X, int(PANEL_X * H / PANEL_X)), Image.LANCZOS
    )
    base = Image.open(OUT / "method-1-sentinel2.webp").convert("RGB")
    base = base.crop((0, 0, base.width, int(base.width * H / W))).resize((W, H), Image.LANCZOS)

    # One beat per published step; the in-between frames only exist to ease the
    # dials to their end state.
    beats = [
        # (frames, caption, dial targets)
        (14, "", dict(ring=1, panel=0, curve=0, rh98=0, collapse=0, hero_bar=0, others=0)),
        (16, "What it records", dict(ring=1, panel=1, curve=1, rh98=0, collapse=0, hero_bar=0, others=0)),
        (14, "98% of the energy is below here", dict(ring=1, panel=1, curve=1, rh98=1, collapse=0, hero_bar=0, others=0)),
        (16, "…which is the bar", dict(ring=0.6, panel=1, curve=1, rh98=1, collapse=1, hero_bar=1, others=0)),
        (18, "724 shots in this view", dict(ring=0.3, panel=0.5, curve=1, rh98=1, collapse=1, hero_bar=1, others=1)),
    ]

    frames = []
    prev = dict(ring=0, panel=0, curve=0, rh98=0, collapse=0, hero_bar=0, others=0)
    for count, caption, target in beats:
        for k in range(count):
            t = ease((k + 1) / count)
            stage = {key: prev[key] + (target[key] - prev[key]) * t for key in prev}
            stage["hero_index"] = hero
            stage["caption"] = caption
            frames.append(compose(base, shots, stage))
        prev = dict(target)

    # Stills at the end of each beat, not a video.
    #
    # Both references this is modelled on — the SPUN story and jtree's carbon
    # page — build their explanations from staged stills revealed on scroll
    # (jtree uses no video or canvas at all, just position:sticky and three
    # PNGs). That puts the reader in charge of the pace, which matters when the
    # picture is an argument rather than an atmosphere: they can stop on the
    # step they have not understood. A clip plays at whatever speed it plays.
    ends = np.cumsum([count for count, _, _ in beats]) - 1
    for n, idx in enumerate(ends[:len(STEP_NAMES)], start=0):
        dest = OUT / STEP_NAMES[n]
        frames[idx].save(dest, "WEBP", quality=82, method=6)
        print(f"  {dest.name}  {dest.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    print("GEDI explainer")
    build()
