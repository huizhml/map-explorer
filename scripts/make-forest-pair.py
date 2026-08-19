#!/usr/bin/env python
"""Export chapter 1's pair: two places that look the same from above.

    conda activate gis_app
    source scripts/env.local.sh
    python scripts/make-forest-pair.py

Writes src/story/forest-pair.json and two Sentinel-2 thumbnails into
public/story/.

The chapter claims that a young stand and an old one can look identical from
directly above while being nothing alike inside. That is a claim about real
places, so the figure is built from two real GEDI shots in the 21LTD tile, and
"look identical" is a test the pair has to pass rather than something the
caption asserts:

  * their RH98 — the canopy top, the only height a 2D map could see — must
    agree within a metre;
  * the Sentinel-2 pixels around them must agree in colour, which is the actual
    signal a cover map is thresholding;
  * subject to that, the pair is the one whose vertical arrangement differs
    most, measured as RH50/RH98: where the middle of the returned energy sits.

If no pair passes, the script says so rather than relaxing its way to an answer.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

import numpy as np  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402
from PIL import Image  # noqa: E402

STORY = REPO / "public" / "story"
OUT = REPO / "src" / "story" / "forest-pair.json"
TILE = "21LTD"
GEDI = REPO / "art" / f"{TILE}.parquet"
BACKDROP = STORY / "method-1-sentinel2.webp"

MIN_LON, MAX_LON = -59.48, -59.02
MIN_LAT, MAX_LAT = -15.10, -14.80
YEAR = 2020

# Both shots have to be forest by anyone's definition, or the comparison is
# between a forest and a field and proves nothing.
RH98_MIN, RH98_MAX = 22.0, 34.0
RH98_TOLERANCE_M = 1.0
# Mean channel difference over the pixels around each shot, 0-255. Sentinel-2's
# own scene-to-scene variation is a few counts, so this is "the same colour" to
# any threshold a cover map could apply. The window is 3x3 of the 35 m backdrop,
# about 100 m: as close to the 25 m footprint as the imagery gets. It used to be
# 7x7, a quarter-kilometre, which is a test of the neighbourhood rather than of
# the place.
COLOUR_TOLERANCE = 7.0
COLOUR_WINDOW_PX = 1

# Both footprints must be closed canopy. Without this the search reaches its
# largest structural contrast the easy way — by picking a gap — and a gap is
# exactly what a map from above *can* see, so the pair would fail the claim the
# chapter is making. Both closed means the difference left over is the one that
# only a profile can find: where the material sits under an unbroken top.
VEG_MIN = 0.85

PROFILE_MAX_M = 45.0
PROFILE_STEP_M = 0.5
# Below this a return is the ground echo rather than vegetation. A stated
# choice: the echo is a peak with width straddling zero, and no part of it comes
# labelled. The figure draws with the same number.
GROUND_ECHO_M = 1.5
RH_STEPS = list(range(0, 100, 5)) + [98, 100]

# The zoom stack — a pyramid, halving at every step, which is what a slippy map
# is. At a ratio of 4 a level had to be blown up four times over before the next
# one took it, and the flight visibly stepped; at 2 the magnification never
# exceeds a factor of two, which is the same deal a map gives you.
#
# The top stops at 12,000 km rather than the whole globe on purpose. Wider than
# that and the latitude band runs past Mercator's limit, the request comes back
# clipped, and the crop is no longer centred on the place the zoom flies to.
# Two stacks, meeting at SPLIT_M.
#
# Above the split the pair are 39 km apart and every crop of one is a crop of
# the other — seven levels of the flight were two identical pictures side by
# side, which tells the reader the two places are the same. So the wide half is
# one map of the midpoint with a pin on each place, and it hands over to the
# two panels at the width where the pins stop fitting in one frame.
# Where the one map hands over to two, and how much ground each of the two
# frames holds at the moment it does. The boxes have to be disjoint — 30 km
# apiece, 39 km apart — or the two panels would be showing each other's ground
# and the pull-out would be a lie about where they are.
SPLIT_M = 75_000
BOX_M = 30_000
SHARED_LEVELS_M = [12_000_000 / 2**k for k in range(9)]
ZOOM_LEVELS_M = [188_000 / 2**k for k in range(13)]
LEVEL_PX = 160


def load_shots():
    cols = ["lon", "lat"] + [f"rh{i}" for i in range(101)]
    table = pq.ParquetFile(GEDI).read(columns=sorted(set(cols)))
    lon = np.asarray(table["lon"], dtype="float64")
    lat = np.asarray(table["lat"], dtype="float64")
    rh = np.stack([np.asarray(table[f"rh{i}"], dtype="float64") for i in range(101)], axis=1)
    inside = (
        (lon >= MIN_LON) & (lon <= MAX_LON) & (lat >= MIN_LAT) & (lat <= MAX_LAT)
        & np.isfinite(rh[:, 98])
    )
    return lon[inside], lat[inside], rh[inside]


def mean_colours(lon, lat):
    """Mean Sentinel-2 colour around each shot, from the chapter-2 backdrop."""
    with Image.open(BACKDROP) as im:
        img = np.asarray(im.convert("RGB"), dtype="float64")
    h, w, _ = img.shape
    px = ((lon - MIN_LON) / (MAX_LON - MIN_LON) * w).astype(int)
    py = ((MAX_LAT - lat) / (MAX_LAT - MIN_LAT) * h).astype(int)
    r = COLOUR_WINDOW_PX
    out = np.full((len(lon), 3), np.nan)
    for i in range(len(lon)):
        x0, x1 = max(0, px[i] - r), min(w, px[i] + r + 1)
        y0, y1 = max(0, py[i] - r), min(h, py[i] + r + 1)
        if x1 > x0 and y1 > y0:
            out[i] = img[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)
    return out


def waveform(rh_row, floor_m: float) -> list[float]:
    """Returned energy against height. Same recipe as the chapter-2 figure."""
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
    smooth = np.convolve(dense, kernel, "same") / np.convolve(
        np.ones_like(dense), kernel, "same"
    )
    if smooth.max() > 0:
        smooth = smooth / smooth.max()
    return [round(float(v), 3) for v in smooth]


def zoom_stack(lon: float, lat: float, tag: str, levels=None) -> list[dict]:
    """One square crop per zoom level, all centred on the same point."""
    from routes.saved_features.satellite import _stitch_bbox_eox_s2cloudless

    out = []
    for i, m in enumerate(levels if levels is not None else ZOOM_LEVELS_M):
        dlat = m / 110_574 / 2
        dlon = m / (111_320 * np.cos(np.radians(lat))) / 2
        png, meta = _stitch_bbox_eox_s2cloudless(
            lon - dlon, lon + dlon, lat - dlat, lat + dlat,
            buffer_m=0.0, max_width_px=LEVEL_PX, year=YEAR,
        )
        if png is None:
            raise SystemExit(f"  FAILED at {m} m: {meta}")

        img = Image.open(io.BytesIO(png)).convert("RGB")
        w, h = img.size
        # Mercator returns a taller box than it was asked for once the latitude
        # band is wide. Cropping to a centred square keeps the requested ground
        # width in x, which is what the zoom interpolates on.
        side = min(w, h)
        img = img.crop(
            ((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side)
        ).resize((LEVEL_PX, LEVEL_PX), Image.LANCZOS)
        # Closed tropical canopy in s2cloudless is nearly black on a dark page.
        # The same lift goes on every crop of both places, so what the figure
        # claims about them — that they are the same colour — survives it.
        img = Image.eval(img, lambda v: min(255, int(round(255 * (v / 255) ** 0.72))))

        name = f"pair-{tag}-{i:02d}.webp"
        img.save(STORY / name, "WEBP", quality=82, method=6)
        out.append({"src": f"story/{name}", "m": round(m * side / w, 1)})
    total = sum((STORY / Path(l["src"]).name).stat().st_size for l in out)
    print(f"    {len(out)} zoom levels, {total / 1024:.0f} KB")
    return out


def veg_fraction(rh_row, floor_m: float) -> float:
    """Share of the return that never reached the ground — canopy cover's proxy."""
    from utils import pixel_vertical_profile

    hist = np.asarray(
        pixel_vertical_profile(
            rh_row, interval=1, max_height=int(PROFILE_MAX_M), min_height=floor_m
        ),
        dtype="float64",
    )
    heights = floor_m + np.arange(len(hist)) + 0.5
    total = hist.sum()
    return float(hist[heights > GROUND_ECHO_M].sum() / total) if total else 0.0


def main() -> None:
    if not GEDI.exists() or not BACKDROP.exists():
        print("missing inputs (need art/21LTD.parquet and the chapter-2 backdrop)")
        return

    lon, lat, rh = load_shots()
    rh98, rh50 = rh[:, 98], rh[:, 50]
    forest = (rh98 >= RH98_MIN) & (rh98 <= RH98_MAX) & np.isfinite(rh50)
    print(f"  {int(forest.sum())} shots between {RH98_MIN:.0f} and {RH98_MAX:.0f} m")

    idx = np.flatnonzero(forest)
    veg = np.array([veg_fraction(rh[i], -10.0) for i in idx])
    closed = veg >= VEG_MIN
    idx, veg = idx[closed], veg[closed]
    print(f"  {len(idx)} of them closed canopy ({VEG_MIN:.0%} of the return above ground)")

    colours = mean_colours(lon[idx], lat[idx])
    ratio = rh50[idx] / rh98[idx]

    # Every pair that a map from above could not tell apart, ranked by how
    # differently they are built inside.
    best = None
    for a in range(len(idx)):
        near = (
            (np.abs(rh98[idx] - rh98[idx][a]) <= RH98_TOLERANCE_M)
            & (np.abs(colours - colours[a]).mean(axis=1) <= COLOUR_TOLERANCE)
        )
        near[a] = False
        if not near.any():
            continue
        b = int(np.flatnonzero(near)[np.argmax(np.abs(ratio[near] - ratio[a]))])
        gap = abs(ratio[b] - ratio[a])
        if best is None or gap > best[0]:
            best = (gap, a, b)

    if best is None:
        print("  no pair passes both tests — nothing exported")
        return

    gap, a, b = best
    # Closed canopy first: the reader meets the surprise second.
    if ratio[a] < ratio[b]:
        a, b = b, a
    pair = [idx[a], idx[b]]
    print(f"  RH50/RH98 differs by {gap:.2f} between the two")

    floor_m = float(np.floor(min(rh[pair, 0].min(), -1.0) / 5.0) * 5.0)
    out = []
    for n, i in enumerate(pair):
        colour = colours[a if n == 0 else b]
        print(
            f"  place {'AB'[n]}: RH98 {rh98[i]:.1f} m  RH50 {rh50[i]:.1f} m"
            f"  ({rh50[i] / rh98[i] * 100:.0f}% of its height)  rgb {colour.round(0)}"
        )
        profile = waveform(rh[i], floor_m)
        share = veg[a if n == 0 else b]
        print(f"    {share * 100:.0f}% of its return came from above {GROUND_ECHO_M} m")
        levels = zoom_stack(float(lon[i]), float(lat[i]), "ab"[n])
        out.append(
            {
                "zoom": levels,
                "lon": round(float(lon[i]), 5),
                "lat": round(float(lat[i]), 5),
                "rh98": round(float(rh98[i]), 1),
                "rh50": round(float(rh50[i]), 1),
                "rh": [round(float(rh[i][p]), 2) for p in RH_STEPS],
                "profile": profile,
                # What share of the pulse never reached the ground. This is what
                # sets how much of the drawn stand is crown, so the picture
                # cannot claim a closed canopy the measurement does not support.
                # It is the raw energy share, not GEDI's cover product, which
                # also corrects for how differently canopy and ground reflect.
                "veg": round(float(share), 3),
            }
        )

    mid_lon = float(np.mean(lon[pair]))
    mid_lat = float(np.mean(lat[pair]))
    print(f"  shared map centred on {mid_lat:.4f}, {mid_lon:.4f}")
    shared = zoom_stack(mid_lon, mid_lat, "w", SHARED_LEVELS_M)
    pins = [
        {
            "dx": round(float((lon[i] - mid_lon) * 111_320 * np.cos(np.radians(mid_lat)))),
            "dy": round(float((lat[i] - mid_lat) * 110_574)),
        }
        for i in pair
    ]

    data = {
        "rhSteps": RH_STEPS,
        "shared": shared,
        "pins": pins,
        "splitM": SPLIT_M,
        "boxM": BOX_M,
        "profileMinM": floor_m,
        "profileMaxM": PROFILE_MAX_M,
        "footprintM": 25.0,
        # Where the fly-in stops: a few Sentinel-2 pixels across, which is as
        # close as this imagery can honestly be taken.
        "closestM": 42,
        "groundEchoM": GROUND_ECHO_M,
        # What the two have in common, for the figure to say out loud.
        "colourDelta": round(float(np.abs(colours[a] - colours[b]).mean()), 1),
        "heightDelta": round(float(abs(rh98[pair[0]] - rh98[pair[1]])), 1),
        "places": out,
    }
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"  {OUT.relative_to(REPO)}  {OUT.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    print("Chapter 1 — two places, one canopy top")
    main()
