#!/usr/bin/env python
"""Export the data behind chapter 2's "what is a GEDI bar" explainer.

    conda activate gis_app
    source scripts/env.local.sh
    python scripts/make-gedi-explainer.py

Writes src/story/gedi-shot.json: one hero shot's waveform, every shot in the
cropped view, and the placement of the Sentinel-2 backdrop they sit on.

This used to render the five beats as stills and save them as WebP. The beats
are the same, but they are now drawn in the browser from this file, because the
explanation is a continuous motion — a point becomes a waveform, the waveform
collapses back into a bar — and a cross-fade between two stills shows the
endpoints of that motion while hiding the motion itself, which is the only part
that carries the argument. Interpolating in the browser also means the reader's
scroll drives the speed, so they can still stop on a step, and it costs ~10 KB
of JSON instead of five images.

Geometry is resolved here rather than in the component so there is one place
that knows how longitude becomes a screen coordinate. An earlier version mapped
the full bounding box into the narrower map column while drawing the imagery
across the whole frame, which squeezed the shots out of register with the ground
underneath them by a factor of 1.7.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

import numpy as np  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from PIL import Image  # noqa: E402
from rio_tiler.colormap import cmap  # noqa: E402

STORY = REPO / "public" / "story"
OUT = REPO / "src" / "story" / "gedi-shot.json"
TILE = "21LTD"
GEDI = REPO / "art" / f"{TILE}.parquet"
BACKDROP = "method-1-sentinel2.webp"

# Same bbox as make-story-frames.py, because the backdrop is that script's
# output — a Mato Grosso deforestation frontier.
MIN_LON, MAX_LON = -59.48, -59.02
MIN_LAT, MAX_LAT = -15.10, -14.80

# The drawing surface, in SVG user units. The component reads these back out of
# the JSON, so this is the one definition.
VIEW_W, VIEW_H = 760, 506
MAP_W = 456                      # imagery on the left, profile panel on the right

RH_MAX_M = 40.0                  # full-scale bar, shared with the map's colour ramp
PROFILE_MAX_M = 45.0             # top of the profile axis
PROFILE_STEP_M = 0.5             # sample spacing, so the curve draws smoothly
# The percentiles the explainer reads off the waveform. Every gap holds 5% of
# the returned energy. RH98 is in the list because it is the height the map's
# bar is, and RH100 because the relative-height curve has to reach 100% to be
# the curve it claims to be.
RH_STEPS = list(range(0, 100, 5)) + [98, 100]
PALETTE_STOPS = 32


def palette() -> list[str]:
    lut = cmap.get("inferno")
    out = []
    for i in range(PALETTE_STOPS):
        r, g, b, _ = lut[int(i / (PALETTE_STOPS - 1) * 255)]
        out.append(f"#{r:02x}{g:02x}{b:02x}")
    return out


def waveform(rh_row, floor_m: float) -> list[float]:
    """The hero shot's returned energy against height, as a drawable curve.

    The relative heights are a cumulative distribution — rh[i] is the height
    below which i% of the energy fell — so binning them recovers the density,
    which is the waveform. Binned at 1 m that density is a staircase quantised
    to 1/101, and drawn honestly it looks like a bar chart of nothing. So it is
    resampled to half-metre steps and smoothed with a 1.5 m Gaussian, which is
    close to what the instrument itself does: GEDI's transmitted pulse is ~15 ns
    wide, so the real waveform has no detail this narrow to lose.

    Binned from `floor_m`, not from the ground. The low percentiles of a canopy
    return sit below 0 — this shot's RH0 is about -2.4 m — because the ground
    return is a peak with width, not a line, and half of it lies under the
    elevation the processor called the ground. Starting the histogram at 0 threw
    that half away and made the waveform look like it began at the ground.
    """
    from utils import pixel_vertical_profile

    hist = np.asarray(
        pixel_vertical_profile(
            rh_row, interval=1, max_height=int(PROFILE_MAX_M), min_height=floor_m
        ),
        dtype="float64",
    )

    n = int(round((PROFILE_MAX_M - floor_m) / PROFILE_STEP_M))
    centres = floor_m + np.arange(len(hist)) + 0.5
    fine = floor_m + (np.arange(n) + 0.5) * PROFILE_STEP_M
    dense = np.interp(fine, centres, hist)

    sigma = 1.5 / PROFILE_STEP_M
    half = int(np.ceil(3 * sigma))
    kernel = np.exp(-0.5 * (np.arange(-half, half + 1) / sigma) ** 2)
    # Normalise by the kernel's own overlap so the ends do not droop towards
    # zero — the ground return sits near the bottom of the axis.
    smooth = np.convolve(dense, kernel, "same") / np.convolve(
        np.ones_like(dense), kernel, "same"
    )
    if smooth.max() > 0:
        smooth = smooth / smooth.max()
    return [round(float(v), 3) for v in smooth]


def axis_floor(rh_row) -> float:
    """How far below the ground the plot has to reach for this shot.

    Taken from the data and rounded out to a multiple of 5, rather than fixed at
    the backend's -10 m: the axis then always contains the whole return without
    spending a fifth of the panel on empty space below it.
    """
    from utils import PROFILE_MIN_HEIGHT, pixel_vertical_profile

    hist = np.asarray(
        pixel_vertical_profile(
            rh_row, interval=1, max_height=int(PROFILE_MAX_M), min_height=PROFILE_MIN_HEIGHT
        ),
        dtype="float64",
    )
    lowest = PROFILE_MIN_HEIGHT + float(np.argmax(hist > 0))
    lowest = min(lowest, float(np.min(rh_row[np.isfinite(rh_row)])))
    return max(PROFILE_MIN_HEIGHT, float(np.floor(lowest / 5.0) * 5.0))


def main() -> None:
    if not GEDI.exists():
        print(f"missing {GEDI}")
        return

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
    lon, lat, rh98, rh = lon[inside], lat[inside], rh98[inside], rh[inside]
    print(f"  {len(lon)} shots in the bbox")

    # A shot with a tall, structured canopy: the profile is the point of the
    # chapter, and a 4 m return has nothing to show.
    hero = int(np.argsort(rh98)[int(len(rh98) * 0.93)])
    print(f"  hero shot rh98 = {rh98[hero]:.1f} m")

    with Image.open(STORY / BACKDROP) as im:
        img_w, img_h = im.size

    # Cover the map column without distorting the ground, then slide the crop so
    # the hero shot sits near the middle of what survives.
    scale = max(MAP_W / img_w, VIEW_H / img_h)
    draw_w, draw_h = img_w * scale, img_h * scale
    hero_x = (lon[hero] - MIN_LON) / (MAX_LON - MIN_LON) * draw_w
    off_x = min(0.0, max(MAP_W - draw_w, MAP_W * 0.5 - hero_x))
    off_y = min(0.0, max(VIEW_H - draw_h, 0.0))

    x = (lon - MIN_LON) / (MAX_LON - MIN_LON) * draw_w + off_x
    y = (MAX_LAT - lat) / (MAX_LAT - MIN_LAT) * draw_h + off_y
    frac = np.clip(rh98 / RH_MAX_M, 0, 1)

    # A bar drawn at the very edge is half a bar; trim the margin the tallest
    # one needs rather than clipping it later.
    visible = (x >= 2) & (x <= MAP_W - 2) & (y >= 8) & (y <= VIEW_H - 2)
    visible[hero] = True
    print(f"  {int(visible.sum())} of them inside the crop")

    floor_m = axis_floor(rh[hero])
    profile = waveform(rh[hero], floor_m)
    print(f"  axis floor {floor_m:.0f} m, RH0 = {rh[hero][0]:.2f} m")

    others = [
        [round(float(x[i]), 1), round(float(y[i]), 1), int(round(frac[i] * 100))]
        for i in np.argsort(y)                       # far to near, so nearer bars overlap
        if visible[i] and i != hero
    ]

    data = {
        "view": {"w": VIEW_W, "h": VIEW_H, "mapW": MAP_W},
        "backdrop": {
            "src": f"story/{BACKDROP}",
            "x": round(off_x, 1),
            "y": round(off_y, 1),
            "w": round(draw_w, 1),
            "h": round(draw_h, 1),
        },
        "palette": palette(),
        "profileMinM": floor_m,
        "profileMaxM": PROFILE_MAX_M,
        "rhMaxM": RH_MAX_M,
        "hero": {
            "x": round(float(x[hero]), 1),
            "y": round(float(y[hero]), 1),
            "rh98": round(float(rh98[hero]), 1),
            "frac": int(round(float(frac[hero]) * 100)),
            # Returned energy against height, normalised to its own peak.
            "profile": profile,
            # The same waveform read as heights: rh[i] is the height below which
            # RH_STEPS[i]% of the energy fell. Not clamped at the ground — the
            # low percentiles genuinely sit below it, and the figure says so.
            "rhSteps": RH_STEPS,
            "rh": [round(float(rh[hero][p]), 2) for p in RH_STEPS],
        },
        "shots": others,
        "count": int(visible.sum()),
    }

    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"  {OUT.relative_to(REPO)}  {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    print("GEDI explainer data")
    main()
