"""Google / Esri satellite tile stitching and scale-bar overlay.

Used by:
- The transect figure (`transect_figure.py`)
- The area-images endpoint (`routes.py`)
- `routes/auxiliary.py` (imports via the package re-exports)
"""

from __future__ import annotations

import concurrent.futures
import io
import math
from typing import Optional, Tuple

import requests

from .utils import nice_bar_length_m


def _stitch_bbox_satellite(
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
    buffer_m: float = 200.0,
    max_width_px: int = 2048,
) -> Tuple[Optional[bytes], dict]:
    """Fetch and stitch satellite tiles for a bbox with a uniform buffer.

    Source: Google Maps' XYZ tile service (same imagery that the frontend
    OpenLayers map uses as basemap), fetched as **retina/HD tiles via
    `&scale=2`** which return 512×512 PNGs containing 2× more detail per
    geographic area than standard 256×256 tiles.  Falls back to the regular
    256-tile Google endpoint and then Esri World Imagery (256-tile).  This is
    NOT the Static Maps API and not a screenshot — it is direct tile fetching.

    Tiles are fetched in parallel (up to 16 workers).  Returns (png_bytes, metadata).
    """
    from PIL import Image

    mean_lat = (min_lat + max_lat) / 2.0
    lat_rad = math.radians(mean_lat)
    lat_buf = buffer_m / 111320.0
    lon_buf = buffer_m / (111320.0 * max(1e-6, math.cos(lat_rad)))

    bmin_lon = min_lon - lon_buf
    bmax_lon = max_lon + lon_buf
    bmin_lat = min_lat - lat_buf
    bmax_lat = max_lat + lat_buf

    span_m = (bmax_lon - bmin_lon) * 111320.0 * max(1e-6, math.cos(lat_rad))
    m_per_px_target = max(0.01, span_m / max_width_px)
    m_per_px_zoom0 = 156543.03392 * max(0.1, math.cos(lat_rad))

    def _stitch_at(url_builder, tile_px: int, scale: int) -> Optional[Tuple[bytes, dict]]:
        """Stitch tiles fetched at native `tile_px` resolution.

        `scale=1` -> 256-px tiles (standard zoom Z gives  m_per_px_zoom0 / 2^Z).
        `scale=2` -> 512-px tiles at the same zoom Z (twice the pixel density).
        We pick zoom for `scale` so the resulting image fills max_width_px.
        """
        # m_per_px_at_zoom = m_per_px_zoom0 / (2^zoom * scale)
        # Solve for zoom such that m_per_px_at_zoom == m_per_px_target.
        zoom = int(math.floor(math.log2(m_per_px_zoom0 / m_per_px_target / scale)))
        zoom = max(0, min(20, zoom))

        # `tile_px` here is the native pixel size of the *fetched* tile image
        # (256 for scale=1, 512 for scale=2). All pixel coordinates use this.
        def _ll_to_world(lon_v: float, lat_v: float) -> Tuple[float, float]:
            siny = math.sin(math.radians(lat_v))
            siny = min(max(siny, -0.9999), 0.9999)
            world = tile_px * (2 ** zoom)
            return (
                (lon_v + 180.0) / 360.0 * world,
                (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * world,
            )

        left, top = _ll_to_world(bmin_lon, bmax_lat)
        right, bottom = _ll_to_world(bmax_lon, bmin_lat)
        img_w = max(1, int(round(right - left)))
        img_h = max(1, int(round(bottom - top)))

        min_tx = int(math.floor(left / tile_px))
        max_tx = int(math.floor((right - 1) / tile_px))
        min_ty = int(math.floor(top / tile_px))
        max_ty = int(math.floor((bottom - 1) / tile_px))
        world_tiles = 2 ** zoom

        tiles = [
            (tx, ty)
            for ty in range(min_ty, max_ty + 1)
            if 0 <= ty < world_tiles
            for tx in range(min_tx, max_tx + 1)
        ]

        stitched_w = (max_tx - min_tx + 1) * tile_px
        stitched_h = (max_ty - min_ty + 1) * tile_px
        stitched = Image.new("RGB", (stitched_w, stitched_h))

        def _fetch_one(tx_ty: Tuple[int, int]) -> Tuple[int, int, bytes]:
            tx, ty = tx_ty
            wrapped_tx = tx % world_tiles
            url = url_builder(wrapped_tx, ty, zoom)
            resp = requests.get(url, timeout=20)
            resp.raise_for_status()
            return tx, ty, resp.content

        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(16, max(1, len(tiles)))
        ) as exe:
            results = list(exe.map(_fetch_one, tiles))

        for tx, ty, data in results:
            tile_img = Image.open(io.BytesIO(data)).convert("RGB")
            # Defensive: if the server didn't honour scale=2, the tile will be
            # 256×256 instead of expected 512×512 — refuse to stitch in that
            # case so we can fall back to scale=1.
            if tile_img.size != (tile_px, tile_px):
                raise RuntimeError(
                    f"Tile size mismatch: expected {tile_px}×{tile_px}, got {tile_img.size}"
                )
            stitched.paste(tile_img, ((tx - min_tx) * tile_px, (ty - min_ty) * tile_px))

        crop_left = int(round(left - min_tx * tile_px))
        crop_top = int(round(top - min_ty * tile_px))
        cropped = stitched.crop((crop_left, crop_top, crop_left + img_w, crop_top + img_h))
        out = io.BytesIO()
        cropped.save(out, format="PNG")
        meta_local = {
            "min_lon": bmin_lon,
            "max_lon": bmax_lon,
            "min_lat": bmin_lat,
            "max_lat": bmax_lat,
            "zoom": zoom,
            "width_px": img_w,
            "height_px": img_h,
        }
        return out.getvalue(), meta_local

    # Try each provider in order; the first that succeeds wins.
    providers = [
        # Primary: Google retina/HD tiles via &scale=2 (512×512, ~2× detail).
        (
            lambda tx, ty, z: f"https://mt{(tx + ty) % 4}.google.com/vt/lyrs=s&x={tx}&y={ty}&z={z}&scale=2",
            512, 2,
        ),
        # Fallback 1: standard Google satellite tiles (256×256).
        (
            lambda tx, ty, z: f"https://mt{(tx + ty) % 4}.google.com/vt/lyrs=s&x={tx}&y={ty}&z={z}",
            256, 1,
        ),
        # Fallback 2: Esri World Imagery (no API key required, 256×256).
        (
            lambda tx, ty, z: (
                f"https://services.arcgisonline.com/ArcGIS/rest/services/"
                f"World_Imagery/MapServer/tile/{z}/{ty}/{tx}"
            ),
            256, 1,
        ),
    ]
    fallback_meta = {
        "min_lon": bmin_lon, "max_lon": bmax_lon,
        "min_lat": bmin_lat, "max_lat": bmax_lat,
        "zoom": 0, "width_px": 0, "height_px": 0,
    }
    for url_builder, tile_px, scale in providers:
        try:
            result = _stitch_at(url_builder, tile_px=tile_px, scale=scale)
            if result is not None:
                return result
        except Exception:
            continue
    return None, fallback_meta


def _stitch_bbox_eox_s2cloudless(
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
    buffer_m: float = 200.0,
    max_width_px: int = 2048,
    year: int = 2020,
) -> Tuple[Optional[bytes], dict]:
    """Fetch and stitch the EOX `s2cloudless-<year>` mosaic for a bbox + buffer.

    Source: EOX `s2cloudless-<year>_3857` WMTS layer
    (`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-<year>_3857/default/g/{z}/{y}/{x}.jpg`).
    Standard EPSG:3857 Web Mercator tile grid with 256×256 JPEGs; EOX publishes
    zoom 0-14 only.

    Returns (png_bytes, metadata) using the same shape as
    `_stitch_bbox_satellite` so callers can swap the two interchangeably.
    """
    from PIL import Image

    mean_lat = (min_lat + max_lat) / 2.0
    lat_rad = math.radians(mean_lat)
    lat_buf = buffer_m / 111320.0
    lon_buf = buffer_m / (111320.0 * max(1e-6, math.cos(lat_rad)))

    bmin_lon = min_lon - lon_buf
    bmax_lon = max_lon + lon_buf
    bmin_lat = min_lat - lat_buf
    bmax_lat = max_lat + lat_buf

    span_m = (bmax_lon - bmin_lon) * 111320.0 * max(1e-6, math.cos(lat_rad))
    m_per_px_target = max(0.01, span_m / max_width_px)
    m_per_px_zoom0 = 156543.03392 * max(0.1, math.cos(lat_rad))

    tile_px = 256
    # EOX caps the 3857 grid at zoom 14; clamp to that.
    EOX_MAX_ZOOM = 14
    zoom = int(math.floor(math.log2(m_per_px_zoom0 / m_per_px_target)))
    zoom = max(0, min(EOX_MAX_ZOOM, zoom))

    def _ll_to_world(lon_v: float, lat_v: float) -> Tuple[float, float]:
        siny = math.sin(math.radians(lat_v))
        siny = min(max(siny, -0.9999), 0.9999)
        world = tile_px * (2 ** zoom)
        return (
            (lon_v + 180.0) / 360.0 * world,
            (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * world,
        )

    left, top = _ll_to_world(bmin_lon, bmax_lat)
    right, bottom = _ll_to_world(bmax_lon, bmin_lat)
    img_w = max(1, int(round(right - left)))
    img_h = max(1, int(round(bottom - top)))

    min_tx = int(math.floor(left / tile_px))
    max_tx = int(math.floor((right - 1) / tile_px))
    min_ty = int(math.floor(top / tile_px))
    max_ty = int(math.floor((bottom - 1) / tile_px))
    world_tiles = 2 ** zoom

    tiles = [
        (tx, ty)
        for ty in range(min_ty, max_ty + 1)
        if 0 <= ty < world_tiles
        for tx in range(min_tx, max_tx + 1)
    ]

    stitched_w = (max_tx - min_tx + 1) * tile_px
    stitched_h = (max_ty - min_ty + 1) * tile_px
    stitched = Image.new("RGB", (stitched_w, stitched_h))

    base = (
        f"https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-{int(year)}_3857"
        f"/default/g/{zoom}/{{y}}/{{x}}.jpg"
    )

    def _fetch_one(tx_ty: Tuple[int, int]) -> Tuple[int, int, bytes]:
        tx, ty = tx_ty
        wrapped_tx = tx % world_tiles
        url = base.format(y=ty, x=wrapped_tx)
        # EOX rejects requests without a UA header on some edges; supply one.
        resp = requests.get(
            url,
            timeout=20,
            headers={"User-Agent": "map-explorer/transect-figure"},
        )
        resp.raise_for_status()
        return tx, ty, resp.content

    fallback_meta = {
        "min_lon": bmin_lon, "max_lon": bmax_lon,
        "min_lat": bmin_lat, "max_lat": bmax_lat,
        "zoom": zoom, "width_px": 0, "height_px": 0,
    }
    try:
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(16, max(1, len(tiles)))
        ) as exe:
            results = list(exe.map(_fetch_one, tiles))
    except Exception:
        return None, fallback_meta

    try:
        for tx, ty, data in results:
            tile_img = Image.open(io.BytesIO(data)).convert("RGB")
            if tile_img.size != (tile_px, tile_px):
                # EOX should always return 256×256; refuse on mismatch.
                return None, fallback_meta
            stitched.paste(tile_img, ((tx - min_tx) * tile_px, (ty - min_ty) * tile_px))

        crop_left = int(round(left - min_tx * tile_px))
        crop_top = int(round(top - min_ty * tile_px))
        cropped = stitched.crop((crop_left, crop_top, crop_left + img_w, crop_top + img_h))
        out = io.BytesIO()
        cropped.save(out, format="PNG")
        return out.getvalue(), {
            "min_lon": bmin_lon,
            "max_lon": bmax_lon,
            "min_lat": bmin_lat,
            "max_lat": bmax_lat,
            "zoom": zoom,
            "width_px": img_w,
            "height_px": img_h,
        }
    except Exception:
        return None, fallback_meta


def _burn_scale_bar(png_bytes: bytes, meta: dict) -> bytes:
    """Overlay a metric scale bar on the lower-left corner of a stitched
    satellite PNG (re-encoded). Used by export paths that save a standalone
    HD satellite image (the matplotlib transect figure draws its own scale
    bar in axes coords, so this is NOT called from the transect path).
    """
    from PIL import Image, ImageDraw, ImageFont

    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = img.size

    # Geographic extent → meters per pixel along x, cosine-corrected at the
    # mean latitude of the image.
    min_lon = float(meta.get("min_lon", 0.0))
    max_lon = float(meta.get("max_lon", 0.0))
    min_lat = float(meta.get("min_lat", 0.0))
    max_lat = float(meta.get("max_lat", 0.0))
    mean_lat = (min_lat + max_lat) / 2.0
    span_m = (max_lon - min_lon) * 111320.0 * max(1e-6, math.cos(math.radians(mean_lat)))
    if span_m <= 0 or w <= 0:
        return png_bytes
    m_per_px = span_m / w

    # Pick a "nice" round bar length (1 / 2 / 5 × 10^k m) that fills ~12% of
    # the image width.
    bar_m = nice_bar_length_m(m_per_px * w * 0.12)
    if bar_m <= 0:
        return png_bytes
    bar_px = bar_m / m_per_px
    if bar_px < 20 or bar_px > w * 0.6:
        return png_bytes  # degenerate scale — skip rather than overlay junk

    # Layout: inset from lower-left corner. Geometry sized relative to image
    # dimensions so it scales with the HD output.
    # Scale the bar geometry from the LONGER side so very wide/short or very
    # tall/narrow crops still get a legible bar — using only `h` makes the
    # text shrink to nothing on landscape-thin crops.
    ref = max(w, h)
    inset_x = max(16, int(w * 0.015))
    inset_y = max(20, int(h * 0.035))
    line_w = max(5, int(ref * 0.005))
    tick_h = max(16, int(ref * 0.020))
    font_px = max(56, int(ref * 0.060))

    bar_y = h - inset_y
    bar_x0 = inset_x
    bar_x1 = int(round(bar_x0 + bar_px))

    draw = ImageDraw.Draw(img)

    # Bar + end ticks. Draw white halo first (thicker), black line on top.
    halo_w = line_w + 2
    draw.line([(bar_x0, bar_y), (bar_x1, bar_y)], fill="white", width=halo_w)
    draw.line([(bar_x0, bar_y), (bar_x1, bar_y)], fill="black", width=line_w)
    for xv in (bar_x0, bar_x1):
        draw.line([(xv, bar_y - tick_h), (xv, bar_y + tick_h)], fill="white", width=halo_w)
        draw.line([(xv, bar_y - tick_h), (xv, bar_y + tick_h)], fill="black", width=line_w)

    # Label centered above the bar with a 2-px white stroke for readability.
    label_text = f"{int(bar_m)} m" if bar_m < 1000 else f"{bar_m / 1000:g} km"
    font = None
    for candidate in (
        "DejaVuSans.ttf",
        "Arial.ttf",
        "Helvetica.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        try:
            font = ImageFont.truetype(candidate, font_px)
            break
        except (IOError, OSError):
            continue
    if font is None:
        font = ImageFont.load_default()

    label_cx = (bar_x0 + bar_x1) // 2
    label_baseline_y = bar_y - tick_h - max(2, int(h * 0.005))
    # Pillow ≥ 8 supports stroke_width / stroke_fill for crisp haloed text.
    try:
        draw.text(
            (label_cx, label_baseline_y),
            label_text,
            fill="black",
            font=font,
            anchor="md",  # middle / descender baseline
            stroke_width=2,
            stroke_fill="white",
        )
    except TypeError:
        # Older Pillow without stroke / anchor — fall back to manual halo.
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                draw.text(
                    (label_cx + dx, label_baseline_y + dy),
                    label_text,
                    fill="white",
                    font=font,
                )
        draw.text((label_cx, label_baseline_y), label_text, fill="black", font=font)

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()
