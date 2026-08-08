"""Export a curated subset of saved features as a self-contained bundle.

The showcase sites on the public site are authored the normal way — draw the
transect in the app, save the feature, tag it — and this endpoint turns a
filtered selection of those features into a ZIP the frontend repo can serve
statically.

Why a bundle rather than having the public frontend read the database live:

  * Speed. A random-site button is a light, exploratory gesture; making it wait
    on a cold Cloud Run instance and a database round trip ruins it. Static JSON
    plus pre-rendered PNGs answer instantly.
  * Scope. Shipping the database itself would publish the whole working set —
    every half-finished experiment and internal note in it. Only tagged
    features leave through here.
  * Independence. The showcase keeps working when the backend is cold, when
    source.coop is slow, or when the backend is down entirely.

The browser is the only thing that talks to both the internal backend and the
author's checkout, so it is the bridge: the app downloads this bundle and a
repo script unpacks it into public/sites/.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query
from fastapi.responses import Response

from .config import IMAGE_ROOT
from .db import FEATURE_COLUMNS, db_connect, row_to_feature

router = APIRouter(tags=["saved-features"])


def _tags_of(feature: Dict[str, Any]) -> List[str]:
    meta = feature.get("metadata")
    if not isinstance(meta, dict):
        return []
    tags = meta.get("tags")
    if not isinstance(tags, list):
        return []
    return [str(t).strip() for t in tags if str(t).strip()]


def _centroid(geometry: Dict[str, Any]) -> Optional[List[float]]:
    """Representative lon/lat, so the frontend can fly to a site without
    carrying geometry maths of its own."""
    coords = geometry.get("coordinates")
    gtype = geometry.get("type")
    try:
        if gtype == "Point":
            return [float(coords[0]), float(coords[1])]
        if gtype == "LineString":
            pts = coords
        elif gtype == "Polygon":
            pts = coords[0]
        else:
            return None
        lons = [float(p[0]) for p in pts]
        lats = [float(p[1]) for p in pts]
        return [sum(lons) / len(lons), sum(lats) / len(lats)]
    except Exception:
        return None


def _image_entries(feature: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Rendered images are listed under `plot_data.image_exports`.

    Not under `metadata`, where `tags` and the render settings live — checked
    against a real database, where 54 of 63 features carry the list in
    plot_data and none carry it in metadata. Metadata is still consulted as a
    fallback in case an older row was written the other way round.
    """
    for container in (feature.get("plot_data"), feature.get("metadata")):
        if not isinstance(container, dict):
            continue
        exports = container.get("image_exports")
        if isinstance(exports, list):
            entries = [e for e in exports if isinstance(e, dict)]
            if entries:
                return entries
    return []


@router.get("/saved-features/export")
async def export_saved_features(
    tags: str = Query("", description="Comma-separated tags; a feature matches if it has any of them."),
    ids: str = Query("", description="Comma-separated feature ids, applied on top of the tag filter."),
    include_images: bool = Query(True),
):
    wanted_tags = {t.strip().casefold() for t in tags.split(",") if t.strip()}
    wanted_ids = {int(i) for i in ids.split(",") if i.strip().isdigit()}

    with db_connect() as conn:
        rows = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features ORDER BY created_at DESC, id DESC"
        ).fetchall()
    features = [row_to_feature(r) for r in rows]

    selected = []
    for f in features:
        if wanted_ids and f["id"] not in wanted_ids:
            continue
        if wanted_tags and not ({t.casefold() for t in _tags_of(f)} & wanted_tags):
            continue
        selected.append(f)

    sites: List[Dict[str, Any]] = []
    files: Dict[str, Path] = {}
    missing: List[str] = []

    for f in selected:
        images = []
        for idx, entry in enumerate(_image_entries(f)):
            rel = entry.get("relative_path") or entry.get("preview_relative_path")
            if not rel:
                continue
            source = (IMAGE_ROOT / rel).resolve()
            # Same containment check the image route makes: a relative_path from
            # the database is not automatically trustworthy.
            if IMAGE_ROOT.resolve() not in source.parents or not source.is_file():
                missing.append(str(rel))
                continue
            name = f"images/{f['id']}-{idx}{source.suffix.lower() or '.png'}"
            if include_images:
                files[name] = source
            images.append({
                "file": name,
                "kind": entry.get("kind") or entry.get("layer") or entry.get("label"),
                "caption": entry.get("caption") or entry.get("title"),
                "mime_type": entry.get("mime_type"),
            })

        sites.append({
            "id": f["id"],
            "name": f["name"],
            "description": f["description"],
            "category": f["category"],
            "geometry": f["geometry"],
            "center": _centroid(f["geometry"]),
            "tags": _tags_of(f),
            "created_at": f["created_at"],
            "images": images,
        })

    manifest = {
        "version": 1,
        "filter": {"tags": sorted(wanted_tags), "ids": sorted(wanted_ids)},
        "count": len(sites),
        "missing_images": missing,
        "sites": sites,
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("sites.json", json.dumps(manifest, indent=2, ensure_ascii=False))
        for name, source in files.items():
            zf.write(source, name)

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="sites-bundle.zip"',
            # Surfaced so the UI can report the result without unzipping.
            "X-Site-Count": str(len(sites)),
            "X-Missing-Images": str(len(missing)),
            "Access-Control-Expose-Headers": "X-Site-Count, X-Missing-Images, Content-Disposition",
        },
    )
