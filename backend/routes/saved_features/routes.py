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
    db_connect,
    row_to_feature,
    upsert_feature,
    validate_geometry,
)
from .models import (
    RefreshPredictionSnapshotRequest,
    SaveAreaImagesRequest,
    SavedFeatureCreateRequest,
    SavedFeatureUpdateRequest,
    TransectFigureRequest,
    TransectSatelliteRequest,
)
from .point_snapshots import (
    _extract_google_point_snapshot,
    _extract_prediction_rh98_snapshot,
    _extract_sentinel2_point_snapshots,
    _resolve_prediction_tile_name,
)
from .satellite import _burn_scale_bar, _stitch_bbox_satellite
from .transect_figure import _render_transect_figure
from .utils import (
    existing_image_exports,
    image_url_for,
    new_session_dir,
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

    # For saved popup points, attempt 75 m exports (satellite + RH98 + Sentinel-2).
    if geometry_dict["type"] == "Point" and metadata_payload.get("source") == "feature_popup":
        _attach_feature_popup_snapshots(geometry_dict, metadata_payload, plot_data_payload)

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
        pred_source = (
            str(metadata_payload.get("prediction_source") or "blended").strip().lower()
            or "blended"
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
            year=pred_year, source=pred_source, q_index=pred_q_index,
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
                "source": pred_source,
            }
        else:
            metadata_payload["prediction_snapshot_status"] = "unavailable"
            if pred_error:
                metadata_payload["prediction_snapshot_error"] = pred_error[:300]
            metadata_payload["prediction_snapshot_debug"] = {
                "tile_name": tile_name,
                "year": pred_year,
                "q_index": pred_q_index,
                "source": pred_source,
            }

        # ---- Sentinel-2 ----
        sentinel_layers = metadata_payload.get("sentinel2_layers")
        if isinstance(sentinel_layers, list) and len(sentinel_layers) > 0:
            sentinel_exports, sentinel_errors = _extract_sentinel2_point_snapshots(
                lon, lat,
                [layer for layer in sentinel_layers if isinstance(layer, dict)],
                buffer_m=75.0,
            )
            for export in sentinel_exports:
                upsert_image_export(plot_data_payload, export)
            metadata_payload["sentinel2_snapshot_status"] = (
                "ok" if sentinel_exports else "unavailable"
            )
            metadata_payload["sentinel2_snapshot_count"] = len(sentinel_exports)
            if sentinel_errors:
                metadata_payload["sentinel2_snapshot_errors"] = sentinel_errors[:5]
        else:
            metadata_payload["sentinel2_snapshot_status"] = "unavailable"
            metadata_payload["sentinel2_snapshot_count"] = 0
    except Exception:
        metadata_payload["satellite_snapshot_status"] = "unavailable"
        metadata_payload["satellite_snapshot_error"] = "snapshot_generation_exception"
        metadata_payload["prediction_snapshot_status"] = "unavailable"
        metadata_payload["prediction_snapshot_error"] = "prediction_snapshot_generation_exception"


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
    plot_data = {
        "image_exports": image_exports,
        "extent_3857": payload.extent_3857,
        "location_tag": location_tag,
        "image_session_dir": session_dir_name,
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
        clean_tags: List[str] = []
        for tag in payload.tags:
            t = str(tag).strip()
            if t:
                clean_tags.append(t[:60])
        clean_tags = list(dict.fromkeys(clean_tags))[:30]

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

    # Resolve year / q_index / source: caller override > stored metadata > default.
    pred_year = int(payload.year) if payload.year is not None else int(metadata_payload.get("year") or 2020)
    pred_q_index = int(payload.q_index) if payload.q_index is not None else int(metadata_payload.get("q_index") or 1)
    pred_source = (
        (payload.source or metadata_payload.get("prediction_source") or "blended")
        .strip()
        .lower()
        or "blended"
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
        year=pred_year, source=pred_source, q_index=pred_q_index,
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
            "source": pred_source,
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
            "source": pred_source,
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
    media_type = (
        "image/jpeg" if candidate.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    )
    return FileResponse(candidate, media_type=media_type)
