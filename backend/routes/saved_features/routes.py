"""FastAPI HTTP endpoints for saved features and transect figures."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from rasterio.warp import transform_bounds

from .area_images import render_area_images
from .config import IMAGE_ROOT
from .db import (
    FEATURE_COLUMNS,
    compute_feature_key,
    compute_feature_uid,
    compute_geom_uid,
    db_connect,
    row_to_feature,
    upsert_feature,
    validate_geometry,
)
from .models import (
    FigureLayerSpec,
    GeometryLookupRequest,
    RefreshAreaImagesRequest,
    RefreshPredictionSnapshotRequest,
    SaveAreaImagesRequest,
    SavedFeatureCreateRequest,
    SavedFeatureUpdateRequest,
    TransectFigureRequest,
    TransectSatelliteRequest,
    VerticalProfileFigureRequest,
)
from .point_snapshots import (
    _extract_eox_s2cloudless_point_snapshot,
    _extract_google_point_snapshot,
    _extract_prediction_rh98_snapshot,
    _extract_sentinel2_point_snapshots,
    _resolve_prediction_tile_name,
)
from .satellite import _burn_scale_bar, _stitch_bbox_satellite
from .transect_figure import _render_transect_figure
from .vertical_profile_figure import _render_vertical_profile_figure
from .utils import (
    existing_image_exports,
    image_url_for,
    new_session_dir,
    normalize_tags,
    sanitize_name,
    unlink_export_file,
    upsert_image_export,
)


router = APIRouter(tags=["saved_features"])


# ---------------------------------------------------------------------------
# Saved-features CRUD
# ---------------------------------------------------------------------------

@router.get("/saved-features")
async def list_saved_features() -> Dict[str, Any]:
    with db_connect() as conn:
        rows = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features "
            f"ORDER BY created_at DESC, id DESC"
        ).fetchall()
    return {"features": [row_to_feature(row) for row in rows]}


@router.get("/saved-features/tags")
async def list_saved_feature_tags() -> Dict[str, Any]:
    """All distinct tags across saved features, case-insensitive.

    First-seen casing wins (matching the normalizer's behaviour per-feature),
    so a tag originally saved as "Forest" stays "Forest" even if a later
    feature uses "forest". Frontend uses this for the tag autocomplete.
    """
    with db_connect() as conn:
        rows = conn.execute(
            "SELECT metadata_json FROM saved_features "
            "WHERE metadata_json IS NOT NULL AND metadata_json != '' "
            "ORDER BY id ASC"
        ).fetchall()
    seen: Dict[str, str] = {}
    for row in rows:
        try:
            meta = json.loads(row["metadata_json"]) if row["metadata_json"] else None
        except Exception:
            continue
        if not isinstance(meta, dict):
            continue
        tags = meta.get("tags")
        if not isinstance(tags, list):
            continue
        for raw in tags:
            text = str(raw).strip() if raw is not None else ""
            if not text:
                continue
            key = text.casefold()
            if key not in seen:
                seen[key] = text
    return {"tags": sorted(seen.values(), key=lambda s: s.casefold())}


@router.post("/saved-features/lookup-by-geometry")
async def lookup_saved_feature_by_geometry(
    payload: GeometryLookupRequest,
) -> Dict[str, Any]:
    """Return the most-recent saved feature with the same `geom_uid`, if any.

    The save dialog calls this on open to prefill name / category / description
    / tags so the user doesn't have to re-type them when revisiting an area.
    Always returns 200; `feature` is null when no match exists.
    """
    geometry_dict = payload.geometry.model_dump()
    validate_geometry(geometry_dict)
    geom_uid = compute_geom_uid(geometry_dict)
    with db_connect() as conn:
        row = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features "
            f"WHERE geom_uid = ? ORDER BY created_at DESC, id DESC LIMIT 1",
            (geom_uid,),
        ).fetchone()
    return {
        "geom_uid": geom_uid,
        "feature": row_to_feature(row) if row is not None else None,
    }


@router.post("/saved-features")
async def create_saved_feature(payload: SavedFeatureCreateRequest) -> Dict[str, Any]:
    geometry_dict = payload.geometry.model_dump()
    validate_geometry(geometry_dict)

    description = payload.description.strip() if payload.description else None
    category = payload.category.strip() if payload.category else None
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Feature name is required")

    metadata_payload: Dict[str, Any] = dict(payload.metadata or {})
    plot_data_payload: Dict[str, Any] = dict(payload.plot_data or {})

    # Tags live inside metadata so they stay with the feature without a schema
    # change; explicit `tags` on the request overrides any tags already in
    # `metadata.tags` (the dialog always sends the latest).
    if payload.tags is not None:
        metadata_payload["tags"] = normalize_tags(payload.tags)
    elif "tags" in metadata_payload:
        metadata_payload["tags"] = normalize_tags(metadata_payload.get("tags"))

    # For saved popup points, attempt 75 m exports (satellite + RH98 + Sentinel-2)
    # and capture the VSM vertical profile so the saved point renders it offline.
    if geometry_dict["type"] == "Point" and metadata_payload.get("source") == "feature_popup":
        _attach_feature_popup_snapshots(geometry_dict, metadata_payload, plot_data_payload)
        _attach_vertical_profile(geometry_dict, metadata_payload, plot_data_payload)

    feature_key = compute_feature_key(geometry_dict, metadata_payload)
    metadata_json = json.dumps(metadata_payload) if metadata_payload else None
    plot_data_json = json.dumps(plot_data_payload) if plot_data_payload else None

    with db_connect() as conn:
        row = upsert_feature(
            conn,
            name=name,
            description=description,
            category=category,
            geometry_dict=geometry_dict,
            feature_key=feature_key,
            metadata_json=metadata_json,
            plot_data_json=plot_data_json,
        )
        conn.commit()
    return {"feature": row_to_feature(row)}


def _attach_feature_popup_snapshots(
    geometry_dict: Dict[str, Any],
    metadata_payload: Dict[str, Any],
    plot_data_payload: Dict[str, Any],
) -> None:
    """Render Google / RH98 / Sentinel-2 75 m snapshots for a feature_popup
    point and merge them into the metadata + plot_data payloads in-place.

    All failures are swallowed and recorded as `*_status` / `*_error` fields
    so the save itself still succeeds.
    """
    try:
        lon, lat = geometry_dict["coordinates"]
        lon = float(lon)
        lat = float(lat)
    except Exception:
        metadata_payload["satellite_snapshot_status"] = "unavailable"
        metadata_payload["satellite_snapshot_error"] = "invalid_point_coordinates"
        return

    try:
        # ---- Google satellite ----
        snapshot, snapshot_error = _extract_google_point_snapshot(lon, lat, buffer_m=75.0)
        if snapshot:
            upsert_image_export(plot_data_payload, snapshot)
            metadata_payload["point_buffer_m"] = 75.0
            metadata_payload["satellite_snapshot"] = {
                "provider": snapshot.get("provider"),
                "zoom": snapshot.get("zoom"),
            }
            metadata_payload["satellite_snapshot_status"] = "ok"
        else:
            metadata_payload["satellite_snapshot_status"] = "unavailable"
            if snapshot_error:
                metadata_payload["satellite_snapshot_error"] = snapshot_error[:300]

        # ---- RH98 prediction ----
        pred_year = int(metadata_payload.get("year") or 2020)
        # Accept the new "version" key or the legacy "prediction_source" key.
        # NOT "source": that field is the origin discriminator ("feature_popup"
        # / "area_images") — falling back to it poisons the prediction path
        # template with e.g. ".../vsm/2020/feature_popup/..." and silently
        # drops the RH98 snapshot for every popup-saved point.
        pred_version = (
            str(
                metadata_payload.get("version")
                or metadata_payload.get("prediction_source")
                or "original"
            ).strip().lower()
            or "original"
        )
        pred_q_index = int(metadata_payload.get("q_index") or 1)
        tile_name = _resolve_prediction_tile_name(metadata_payload, lat, lon)
        # Optional rescale / colormap forwarded by the frontend so the saved
        # snapshot matches whatever the user currently sees on the map. Falls
        # back to the live-map defaults (0..500, inferno) inside the snapshot
        # function when these are absent.
        pred_vis = metadata_payload.get("prediction_visualization") or {}
        pred_rmin = pred_vis.get("rescale_min") if isinstance(pred_vis, dict) else None
        pred_rmax = pred_vis.get("rescale_max") if isinstance(pred_vis, dict) else None
        pred_cmap = pred_vis.get("colormap") if isinstance(pred_vis, dict) else None
        pred_snapshot, pred_error = _extract_prediction_rh98_snapshot(
            lon, lat,
            year=pred_year, version=pred_version, q_index=pred_q_index,
            tile_name=str(tile_name) if tile_name else None,
            buffer_m=75.0,
            rescale_min=float(pred_rmin) if isinstance(pred_rmin, (int, float)) else None,
            rescale_max=float(pred_rmax) if isinstance(pred_rmax, (int, float)) else None,
            colormap=str(pred_cmap) if isinstance(pred_cmap, str) and pred_cmap.strip() else None,
        )
        if pred_snapshot:
            upsert_image_export(plot_data_payload, pred_snapshot)
            metadata_payload["prediction_snapshot_status"] = "ok"
            metadata_payload["prediction_snapshot"] = {
                "rh": 98,
                "q_index": pred_q_index,
                "year": pred_year,
                "version": pred_version,
            }
        else:
            metadata_payload["prediction_snapshot_status"] = "unavailable"
            if pred_error:
                metadata_payload["prediction_snapshot_error"] = pred_error[:300]
            metadata_payload["prediction_snapshot_debug"] = {
                "tile_name": tile_name,
                "year": pred_year,
                "q_index": pred_q_index,
                "version": pred_version,
            }

        # ---- Sentinel-2 ----
        # Prefer the actual Sentinel-2 layer(s) the user has loaded on the map
        # (true acquisition for that scene). If none are loaded — or they all
        # fail to render here — fall back to the EOX s2cloudless cloud-free
        # mosaic for the point's year so every saved point still gets a
        # Sentinel-2 reference image.
        def _attach_eox_s2_fallback() -> None:
            # gamma 1.3 lifts s2cloudless midtones (dark over forest canopy).
            s2_snapshot, s2_error = _extract_eox_s2cloudless_point_snapshot(
                lon, lat, year=pred_year, buffer_m=75.0, brightness=1.3,
            )
            if s2_snapshot:
                upsert_image_export(plot_data_payload, s2_snapshot)
                metadata_payload["sentinel2_snapshot_status"] = "ok"
                metadata_payload["sentinel2_snapshot_count"] = 1
                metadata_payload["sentinel2_snapshot"] = {
                    "source": "eox_s2cloudless",
                    "year": s2_snapshot.get("year"),
                    "requested_year": s2_snapshot.get("requested_year"),
                }
            else:
                metadata_payload["sentinel2_snapshot_status"] = "unavailable"
                metadata_payload["sentinel2_snapshot_count"] = 0
                if s2_error:
                    metadata_payload["sentinel2_snapshot_error"] = s2_error[:300]

        sentinel_layers = metadata_payload.get("sentinel2_layers")
        if isinstance(sentinel_layers, list) and len(sentinel_layers) > 0:
            sentinel_exports, sentinel_errors = _extract_sentinel2_point_snapshots(
                lon, lat,
                [layer for layer in sentinel_layers if isinstance(layer, dict)],
                buffer_m=75.0,
            )
            if sentinel_exports:
                for export in sentinel_exports:
                    upsert_image_export(plot_data_payload, export)
                metadata_payload["sentinel2_snapshot_status"] = "ok"
                metadata_payload["sentinel2_snapshot_count"] = len(sentinel_exports)
                metadata_payload["sentinel2_snapshot"] = {"source": "map_layer"}
                if sentinel_errors:
                    metadata_payload["sentinel2_snapshot_errors"] = sentinel_errors[:5]
            else:
                # Loaded layer(s) yielded nothing (e.g. point outside the
                # scene's extent) — fall back to EOX rather than save no S2.
                if sentinel_errors:
                    metadata_payload["sentinel2_snapshot_errors"] = sentinel_errors[:5]
                _attach_eox_s2_fallback()
        else:
            _attach_eox_s2_fallback()
    except Exception:
        metadata_payload["satellite_snapshot_status"] = "unavailable"
        metadata_payload["satellite_snapshot_error"] = "snapshot_generation_exception"
        metadata_payload["prediction_snapshot_status"] = "unavailable"
        metadata_payload["prediction_snapshot_error"] = "prediction_snapshot_generation_exception"


def _attach_vertical_profile(
    geometry_dict: Dict[str, Any],
    metadata_payload: Dict[str, Any],
    plot_data_payload: Dict[str, Any],
) -> None:
    """Compute and attach the VSM vertical profile for a feature_popup point.

    Stores the same shape the live ``/predictions/vertical-profile`` endpoint
    returns (``vertical_profile`` + ``vertical_profile_curve`` +
    ``profile_metrics``) so SavedFeaturePlots renders it from the stored blob
    without re-fetching. Independent of the snapshot attach — a snapshot
    failure must not drop the profile, and vice versa. All failures are
    swallowed and recorded as ``vertical_profile_status`` / ``_error``.
    """
    # Respect a client-supplied profile (e.g. saved from the InspectPanel).
    if plot_data_payload.get("vertical_profile_curve"):
        return
    try:
        lon, lat = geometry_dict["coordinates"]
        lon = float(lon)
        lat = float(lat)
    except Exception:
        metadata_payload["vertical_profile_status"] = "unavailable"
        metadata_payload["vertical_profile_error"] = "invalid_point_coordinates"
        return

    try:
        # Lazy import: predictions.py only depends on utils, so there is no
        # import cycle, but deferring keeps it off the module-load path.
        from routes.predictions import _compute_profile_at_point, _to_jsonable

        pred_year = int(metadata_payload.get("year") or 2020)
        # Same version resolution as the snapshot path: accept "version" or the
        # legacy "prediction_source", never the "source" origin discriminator.
        pred_version = (
            str(
                metadata_payload.get("version")
                or metadata_payload.get("prediction_source")
                or "original"
            ).strip().lower()
            or "original"
        )
        pred_q_index = int(metadata_payload.get("q_index") or 1)
        tile_name = _resolve_prediction_tile_name(metadata_payload, lat, lon)

        result = _to_jsonable(
            _compute_profile_at_point(
                lon, lat,
                year=pred_year,
                version=pred_version,
                q_index=pred_q_index,
                tile_name=str(tile_name) if tile_name else None,
            )
        )
        if result.get("success"):
            plot_data_payload["vertical_profile"] = result.get("profile")
            plot_data_payload["vertical_profile_curve"] = result.get("vertical_profile_curve")
            plot_data_payload["profile_metrics"] = {
                "fhd": result.get("fhd"),
                "enl1d": result.get("enl1d"),
                "enl2d": result.get("enl2d"),
                "cr": result.get("cr"),
            }
            metadata_payload["vertical_profile_status"] = "ok"
        else:
            metadata_payload["vertical_profile_status"] = "unavailable"
            if result.get("error"):
                metadata_payload["vertical_profile_error"] = str(result["error"])[:300]
    except Exception as exc:
        metadata_payload["vertical_profile_status"] = "unavailable"
        metadata_payload["vertical_profile_error"] = f"vertical_profile_exception: {exc}"[:300]


@router.post("/saved-features/area-images")
async def create_area_images_feature(payload: SaveAreaImagesRequest) -> Dict[str, Any]:
    if len(payload.extent_3857) != 4:
        raise HTTPException(status_code=400, detail="extent_3857 must contain exactly 4 numbers.")
    if not payload.layers:
        raise HTTPException(status_code=400, detail="No layers were provided.")

    xmin, ymin, xmax, ymax = [float(v) for v in payload.extent_3857]
    wgs_bounds = transform_bounds("EPSG:3857", "EPSG:4326", xmin, ymin, xmax, ymax)
    center_lon = (wgs_bounds[0] + wgs_bounds[2]) / 2
    center_lat = (wgs_bounds[1] + wgs_bounds[3]) / 2
    location_tag = f"{center_lat:.4f}_{center_lon:.4f}".replace("-", "m")

    session_dir, session_dir_name = new_session_dir()
    image_exports, render_errors = render_area_images(
        payload, session_dir, session_dir_name, location_tag,
    )

    # Optionally fetch a high-resolution Google Satellite snapshot of the same
    # drawing area and add it to the saved feature's image_exports.  Always PNG
    # — the retina (scale=2) tile fetcher returns lossless PNG data.
    if payload.include_google_satellite:
        try:
            sat_bytes, sat_meta = _stitch_bbox_satellite(
                float(wgs_bounds[0]),  # min lon
                float(wgs_bounds[2]),  # max lon
                float(wgs_bounds[1]),  # min lat
                float(wgs_bounds[3]),  # max lat
                buffer_m=0.0,
                max_width_px=int(payload.google_satellite_max_width_px),
            )
            if sat_bytes is None:
                render_errors.append({
                    "layer_id": "_google_satellite",
                    "name": "Google Satellite",
                    "error": "Tile fetch failed (no provider returned imagery)",
                })
            else:
                # Burn a metric scale bar into the lower-left corner so the
                # exported HD satellite image is self-describing.
                try:
                    sat_bytes = _burn_scale_bar(sat_bytes, sat_meta)
                except Exception:
                    pass  # Scale bar is decorative; never block the export.
                sat_file = f"google_satellite_{sanitize_name(location_tag)}.png"
                (session_dir / sat_file).write_bytes(sat_bytes)
                relative_path = str(Path(session_dir_name) / sat_file)
                image_exports.append({
                    "layer_id": "_google_satellite",
                    "layer_name": "Google Satellite",
                    "filename": sat_file,
                    "relative_path": relative_path,
                    "url": image_url_for(relative_path),
                    "format": "png",
                    "mime_type": "image/png",
                    "meta": sat_meta,
                })
        except Exception as exc:
            render_errors.append({
                "layer_id": "_google_satellite",
                "name": "Google Satellite",
                "error": str(exc),
            })

    if not image_exports:
        raise HTTPException(
            status_code=400,
            detail=f"No images were generated. Errors: {render_errors[:3]}",
        )

    ring = [
        [wgs_bounds[0], wgs_bounds[1]],
        [wgs_bounds[2], wgs_bounds[1]],
        [wgs_bounds[2], wgs_bounds[3]],
        [wgs_bounds[0], wgs_bounds[3]],
        [wgs_bounds[0], wgs_bounds[1]],
    ]
    feature_name = payload.name.strip() if payload.name else f"Area images {location_tag}"
    feature_description = (
        payload.description.strip()
        if payload.description is not None and payload.description.strip() != ""
        else "Rectangle capture with extracted images saved to disk and referenced in database."
    )
    feature_category = payload.category.strip() if payload.category else "area_images"
    metadata = {
        "source": "area_images",
        "image_count": len(image_exports),
        "format": payload.format,
        "extent_3857": payload.extent_3857,
        "image_root": str(IMAGE_ROOT),
        "image_session_dir": session_dir_name,
        "errors": render_errors,
    }
    if payload.tags:
        cleaned = normalize_tags(payload.tags)
        if cleaned:
            metadata["tags"] = cleaned
    plot_data = {
        "image_exports": image_exports,
        "extent_3857": payload.extent_3857,
        "location_tag": location_tag,
        "image_session_dir": session_dir_name,
        # Persist the exact layer list + render options used for this export so
        # the "Update" action can re-render with the *same* visualization
        # parameters later, without depending on what's currently on the map.
        "layer_specs": [layer.model_dump() for layer in payload.layers],
        "render_options": {
            "format": payload.format,
            "include_google_satellite": payload.include_google_satellite,
            "google_satellite_max_width_px": payload.google_satellite_max_width_px,
        },
    }
    geometry_dict = {"type": "Polygon", "coordinates": [ring]}
    feature_key = compute_feature_key(geometry_dict, metadata)

    with db_connect() as conn:
        row = upsert_feature(
            conn,
            name=feature_name,
            description=feature_description,
            category=feature_category,
            geometry_dict=geometry_dict,
            feature_key=feature_key,
            metadata_json=json.dumps(metadata),
            plot_data_json=json.dumps(plot_data),
        )
        conn.commit()
    return {"feature": row_to_feature(row)}


@router.delete("/saved-features/{feature_id}")
async def delete_saved_feature(feature_id: int) -> Dict[str, Any]:
    with db_connect() as conn:
        row = conn.execute(
            "SELECT plot_data_json FROM saved_features WHERE id = ?",
            (feature_id,),
        ).fetchone()
        cursor = conn.execute("DELETE FROM saved_features WHERE id = ?", (feature_id,))
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Saved feature not found")
    if row and row["plot_data_json"]:
        try:
            plot_data = json.loads(row["plot_data_json"])
            if isinstance(plot_data, dict):
                for item in existing_image_exports(plot_data):
                    unlink_export_file(item.get("relative_path"))
                session_dir = plot_data.get("image_session_dir")
                if isinstance(session_dir, str):
                    session_path = (IMAGE_ROOT / session_dir).resolve()
                    if (
                        IMAGE_ROOT.resolve() in session_path.parents
                        and session_path.is_dir()
                        and not any(session_path.iterdir())
                    ):
                        session_path.rmdir()
        except Exception:
            pass
    return {"success": True}


@router.patch("/saved-features/{feature_id}")
async def update_saved_feature(
    feature_id: int, payload: SavedFeatureUpdateRequest,
) -> Dict[str, Any]:
    updates: List[str] = []
    params: List[Any] = []

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Feature name is required")
        updates.append("name = ?")
        params.append(name)

    if payload.description is not None:
        description = payload.description.strip() or None
        updates.append("description = ?")
        params.append(description)

    if payload.tags is not None:
        clean_tags = normalize_tags(payload.tags)

        with db_connect() as conn:
            row = conn.execute(
                "SELECT metadata_json FROM saved_features WHERE id = ?",
                (feature_id,),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Saved feature not found")
            metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
            if not isinstance(metadata, dict):
                metadata = {}
            metadata["tags"] = clean_tags
            updates.append("metadata_json = ?")
            params.append(json.dumps(metadata))

    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")

    params.append(feature_id)
    with db_connect() as conn:
        cursor = conn.execute(
            f"UPDATE saved_features SET {', '.join(updates)} WHERE id = ?",
            tuple(params),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Saved feature not found")
        row = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features WHERE id = ?",
            (feature_id,),
        ).fetchone()
        conn.commit()

    if row is None:
        raise HTTPException(status_code=500, detail="Failed to load updated feature")
    return {"feature": row_to_feature(row)}


@router.post("/saved-features/{feature_id}/refresh-area-images")
async def refresh_saved_feature_area_images(
    feature_id: int,
    payload: Optional[RefreshAreaImagesRequest] = None,
) -> Dict[str, Any]:
    """Re-render every image attached to a saved area_images polygon feature.

    Reproduces the *original* export: the layer list, format, and extent are
    read from the feature's stored plot_data (persisted at save time by
    `create_area_images_feature`), so the refreshed images use the same
    visualization parameters they were originally created with — independent
    of whatever is currently on the map. The request body is optional and only
    used to override individual fields.
    """
    payload = payload or RefreshAreaImagesRequest()

    with db_connect() as conn:
        row = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features WHERE id = ?",
            (feature_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Saved feature not found")
    if row["geometry_type"] != "Polygon":
        raise HTTPException(
            status_code=400,
            detail="Area-image refresh is only supported for Polygon features",
        )

    metadata_payload: Dict[str, Any] = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
    if not isinstance(metadata_payload, dict):
        metadata_payload = {}
    plot_data_payload: Dict[str, Any] = json.loads(row["plot_data_json"]) if row["plot_data_json"] else {}
    if not isinstance(plot_data_payload, dict):
        plot_data_payload = {}

    # Resolve the layer list: caller override > stored layer_specs. Features
    # saved before layer specs were persisted have neither — point the user at
    # a re-save rather than silently rendering nothing.
    stored_specs = plot_data_payload.get("layer_specs")
    layer_source = payload.layers if payload.layers else stored_specs
    if not isinstance(layer_source, list) or len(layer_source) == 0:
        raise HTTPException(
            status_code=400,
            detail=(
                "This feature has no stored layer parameters (it was saved "
                "before they were persisted). Re-save the area to enable "
                "in-place updates."
            ),
        )
    try:
        resolved_layers = [
            spec if isinstance(spec, FigureLayerSpec) else FigureLayerSpec(**spec)
            for spec in layer_source
        ]
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Stored layer specs are invalid: {exc}",
        )

    # Render options: caller override > stored render_options > defaults.
    stored_opts = plot_data_payload.get("render_options")
    if not isinstance(stored_opts, dict):
        stored_opts = {}
    resolved_format = (
        payload.format
        or stored_opts.get("format")
        or metadata_payload.get("format")
        or "png"
    )
    resolved_include_sat = (
        payload.include_google_satellite
        if payload.include_google_satellite is not None
        else bool(stored_opts.get("include_google_satellite", False))
    )
    resolved_sat_width = int(
        payload.google_satellite_max_width_px
        if payload.google_satellite_max_width_px is not None
        else stored_opts.get("google_satellite_max_width_px", 4096)
    )

    # Prefer the caller-supplied extent (rare), then the feature's saved
    # extent_3857 (the common case for area_images), then bail.
    extent_source = payload.extent_3857 or plot_data_payload.get("extent_3857") or metadata_payload.get("extent_3857")
    if not isinstance(extent_source, list) or len(extent_source) != 4:
        raise HTTPException(
            status_code=400,
            detail="Saved feature has no extent_3857; cannot refresh area images.",
        )
    try:
        extent_3857 = [float(v) for v in extent_source]
    except Exception:
        raise HTTPException(status_code=400, detail="Saved feature has invalid extent_3857.")

    # Optionally crop to a square on the shortest side, centred on the original
    # extent. Done in EPSG:3857 (projected metres) so the square is true on the
    # ground, not just in lon/lat degrees. The geometry is rewritten further
    # below so the saved polygon matches the imagery.
    geometry_changed = False
    if payload.square:
        x0, y0, x1, y1 = extent_3857
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        side = min(abs(x1 - x0), abs(y1 - y0))
        if side <= 0:
            raise HTTPException(
                status_code=400,
                detail="Cannot square a degenerate extent (zero-width or zero-height).",
            )
        half = side / 2.0
        squared = [cx - half, cy - half, cx + half, cy + half]
        if squared != extent_3857:
            extent_3857 = squared
            geometry_changed = True

    xmin, ymin, xmax, ymax = extent_3857
    wgs_bounds = transform_bounds("EPSG:3857", "EPSG:4326", xmin, ymin, xmax, ymax)
    center_lon = (wgs_bounds[0] + wgs_bounds[2]) / 2
    center_lat = (wgs_bounds[1] + wgs_bounds[3]) / 2
    location_tag = f"{center_lat:.4f}_{center_lon:.4f}".replace("-", "m")

    # Drop previously-rendered files so we don't accumulate orphans when the
    # new layer set produces a different filename. The session dir itself is
    # freshly allocated below for a clean slate.
    for item in existing_image_exports(plot_data_payload):
        unlink_export_file(item.get("relative_path"))
    old_session = plot_data_payload.get("image_session_dir")
    if isinstance(old_session, str):
        try:
            old_path = (IMAGE_ROOT / old_session).resolve()
            if (
                IMAGE_ROOT.resolve() in old_path.parents
                and old_path.is_dir()
                and not any(old_path.iterdir())
            ):
                old_path.rmdir()
        except Exception:
            pass

    session_dir, session_dir_name = new_session_dir()
    render_payload = SaveAreaImagesRequest(
        extent_3857=extent_3857,
        format=resolved_format,
        layers=resolved_layers,
        include_google_satellite=resolved_include_sat,
        google_satellite_max_width_px=resolved_sat_width,
    )
    image_exports, render_errors = render_area_images(
        render_payload, session_dir, session_dir_name, location_tag,
    )

    if resolved_include_sat:
        try:
            sat_bytes, sat_meta = _stitch_bbox_satellite(
                float(wgs_bounds[0]),
                float(wgs_bounds[2]),
                float(wgs_bounds[1]),
                float(wgs_bounds[3]),
                buffer_m=0.0,
                max_width_px=int(resolved_sat_width),
            )
            if sat_bytes is None:
                render_errors.append({
                    "layer_id": "_google_satellite",
                    "name": "Google Satellite",
                    "error": "Tile fetch failed (no provider returned imagery)",
                })
            else:
                try:
                    sat_bytes = _burn_scale_bar(sat_bytes, sat_meta)
                except Exception:
                    pass
                sat_file = f"google_satellite_{sanitize_name(location_tag)}.png"
                (session_dir / sat_file).write_bytes(sat_bytes)
                relative_path = str(Path(session_dir_name) / sat_file)
                image_exports.append({
                    "layer_id": "_google_satellite",
                    "layer_name": "Google Satellite",
                    "filename": sat_file,
                    "relative_path": relative_path,
                    "url": image_url_for(relative_path),
                    "format": "png",
                    "mime_type": "image/png",
                    "meta": sat_meta,
                })
        except Exception as exc:
            render_errors.append({
                "layer_id": "_google_satellite",
                "name": "Google Satellite",
                "error": str(exc),
            })

    if not image_exports:
        raise HTTPException(
            status_code=400,
            detail=f"No images were generated. Errors: {render_errors[:3]}",
        )

    plot_data_payload["image_exports"] = image_exports
    plot_data_payload["extent_3857"] = extent_3857
    plot_data_payload["location_tag"] = location_tag
    plot_data_payload["image_session_dir"] = session_dir_name
    # Keep the stored specs in sync so a later refresh reproduces *this*
    # render (matters when the caller passed override layers/options).
    plot_data_payload["layer_specs"] = [layer.model_dump() for layer in resolved_layers]
    plot_data_payload["render_options"] = {
        "format": resolved_format,
        "include_google_satellite": resolved_include_sat,
        "google_satellite_max_width_px": resolved_sat_width,
    }
    metadata_payload["source"] = metadata_payload.get("source") or "area_images"
    metadata_payload["image_count"] = len(image_exports)
    metadata_payload["format"] = resolved_format
    metadata_payload["extent_3857"] = extent_3857
    metadata_payload["image_root"] = str(IMAGE_ROOT)
    metadata_payload["image_session_dir"] = session_dir_name
    metadata_payload["errors"] = render_errors

    with db_connect() as conn:
        if geometry_changed:
            # Rewrite the polygon to the squared bbox so the saved geometry
            # matches the new imagery. Re-derive the identity hashes that are
            # functions of geometry (geom_uid / feature_uid) — feature_key is
            # left as-is so the row keeps its upsert identity.
            ring = [
                [wgs_bounds[0], wgs_bounds[1]],
                [wgs_bounds[2], wgs_bounds[1]],
                [wgs_bounds[2], wgs_bounds[3]],
                [wgs_bounds[0], wgs_bounds[3]],
                [wgs_bounds[0], wgs_bounds[1]],
            ]
            new_geometry = {"type": "Polygon", "coordinates": [ring]}
            new_geom_uid = compute_geom_uid(new_geometry)
            new_feature_uid = compute_feature_uid(
                new_geometry, row["name"], row["category"],
            )
            conn.execute(
                "UPDATE saved_features "
                "SET metadata_json = ?, plot_data_json = ?, geometry_json = ?, "
                "    geom_uid = ?, feature_uid = ? "
                "WHERE id = ?",
                (
                    json.dumps(metadata_payload),
                    json.dumps(plot_data_payload),
                    json.dumps(new_geometry["coordinates"]),
                    new_geom_uid,
                    new_feature_uid,
                    feature_id,
                ),
            )
        else:
            conn.execute(
                "UPDATE saved_features SET metadata_json = ?, plot_data_json = ? WHERE id = ?",
                (
                    json.dumps(metadata_payload),
                    json.dumps(plot_data_payload),
                    feature_id,
                ),
            )
        conn.commit()
        updated_row = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features WHERE id = ?",
            (feature_id,),
        ).fetchone()

    if updated_row is None:
        raise HTTPException(status_code=500, detail="Failed to load refreshed feature")
    return {"feature": row_to_feature(updated_row), "errors": render_errors}


@router.post("/saved-features/{feature_id}/refresh-prediction-snapshot")
async def refresh_saved_feature_prediction_snapshot(
    feature_id: int,
    payload: Optional[RefreshPredictionSnapshotRequest] = None,
) -> Dict[str, Any]:
    """Re-generate the RH98 prediction snapshot for a saved Point feature.

    Useful when the snapshot rendering logic, MGRS tile resolution, or the
    user's chosen rescale/colormap has changed since the feature was saved —
    `View plots` will then show a fresh snapshot without having to delete and
    re-save the feature. Only Points are supported (transects already render
    their own per-sample snapshots through a different flow).
    """
    payload = payload or RefreshPredictionSnapshotRequest()

    with db_connect() as conn:
        row = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features WHERE id = ?",
            (feature_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Saved feature not found")
    if row["geometry_type"] != "Point":
        raise HTTPException(
            status_code=400,
            detail="Prediction snapshot refresh is only supported for Point features",
        )

    try:
        coordinates = json.loads(row["geometry_json"])
        lon, lat = float(coordinates[0]), float(coordinates[1])
    except Exception:
        raise HTTPException(status_code=400, detail="Saved feature has invalid Point coordinates")

    metadata_payload: Dict[str, Any] = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
    if not isinstance(metadata_payload, dict):
        metadata_payload = {}
    plot_data_payload: Dict[str, Any] = json.loads(row["plot_data_json"]) if row["plot_data_json"] else {}
    if not isinstance(plot_data_payload, dict):
        plot_data_payload = {}

    # Resolve year / q_index / version: caller override > stored metadata > default.
    # Stored metadata may use the new "version" key or the legacy
    # "prediction_source" key. NOT "source": that is the origin discriminator
    # ("feature_popup" / "area_images") and would poison the prediction path.
    pred_year = int(payload.year) if payload.year is not None else int(metadata_payload.get("year") or 2020)
    pred_q_index = int(payload.q_index) if payload.q_index is not None else int(metadata_payload.get("q_index") or 1)
    pred_version = (
        (
            payload.version
            or metadata_payload.get("version")
            or metadata_payload.get("prediction_source")
            or "original"
        )
        .strip()
        .lower()
        or "original"
    )
    tile_name = _resolve_prediction_tile_name(metadata_payload, lat, lon)

    # Visualization: caller override > stored prediction_visualization > snapshot defaults.
    stored_vis = metadata_payload.get("prediction_visualization") or {}
    if not isinstance(stored_vis, dict):
        stored_vis = {}

    def _pick_float(override: Optional[float], stored_key: str) -> Optional[float]:
        if override is not None and np.isfinite(float(override)):
            return float(override)
        stored = stored_vis.get(stored_key)
        if isinstance(stored, (int, float)) and np.isfinite(float(stored)):
            return float(stored)
        return None

    rescale_min = _pick_float(payload.rescale_min, "rescale_min")
    rescale_max = _pick_float(payload.rescale_max, "rescale_max")
    colormap_override = (
        payload.colormap
        if isinstance(payload.colormap, str) and payload.colormap.strip()
        else None
    )
    colormap = colormap_override or (
        str(stored_vis.get("colormap")).strip()
        if isinstance(stored_vis.get("colormap"), str)
        else None
    )

    # Best-effort cleanup of the previous snapshot file so we don't accumulate
    # orphaned PNGs in the image root.
    prev_pred_layer_id = f"prediction_rh98_q{pred_q_index}"
    exports = existing_image_exports(plot_data_payload)
    for item in exports:
        if item.get("layer_id") == prev_pred_layer_id:
            unlink_export_file(item.get("relative_path"))
            break

    pred_snapshot, pred_error = _extract_prediction_rh98_snapshot(
        lon, lat,
        year=pred_year, version=pred_version, q_index=pred_q_index,
        tile_name=str(tile_name) if tile_name else None,
        buffer_m=75.0,
        rescale_min=rescale_min,
        rescale_max=rescale_max,
        colormap=colormap,
    )

    if pred_snapshot:
        upsert_image_export(plot_data_payload, pred_snapshot)
        metadata_payload["prediction_snapshot_status"] = "ok"
        metadata_payload["prediction_snapshot"] = {
            "rh": 98,
            "q_index": pred_q_index,
            "year": pred_year,
            "version": pred_version,
        }
        # Echo the visualization actually used so the saved metadata reflects
        # the current render (useful when the user later wants to compare or
        # re-render with the same settings).
        metadata_payload["prediction_visualization"] = {
            "rescale_min": pred_snapshot.get("rescale_min"),
            "rescale_max": pred_snapshot.get("rescale_max"),
            "colormap": pred_snapshot.get("colormap"),
        }
        metadata_payload.pop("prediction_snapshot_error", None)
        metadata_payload.pop("prediction_snapshot_debug", None)
    else:
        metadata_payload["prediction_snapshot_status"] = "unavailable"
        if pred_error:
            metadata_payload["prediction_snapshot_error"] = pred_error[:300]
        metadata_payload["prediction_snapshot_debug"] = {
            "tile_name": tile_name,
            "year": pred_year,
            "q_index": pred_q_index,
            "version": pred_version,
        }

    with db_connect() as conn:
        conn.execute(
            "UPDATE saved_features SET metadata_json = ?, plot_data_json = ? WHERE id = ?",
            (
                json.dumps(metadata_payload) if metadata_payload else None,
                json.dumps(plot_data_payload) if plot_data_payload else None,
                feature_id,
            ),
        )
        conn.commit()
        updated_row = conn.execute(
            f"SELECT {FEATURE_COLUMNS} FROM saved_features WHERE id = ?",
            (feature_id,),
        ).fetchone()

    if updated_row is None:
        raise HTTPException(status_code=500, detail="Failed to load refreshed feature")

    return {
        "feature": row_to_feature(updated_row),
        "snapshot_status": metadata_payload.get("prediction_snapshot_status"),
        "snapshot_error": metadata_payload.get("prediction_snapshot_error"),
    }


# ---------------------------------------------------------------------------
# Transect endpoints
# ---------------------------------------------------------------------------

@router.post("/transect/satellite-snapshot")
async def transect_satellite_snapshot(req: TransectSatelliteRequest):
    """Return a stitched satellite PNG for a transect bounding box with buffer.

    Tile fetching is parallelised; typical transects (8-16 tiles) complete in
    under two seconds vs. the OL-canvas approach which can block the browser for
    tens of seconds.
    """
    loop = asyncio.get_event_loop()
    image_bytes, meta = await loop.run_in_executor(
        None,
        lambda: _stitch_bbox_satellite(
            req.min_lon, req.max_lon, req.min_lat, req.max_lat,
            req.buffer_m, req.max_width_px,
        ),
    )
    if image_bytes is None:
        raise HTTPException(
            status_code=503,
            detail="Satellite imagery fetch failed from all providers",
        )
    return Response(
        content=image_bytes,
        media_type="image/png",
        headers={
            "X-Image-Min-Lon": f"{meta['min_lon']:.7f}",
            "X-Image-Max-Lon": f"{meta['max_lon']:.7f}",
            "X-Image-Min-Lat": f"{meta['min_lat']:.7f}",
            "X-Image-Max-Lat": f"{meta['max_lat']:.7f}",
            "X-Image-Zoom": str(meta["zoom"]),
            "X-Image-Width": str(meta["width_px"]),
            "X-Image-Height": str(meta["height_px"]),
        },
    )


@router.post("/transect/figure")
async def transect_figure(req: TransectFigureRequest):
    """Render the full transect figure (map + heatmap + metrics) as one image.

    All panels share the same x-axis (longitude or latitude) by construction
    via matplotlib's `sharex=True`, so longitudes line up exactly without any
    margin gymnastics on the frontend.
    """
    loop = asyncio.get_event_loop()
    payload, media_type = await loop.run_in_executor(
        None, lambda: _render_transect_figure(req),
    )
    suffix = {"image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf"}.get(media_type, "bin")
    return Response(
        content=payload,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="transect-figure.{suffix}"'},
    )


@router.post("/vertical-profile/figure")
async def vertical_profile_figure(req: VerticalProfileFigureRequest):
    """Render the derived vertical-profile curve as a single matplotlib image.

    Same preview(dpi=90) / export(dpi=150) split as `/transect/figure`; width
    is pixel-exact via the two-pass savefig in `_render_vertical_profile_figure`.
    """
    loop = asyncio.get_event_loop()
    payload, media_type = await loop.run_in_executor(
        None, lambda: _render_vertical_profile_figure(req),
    )
    suffix = {"image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf"}.get(media_type, "bin")
    return Response(
        content=payload,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="vertical-profile.{suffix}"'},
    )


# ---------------------------------------------------------------------------
# Image serving
# ---------------------------------------------------------------------------

@router.get("/saved-features/image/{relative_path:path}")
async def get_saved_feature_image(relative_path: str):
    if not relative_path or relative_path.strip() == "":
        raise HTTPException(status_code=400, detail="Image path is required")
    candidate = (IMAGE_ROOT / relative_path).resolve()
    root = IMAGE_ROOT.resolve()
    if root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Invalid image path")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    suffix = candidate.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        media_type = "image/jpeg"
    elif suffix == ".pdf":
        media_type = "application/pdf"
    else:
        media_type = "image/png"
    return FileResponse(candidate, media_type=media_type)
