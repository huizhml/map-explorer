"""Small shared helpers used by multiple saved-feature submodules."""

from __future__ import annotations

from datetime import datetime, timezone
import math
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from rasterio.windows import Window, from_bounds

from .config import IMAGE_ROOT


# ---------------------------------------------------------------------------
# Filename / path helpers
# ---------------------------------------------------------------------------

def sanitize_name(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name.strip())
    cleaned = cleaned.strip("._")
    return cleaned or "layer"


def new_session_dir() -> Tuple[Path, str]:
    """Allocate a fresh per-export directory under `IMAGE_ROOT`.

    The directory name (timestamp + short uuid) is also returned as a string so
    callers can store it inside the saved feature's plot_data for cleanup on
    deletion. The directory is created eagerly.
    """
    name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid4().hex[:8]}"
    path = IMAGE_ROOT / name
    path.mkdir(parents=True, exist_ok=True)
    return path, name


def image_url_for(relative_path: Path | str) -> str:
    """Public URL the frontend uses to fetch an exported image."""
    rel = Path(relative_path).as_posix()
    return f"/saved-features/image/{rel}"


# ---------------------------------------------------------------------------
# Raster windowing
# ---------------------------------------------------------------------------

def clip_window(src, xmin: float, ymin: float, xmax: float, ymax: float) -> Window:
    """Intersect a geographic bbox window with the dataset's pixel extent.

    Returns a `Window` with integer offsets / lengths. Width or height may be
    ≤ 0 if the bbox is fully outside the dataset — callers should check.
    """
    window = from_bounds(xmin, ymin, xmax, ymax, transform=src.transform)
    full_window = Window(0, 0, src.width, src.height)
    return window.intersection(full_window).round_offsets().round_lengths()


# ---------------------------------------------------------------------------
# Scale-bar nice-length picker (shared between map scale bars)
# ---------------------------------------------------------------------------

def nice_bar_length_m(target_m: float) -> float:
    """Round `target_m` to the nearest 1 / 2 / 5 × 10ᵏ value.

    Standard cartographic convention so a "10 % of visible width" bar lands on
    e.g. 100 m, 200 m, 500 m, 1 km instead of an awkward 137 m. Returns 0 when
    `target_m` is non-positive (caller should skip drawing).
    """
    if target_m <= 0:
        return 0.0
    pow10 = 10.0 ** math.floor(math.log10(target_m))
    leading = target_m / pow10
    if leading < 1.5:
        return 1.0 * pow10
    if leading < 3.5:
        return 2.0 * pow10
    if leading < 7.5:
        return 5.0 * pow10
    return 10.0 * pow10


def step_up_bar_length_m(bar_m: float) -> float:
    """Return the next-coarser 1 / 2 / 5 × 10ᵏ step above `bar_m`.

    `nice_bar_length_m` picks the bar closest to the target fraction of the
    image; export paths that want a deliberately larger, easier-to-read bar
    advance it exactly one cartographic step (… 200 m → 500 m → 1 km …).
    """
    if bar_m <= 0:
        return 0.0
    pow10 = 10.0 ** math.floor(math.log10(bar_m))
    leading = round(bar_m / pow10)
    if leading < 2:
        return 2.0 * pow10
    if leading < 5:
        return 5.0 * pow10
    return 10.0 * pow10


# ---------------------------------------------------------------------------
# Plot data helpers
# ---------------------------------------------------------------------------

def upsert_image_export(plot_data: Dict[str, Any], new_item: Dict[str, Any]) -> None:
    """Replace any existing image export with the same `layer_id` and append
    `new_item` to `plot_data["image_exports"]`. Also keeps
    `plot_data["image_session_dir"]` pointed at the latest export's session.
    """
    existing = plot_data.get("image_exports")
    if not isinstance(existing, list):
        existing = []
    existing = [item for item in existing if isinstance(item, dict)]
    layer_id = new_item.get("layer_id")
    if layer_id:
        existing = [item for item in existing if item.get("layer_id") != layer_id]
    existing.append(new_item)
    plot_data["image_exports"] = existing
    rel = new_item.get("relative_path")
    if rel:
        plot_data["image_session_dir"] = Path(rel).parts[0]


def existing_image_exports(plot_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return a defensive copy of the image_exports list, dropping non-dicts."""
    exports = plot_data.get("image_exports")
    if not isinstance(exports, list):
        return []
    return [item for item in exports if isinstance(item, dict)]


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

# Cap so a malicious / accidental payload can't blow up the metadata JSON.
MAX_TAG_LENGTH = 60
MAX_TAGS_PER_FEATURE = 30


def normalize_tags(tags: Optional[List[Any]]) -> List[str]:
    """Trim, dedupe (case-insensitive), and clamp a tag list.

    Order is preserved by first occurrence. Casing of the first occurrence
    wins — by the time we hit `routes`, the suggestion list is already
    consistent across rows, so saving "Forest" then "forest" keeps "Forest".
    """
    if not isinstance(tags, list):
        return []
    seen: Dict[str, str] = {}
    for raw in tags:
        if raw is None:
            continue
        text = str(raw).strip()
        if not text:
            continue
        if len(text) > MAX_TAG_LENGTH:
            text = text[:MAX_TAG_LENGTH]
        key = text.casefold()
        if key in seen:
            continue
        seen[key] = text
        if len(seen) >= MAX_TAGS_PER_FEATURE:
            break
    return list(seen.values())


def unlink_export_file(relative_path: Optional[str]) -> None:
    """Best-effort delete of an export file under `IMAGE_ROOT`. Never raises."""
    if not isinstance(relative_path, str) or not relative_path:
        return
    try:
        p = (IMAGE_ROOT / relative_path).resolve()
        if IMAGE_ROOT.resolve() in p.parents and p.is_file():
            p.unlink(missing_ok=True)
    except Exception:
        pass
