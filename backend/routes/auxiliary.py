"""Auxiliary data endpoints: distance map, CR, profile entropy, ALS, GEDI."""

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field
from typing import List, Optional, Literal
from pathlib import Path
import asyncio
import json
import os
import subprocess
import tempfile
import traceback
import numpy as np
import math
import re

import geopandas as gpd
import pandas as pd
import pyarrow.parquet as pq
from fastapi import HTTPException
from shapely import wkb, wkt
import rasterio
from rasterio.windows import from_bounds
from rasterio.windows import Window
from rasterio.warp import transform_bounds

import utils
from utils import (
    MAX_HEIGHT_METERS,
    create_vrt,
    profile_curve_points,
    profile_y_bounds,
    pixel_diversity_indices,
)

try:
    import duckdb
except Exception:
    duckdb = None

router = APIRouter(prefix="/auxiliary", tags=["auxiliary"])

# ---------------------------------------------------------------------------
# Env vars
# ---------------------------------------------------------------------------

# Unified prediction path template (full absolute path with {version}, {tile}, {rh}, {q}).
# Auxiliary needs it to build VRT inputs for entropy computation per-tile.
PREDICTIONS_LOCAL_PATH = os.environ.get("PREDICTIONS_LOCAL_PATH", "")
PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE = os.environ.get(
    "PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE", "{tile}_Q{q}.vrt"
)
DISTANCE_MAPS_LOCAL_BASE_PATH = os.environ.get("DISTANCE_MAPS_LOCAL_BASE_PATH", "")
CR_LOCAL_BASE_PATH = os.environ.get("CR_LOCAL_BASE_PATH", "")
# Diversity-indices template: contains {year} and {version} placeholders; the
# substituted result is the parent directory holding geotiff/ and cog/ subdirs.
DIVERSITY_INDICES_LOCAL_PATH = os.environ.get("DIVERSITY_INDICES_LOCAL_PATH", "")
# Full path template for ALS COGs (contains {tile} placeholder).
ALS_LOCAL_PATH = os.environ.get("ALS_LOCAL_PATH", "")
# Full path template for LVIS COGs (contains {tile} placeholder).
LVIS_LOCAL_PATH = os.environ.get("LVIS_LOCAL_PATH", "")
GEDI_LOCAL_BASE_PATH = os.environ.get("GEDI_LOCAL_BASE_PATH", "")

# Allowed values for the prediction `version` parameter (matches predictions.py).
VersionLiteral = Literal["original", "blended", "masked"]

# ---------------------------------------------------------------------------
# Computation helpers
# ---------------------------------------------------------------------------


async def _compute_cr(tile_id: str, year: int, version: str = "original") -> Path:
    if not PREDICTIONS_LOCAL_PATH:
        raise HTTPException(status_code=500, detail="PREDICTIONS_LOCAL_PATH env var is not set.")
    path_a = Path(PREDICTIONS_LOCAL_PATH.format(tile=tile_id, rh=98, q=1, version=version, year=year))
    path_b = Path(PREDICTIONS_LOCAL_PATH.format(tile=tile_id, rh=25, q=1, version=version, year=year))
    path_cr = Path(f"{CR_LOCAL_BASE_PATH}/{year}/tiles/geotiff/{tile_id}.tif")
    path_cr_cog = Path(f"{CR_LOCAL_BASE_PATH}/{year}/tiles/cog/{tile_id}.tif")

    if not path_a.exists() or not path_b.exists():
        raise HTTPException(status_code=404, detail=f"Source tiles not found for {tile_id}")

    path_cr.parent.mkdir(parents=True, exist_ok=True)
    path_cr_cog.parent.mkdir(parents=True, exist_ok=True)

    calc_cmd = [
        "gdal_calc.py", "-A", str(path_a), "-B", str(path_b),
        "--outfile", str(path_cr),
        "--calc=numpy.where((A==32767)|(B==32767)|(A==0), -9999, (A-B)/A.astype(float))",
        "--NoDataValue=-9999", "--type", "Float32", "--overwrite",
    ]
    translate_cmd = [
        "gdal_translate", str(path_cr), str(path_cr_cog),
        "-of", "COG",
        "-a_nodata", "-9999",  # Ensure the nodata tag survives the COG conversion.
        "-co", "COMPRESS=DEFLATE", "-co", "OVERVIEW_RESAMPLING=AVERAGE",
    ]

    loop = asyncio.get_event_loop()
    for cmd in [calc_cmd, translate_cmd]:
        result = await loop.run_in_executor(None, lambda c=cmd: subprocess.run(c, capture_output=True, text=True))
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr)

    path_cr.unlink(missing_ok=True)
    return path_cr_cog


async def _compute_entropy(tile_id: str, year: int, version: str = "original"):
    if not DIVERSITY_INDICES_LOCAL_PATH:
        raise HTTPException(status_code=500, detail="DIVERSITY_INDICES_LOCAL_PATH env var is not set.")
    # DIVERSITY_INDICES_LOCAL_PATH points to the parent dir (.../{year}/{version}/tiles/);
    # geotiff/ and cog/ live underneath it.
    output_dir = Path(DIVERSITY_INDICES_LOCAL_PATH.format(year=year, version=version))
    output_gtiff_path = output_dir / "geotiff" / f"{tile_id}.tif"
    output_cog_path = output_dir / "cog" / f"{tile_id}.tif"
    if output_cog_path.exists():
        return output_cog_path
    output_gtiff_path.parent.mkdir(parents=True, exist_ok=True)
    output_cog_path.parent.mkdir(parents=True, exist_ok=True)

    if not output_gtiff_path.exists():
        # Use the versioned VRT built from PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE so
        # entropy is computed against the requested version's bands.
        vrt_path: Optional[str] = None
        if PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE:
            try:
                vrt_path = PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE.format(
                    tile=tile_id, q=1, year=year, version=version,
                )
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Invalid PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE: {e}")

        # The VRT is a build artifact; create it on demand from the per-tile
        # COG directory (e.g. .../{version}/tiles/cog/{tile}/RH*_Q1.tif) if it
        # doesn't already exist. Without this, the `masked` version — which
        # ships COGs but no pre-built VRT — fails with "No such file".
        if vrt_path and not Path(vrt_path).expanduser().exists():
            if not PREDICTIONS_LOCAL_PATH:
                raise HTTPException(
                    status_code=500,
                    detail=f"VRT not found and PREDICTIONS_LOCAL_PATH is unset: {vrt_path}",
                )
            try:
                tile_dir = Path(
                    PREDICTIONS_LOCAL_PATH.format(version=version, tile=tile_id, rh=98, q=1, year=year)
                ).parent
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Invalid PREDICTIONS_LOCAL_PATH: {e}")
            if not tile_dir.is_dir():
                raise HTTPException(
                    status_code=404,
                    detail=f"Prediction tile directory not found: {tile_dir}",
                )
            try:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    lambda: utils.create_vrt(str(tile_dir), vrt_path, q_idx="1"),
                )
            except AssertionError as e:
                # create_vrt asserts on file count (expects 100 RH bands).
                raise HTTPException(
                    status_code=500,
                    detail=f"Cannot build VRT for {tile_id} ({version}): {e}",
                )

        utils.compute_entropy(
            output_path=output_gtiff_path,
            tile_id=tile_id,
            year=year,
            vrt_path=vrt_path,
        )

    translate_cmd = [
        "gdal_translate", str(output_gtiff_path), str(output_cog_path),
        "-of", "COG",
        "-a_nodata", "-9999",  # Ensure the nodata tag survives the COG conversion.
        "-co", "COMPRESS=ZSTD", "-co", "OVERVIEW_RESAMPLING=AVERAGE",
    ]
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: subprocess.run(translate_cmd, capture_output=True, text=True))
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)

    output_gtiff_path.unlink(missing_ok=True)
    return output_cog_path


# ---------------------------------------------------------------------------
# GEDI helpers
# ---------------------------------------------------------------------------

def _decode_geoparquet_geometry(value):
    if value is None or pd.isna(value):
        return None
    if isinstance(value, memoryview):
        value = value.tobytes()
    elif isinstance(value, bytearray):
        value = bytes(value)
    if isinstance(value, bytes):
        return wkb.loads(value)
    if isinstance(value, str):
        return wkt.loads(value)
    return value


def _get_geoparquet_crs(file_path: Path, geometry_column: str) -> Optional[str]:
    try:
        schema = pq.read_schema(file_path)
        metadata = schema.metadata or {}
        geo_blob = metadata.get(b"geo")
        if not geo_blob:
            return None
        geo_meta = json.loads(geo_blob.decode("utf-8"))
        crs_id = geo_meta.get("columns", {}).get(geometry_column, {}).get("crs", {}).get("id")
        if isinstance(crs_id, dict):
            authority, code = crs_id.get("authority"), crs_id.get("code")
            if authority and code:
                return f"{authority}:{code}"
        return None
    except Exception:
        return None


def _sample_gedi_geodataframe(tile_id: str, year: int, sample_size: int, seed: int):
    if not GEDI_LOCAL_BASE_PATH:
        raise ValueError("GEDI_LOCAL_BASE_PATH env var is not set.")

    parquet_path = Path(GEDI_LOCAL_BASE_PATH) / f"{year}/{tile_id}.parquet"
    if not parquet_path.is_file():
        raise FileNotFoundError(f"GEDI tile not found: {parquet_path}")

    con = None
    try:
        schema = pq.read_schema(parquet_path)
        metadata = schema.metadata or {}
        geo_blob = metadata.get(b"geo")
        geo_meta = json.loads(geo_blob.decode("utf-8")) if geo_blob else {}
        geometry_column = geo_meta.get("primary_column", "geometry")

        if geometry_column not in schema.names:
            raise ValueError(f"Geometry column '{geometry_column}' not found.")

        if duckdb is not None:
            con = duckdb.connect()
            total_count = int(con.execute("SELECT COUNT(*) FROM read_parquet(?)", [str(parquet_path)]).fetchone()[0])
            sampled_count = min(total_count, sample_size)
            if total_count == 0:
                df = pd.DataFrame(columns=[geometry_column])
            elif sampled_count >= total_count:
                df = con.execute("SELECT * FROM read_parquet(?)", [str(parquet_path)]).df()
            else:
                df = con.execute(f"SELECT * FROM read_parquet(?) USING SAMPLE reservoir({sampled_count} ROWS) REPEATABLE ({seed})", [str(parquet_path)]).df()
        else:
            gdf = gpd.read_parquet(parquet_path)
            total_count = len(gdf)
            sampled_count = min(total_count, sample_size)
            if sampled_count < total_count:
                gdf = gdf.sample(n=sampled_count, random_state=seed)

        if duckdb is not None:
            df = df.copy()
            df[geometry_column] = df[geometry_column].map(_decode_geoparquet_geometry)
            df = df[df[geometry_column].notnull()].copy()
            sampled_count = len(df)
            crs = _get_geoparquet_crs(parquet_path, geometry_column) or "EPSG:4326"
            attr_cols = [c for c in df.columns if c != geometry_column]
            attrs = df[attr_cols].reset_index(drop=True) if attr_cols else pd.DataFrame({"tile_name": [tile_id] * sampled_count})
            gdf = gpd.GeoDataFrame(attrs, geometry=df[geometry_column].values, crs=crs)

        gdf["tile_name"] = tile_id
        return gdf, total_count, len(gdf)
    finally:
        if con is not None:
            con.close()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class AuxiliaryTileRequest(BaseModel):
    tile_name: str

class AuxiliaryGEDIRequest(BaseModel):
    tile_name: str
    year: int
    sample_size: int = 5000
    seed: int = 42

class AuxiliaryCRRequest(BaseModel):
    tile_name: str
    year: int
    version: VersionLiteral = "original"

class AuxiliaryEntropyRequest(BaseModel):
    tile_name: str
    year: int
    metric: str = "entropy"
    version: VersionLiteral = "original"

class AuxiliaryDiversityIndicesRequest(BaseModel):
    tile_name: str
    year: int
    version: VersionLiteral = "original"

class AuxiliaryALSRequest(BaseModel):
    tile_name: str

class AuxiliaryLVISRequest(BaseModel):
    tile_name: str


class FigureBandSpec(BaseModel):
    band_index: int
    band_name: Optional[str] = None
    colormap: Optional[str] = None
    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None


class FigureLayerSpec(BaseModel):
    layer_id: str
    name: str
    layer_type: Optional[str] = None
    url: str
    rgb_bands: Optional[List[int]] = None
    colormap: Optional[str] = None
    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None
    bands: Optional[List[FigureBandSpec]] = None
    # Draw a colorbar on single-band (colormapped) renders. When False the image
    # is rendered edge-to-edge with no border / title. Default True keeps the
    # existing appearance for callers that don't send the field.
    include_colorbar: Optional[bool] = True


class SaveFiguresRequest(BaseModel):
    extent_3857: List[float]
    output_dir: str
    format: Literal["jpg", "png", "pdf"] = "png"
    layers: List[FigureLayerSpec]
    filename_stem: Optional[str] = Field(
        None,
        description="Optional base filename stem; auto layer+location naming when omitted.",
    )
    # Optional Google Satellite HD snapshot of the same drawing area. 8192 px
    # ≈ one extra zoom level vs. the transect figure's 4096 default, trading
    # bandwidth for sharper detail since saved exports are typically used at
    # full resolution.
    include_google_satellite: bool = False
    google_satellite_max_width_px: int =4096 # 8192
    # Burn a metric scale bar into the HD Google Satellite snapshot. Default
    # True keeps the existing self-describing PNG; UI lets users disable it.
    include_google_satellite_scale_bar: bool = True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/gedi")
async def load_gedi_points(request: AuxiliaryGEDIRequest):
    tile_id = request.tile_name
    year = request.year
    sample_size = max(1, min(int(request.sample_size), 10000))
    seed = int(request.seed)
    print(f"[auxiliary/gedi] tile={tile_id}, sample_size={sample_size}")

    try:
        gdf, total_count, sampled_count = _sample_gedi_geodataframe(tile_id, year,sample_size, seed)
        if sampled_count == 0:
            return Response(status_code=204, headers={"X-Tile-Name": tile_id, "X-Sampled-Count": "0", "X-Total-Count": str(total_count), "X-Sample-Size": str(sample_size)})

        with tempfile.NamedTemporaryFile(suffix=".fgb", delete=False) as tmp:
            temp_path = Path(tmp.name)
        try:
            gdf.to_file(temp_path, driver="FlatGeobuf")
            payload = temp_path.read_bytes()
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass

        return Response(content=payload, media_type="application/octet-stream", headers={
            "X-Tile-Name": tile_id, "X-Sampled-Count": str(sampled_count),
            "X-Total-Count": str(total_count), "X-Sample-Size": str(sample_size),
            "Content-Disposition": f'inline; filename="{tile_id}.fgb"',
        })
    except FileNotFoundError as e:
        return Response(content=json.dumps({"success": False, "error": str(e)}).encode(), media_type="application/json", status_code=404)
    except Exception as e:
        return Response(content=json.dumps({"success": False, "error": str(e)}).encode(), media_type="application/json", status_code=500)


@router.options("/gedi")
async def auxiliary_gedi_options():
    return {"message": "OK"}


class GEDIPointProfileRequest(BaseModel):
    rh_values: List[float]
    fhd_interval: int = 5


@router.post("/gedi/point-profile")
async def gedi_point_profile(request: GEDIPointProfileRequest):
    """Compute vertical profile and FHD from a GEDI point's RH0-RH100 values."""

    def _safe(v: float) -> float:
        return 0.0 if (math.isnan(v) or math.isinf(v)) else v

    rhs = request.rh_values
    if not rhs or len(rhs) < 3:
        return {"success": False, "error": "Need at least 3 RH values."}

    profile_y_min, profile_y_max = profile_y_bounds()
    try:
        # Smoothed envelope + raw binned energy %, trimmed to the real data
        # extent. The y-axis is fixed to [profile_y_min, profile_y_max]
        # client-side; the curve only spans real data.
        vp = profile_curve_points(rhs)
    except (TypeError, AttributeError, NameError):
        # Signature / programming mismatch (e.g. wrong kwargs) — fail loudly
        # instead of silently returning an empty profile.
        raise
    except Exception as e:
        vp = []
        print(
            f"[gedi/point-profile] profile_curve_points failed; profile omitted: "
            f"{e}\n{traceback.format_exc()}"
        )

    def _safe_scalar(v: float):
        return None if (math.isnan(v) or math.isinf(v)) else v

    try:
        raw_fhd, raw_enl1d, raw_enl2d, raw_cr = pixel_diversity_indices(
            rhs,
            bin_width=request.fhd_interval,
            max_height=MAX_HEIGHT_METERS,
        )
        fhd = _safe_scalar(float(raw_fhd))
        enl1d = _safe_scalar(float(raw_enl1d))
        enl2d = _safe_scalar(float(raw_enl2d))
        cr = _safe_scalar(float(raw_cr))
    except Exception as e:
        fhd, enl1d, enl2d, cr = None, None, None, None
        print(f"[gedi/point-profile] pixel_diversity_indices error: {e}")

    return {
        "success": True,
        "rh_curve": [{"rh": i, "value": _safe(float(v))} for i, v in enumerate(rhs)],
        "vertical_profile": vp,
        "profile_y_min": profile_y_min,
        "profile_y_max": profile_y_max,
        "fhd": fhd,
        "enl1d": enl1d,
        "enl2d": enl2d,
        "cr": cr,
        "fhd_interval": request.fhd_interval,
    }


@router.options("/gedi/point-profile")
async def auxiliary_gedi_point_profile_options():
    return {"message": "OK"}


@router.post("/distance-map")
async def load_distance_map(request: AuxiliaryTileRequest):
    if not DISTANCE_MAPS_LOCAL_BASE_PATH:
        return {"success": False, "error": "DISTANCE_MAPS_LOCAL_BASE_PATH env var is not set."}
    local_path = os.path.join(DISTANCE_MAPS_LOCAL_BASE_PATH, f"{request.tile_name}.tif")
    if os.path.isfile(local_path):
        return {"success": True, "url": local_path, "tile_name": request.tile_name, "layer_type": "distance_map"}
    return {"success": False, "error": f"Distance map not found: {local_path}"}


@router.options("/distance-map")
async def auxiliary_distance_map_options():
    return {"message": "OK"}


@router.post("/cr")
async def load_or_compute_cr(request: AuxiliaryCRRequest):
    if not CR_LOCAL_BASE_PATH:
        return {"success": False, "error": "CR_LOCAL_BASE_PATH env var is not set."}
    path_cr = Path(CR_LOCAL_BASE_PATH) / str(request.year) / "tiles" / "cog" / f"{request.tile_name}.tif"
    if path_cr.is_file():
        return {"success": True, "url": str(path_cr), "tile_name": request.tile_name, "layer_type": "cr"}
    try:
        path_out = await _compute_cr(request.tile_name, request.year, request.version)
        return {"success": True, "url": str(path_out), "tile_name": request.tile_name, "layer_type": "cr", "version": request.version}
    except HTTPException as exc:
        return {"success": False, "error": exc.detail if isinstance(exc.detail, str) else str(exc.detail)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.options("/cr")
async def auxiliary_cr_options():
    return {"message": "OK"}


@router.post("/profile-entropy")
async def load_or_compute_profile_entropy(request: AuxiliaryEntropyRequest):
    if not DIVERSITY_INDICES_LOCAL_PATH:
        return {"success": False, "error": "DIVERSITY_INDICES_LOCAL_PATH env var is not set."}
    metric = request.metric.strip().lower()
    if metric not in {"entropy", "enl1d", "enl2d"}:
        return {"success": False, "error": f"Invalid metric '{request.metric}'."}
    try:
        output_dir = Path(DIVERSITY_INDICES_LOCAL_PATH.format(year=request.year, version=request.version))
    except Exception as e:
        return {"success": False, "error": f"Invalid DIVERSITY_INDICES_LOCAL_PATH template: {e}"}
    path = output_dir / "cog" / f"{request.tile_name}_{metric}.tif"
    if path.is_file():
        return {"success": True, "url": str(path), "tile_name": request.tile_name, "layer_type": "profile_entropy", "metric": metric, "version": request.version}
    try:
        path_out = await _compute_entropy(request.tile_name, request.year, request.version)
        return {"success": True, "url": str(path_out), "tile_name": request.tile_name, "layer_type": "profile_entropy", "metric": metric, "version": request.version}
    except HTTPException as exc:
        return {"success": False, "error": exc.detail if isinstance(exc.detail, str) else str(exc.detail)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.options("/profile-entropy")
async def auxiliary_profile_entropy_options():
    return {"message": "OK"}


@router.post("/diversity-indices")
async def load_or_compute_diversity_indices(request: AuxiliaryDiversityIndicesRequest):
    """Return a 4-band COG (FHD, 1D-ENL, 2D-ENL, CR), computing it on the fly if needed."""
    if not DIVERSITY_INDICES_LOCAL_PATH:
        return {"success": False, "error": "DIVERSITY_INDICES_LOCAL_PATH env var is not set."}
    try:
        output_dir = Path(DIVERSITY_INDICES_LOCAL_PATH.format(year=request.year, version=request.version))
    except Exception as e:
        return {"success": False, "error": f"Invalid DIVERSITY_INDICES_LOCAL_PATH template: {e}"}
    cog_path = output_dir / "cog" / f"{request.tile_name}.tif"
    if cog_path.is_file():
        return {
            "success": True,
            "url": str(cog_path),
            "tile_name": request.tile_name,
            "layer_type": "diversity_indices",
            "bands": ["FHD", "1D ENL", "2D ENL", "CR"],
            "version": request.version,
        }
    try:
        path_out = await _compute_entropy(request.tile_name, request.year, request.version)
        return {
            "success": True,
            "url": str(path_out),
            "tile_name": request.tile_name,
            "layer_type": "diversity_indices",
            "bands": ["FHD", "1D ENL", "2D ENL", "CR"],
            "version": request.version,
        }
    except HTTPException as exc:
        return {"success": False, "error": exc.detail if isinstance(exc.detail, str) else str(exc.detail)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.options("/diversity-indices")
async def auxiliary_diversity_indices_options():
    return {"message": "OK"}


@router.post("/als")
async def load_als(request: AuxiliaryALSRequest):
    if not ALS_LOCAL_PATH:
        return {"success": False, "error": "ALS_LOCAL_PATH env var is not set."}
    try:
        candidate = Path(ALS_LOCAL_PATH.format(tile=request.tile_name))
        if candidate.is_file():
            return {"success": True, "url": str(candidate), "tile_name": request.tile_name, "layer_type": "als"}
    except Exception:
        pass
    return {"success": False, "error": f"ALS tile not found for {request.tile_name}."}


@router.options("/als")
async def auxiliary_als_options():
    return {"message": "OK"}


@router.post("/lvis")
async def load_lvis(request: AuxiliaryLVISRequest):
    if not LVIS_LOCAL_PATH:
        return {"success": False, "error": "LVIS_LOCAL_PATH env var is not set."}
    try:
        candidate = Path(LVIS_LOCAL_PATH.format(tile=request.tile_name))
        if candidate.is_file():
            return {"success": True, "url": str(candidate), "tile_name": request.tile_name, "layer_type": "lvis"}
    except Exception:
        pass
    return {"success": False, "error": f"LVIS tile not found for {request.tile_name}."}


@router.options("/lvis")
async def auxiliary_lvis_options():
    return {"message": "OK"}


@router.get("/list-dirs")
async def list_dirs(path: str = ""):
    """Return immediate sub-directories of *path* (or home if empty)."""
    base = Path(path) if path else Path.home()
    if not base.is_dir():
        return {"path": str(base), "dirs": [], "error": "Not a directory"}
    dirs: list[str] = []
    try:
        for entry in sorted(base.iterdir()):
            if entry.is_dir() and not entry.name.startswith('.'):
                dirs.append(entry.name)
    except PermissionError:
        return {"path": str(base), "dirs": [], "error": "Permission denied"}
    return {"path": str(base.resolve()), "dirs": dirs}


@router.post("/save-figures")
async def save_figures(request: SaveFiguresRequest):
    if len(request.extent_3857) != 4:
        return {"success": False, "error": "extent_3857 must contain exactly 4 numbers."}
    if not request.layers:
        return {"success": False, "error": "No layers were provided."}

    output_dir = Path(request.output_dir).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from mpl_toolkits.axes_grid1 import make_axes_locatable
    except Exception as e:
        return {"success": False, "error": f"Matplotlib is not available: {e}"}

    _TITILER_TO_MPL_CMAP = {
        "greens": "Greens", "viridis": "viridis", "inferno": "inferno",
        "magma": "magma", "plasma": "plasma", "cividis": "cividis",
        "ylgn": "YlGn", "ylgnbu": "YlGnBu", "gnbu": "GnBu",
        "bugn": "BuGn", "pubu": "PuBu", "rdylgn": "RdYlGn",
        "spectral": "Spectral", "rdbu": "RdBu", "greys": "Greys",
        "blues": "Blues", "reds": "Reds", "oranges": "Oranges",
        "ylgn_r": "YlGn_r", "ylgnbu_r": "YlGnBu_r", "gnbu_r": "GnBu_r",
        "bugn_r": "BuGn_r", "pubu_r": "PuBu_r", "rdylgn_r": "RdYlGn_r", 'rdgy': 'RdGy',
        "spectral_r": "Spectral_r", "rdbu_r": "RdBu_r",
    }

    def _resolve_cmap(name: Optional[str]) -> str:
        if not name:
            return "viridis"
        if name in _TITILER_TO_MPL_CMAP:
            return _TITILER_TO_MPL_CMAP[name]
        return name

    def _sanitize_name(name: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name.strip())
        cleaned = cleaned.strip("._")
        return cleaned or "layer"

    def _with_location_after_tile(layer_name: str) -> str:
        parts = layer_name.strip().split(maxsplit=1)
        if not parts:
            return loc_tag
        if len(parts) == 1:
            return f"{parts[0]} {loc_tag}"
        return f"{parts[0]} {loc_tag} {parts[1]}"

    def _read_as_float(src, window, indexes=None):
        """Read rasterio data as float32, replacing nodata with nan."""
        kwargs = {"window": window}
        if indexes is not None:
            kwargs["indexes"] = indexes
        raw = src.read(**kwargs).astype(np.float32)
        nodata = src.nodata
        if nodata is not None:
            raw[raw == nodata] = np.nan
        return raw

    def _normalize_single_band(arr: np.ndarray, low: Optional[float], high: Optional[float]) -> np.ndarray:
        data = arr.copy()
        valid = np.isfinite(data)
        if not np.any(valid):
            return np.zeros_like(data, dtype=np.float32)
        if low is None or high is None:
            vals = data[valid]
            low = float(np.percentile(vals, 2))
            high = float(np.percentile(vals, 98))
        if high <= low:
            high = low + 1.0
        out = (data - float(low)) / (float(high) - float(low))
        out = np.clip(out, 0.0, 1.0)
        out[~valid] = np.nan
        return out

    def _resolve_single_band_range(arr: np.ndarray, low: Optional[float], high: Optional[float]) -> tuple[float, float]:
        valid = np.isfinite(arr)
        if not np.any(valid):
            return 0.0, 1.0
        if low is None or high is None:
            vals = arr[valid]
            low = float(np.percentile(vals, 2))
            high = float(np.percentile(vals, 98))
        if high <= low:
            high = low + 1.0
        return float(low), float(high)

    def _normalize_rgb(rgb: np.ndarray) -> np.ndarray:
        out = np.zeros_like(rgb, dtype=np.float32)
        for i in range(3):
            band = rgb[i]
            valid = np.isfinite(band)
            if not np.any(valid):
                continue
            lo = float(np.percentile(band[valid], 2))
            hi = float(np.percentile(band[valid], 98))
            if hi <= lo:
                hi = lo + 1.0
            norm = (band - lo) / (hi - lo)
            out[i] = np.clip(norm, 0.0, 1.0)
        return np.transpose(out, (1, 2, 0))

    def _normalize_rgb_with_range(
        rgb: np.ndarray,
        low: float,
        high: float,
        gamma: float = 1.0,
        brightness: float = 1.0,
    ) -> np.ndarray:
        if high <= low:
            high = low + 1.0
        out = np.zeros_like(rgb, dtype=np.float32)
        for i in range(3):
            band = rgb[i]
            norm = (band - low) / (high - low)
            norm = np.clip(norm, 0.0, 1.0)
            if gamma > 0 and gamma != 1.0:
                norm = np.power(norm, 1.0 / gamma)
            if brightness != 1.0:
                norm = np.clip(norm * brightness, 0.0, 1.0)
            out[i] = norm
        return np.transpose(out, (1, 2, 0))

    def _resolve_rgb_indexes(src, requested: Optional[List[int]], prefer_sentinel_rgb: bool) -> List[int]:
        if requested and len(requested) == 3 and all(isinstance(v, int) and 1 <= v <= src.count for v in requested):
            return requested
        if prefer_sentinel_rgb and src.count >= 4:
            return [4, 3, 2]
        return [1, 2, 3]

    xmin, ymin, xmax, ymax = [float(v) for v in request.extent_3857]
    wgs_bounds = transform_bounds("EPSG:3857", "EPSG:4326", xmin, ymin, xmax, ymax)
    center_lon = (wgs_bounds[0] + wgs_bounds[2]) / 2
    center_lat = (wgs_bounds[1] + wgs_bounds[3]) / 2
    loc_tag = f"{center_lat:.4f}_{center_lon:.4f}".replace("-", "m")
    saved_files = []
    errors = []
    custom_stem: Optional[str] = None
    if request.filename_stem and request.filename_stem.strip():
        custom_stem = _sanitize_name(request.filename_stem.strip())
    n_layers = len(request.layers)

    def _save_one_figure(src, window, title: str, filename: str, cmap: Optional[str],
                         rmin: Optional[float], rmax: Optional[float], band_idx: Optional[int],
                         prefer_sentinel_rgb: bool = False, rgb_bands: Optional[List[int]] = None,
                         include_colorbar: bool = True):
        # Higher dpi for PDF — vector elements stay sharp regardless, but the
        # embedded raster (the imshow of the data) inherits the figure dpi.
        render_dpi = 300 if request.format == "pdf" else 160
        fig, ax = plt.subplots(figsize=(8, 8), dpi=render_dpi)
        ax.set_axis_off()
        ax.set_title(title, fontsize=11)
        if band_idx is not None:
            data = _read_as_float(src, window, indexes=band_idx)
        elif src.count >= 3 and cmap is None:
            rgb_indexes = _resolve_rgb_indexes(src, rgb_bands, prefer_sentinel_rgb)
            rgb = _read_as_float(src, window, indexes=rgb_indexes)
            if prefer_sentinel_rgb:
                if rmin is not None and rmax is not None:
                    rendered = _normalize_rgb_with_range(
                        rgb,
                        float(rmin),
                        float(rmax),
                        gamma=1.25,
                        brightness=1.15,
                    )
                else:
                    valid = rgb[np.isfinite(rgb)]
                    auto_high = 255.0
                    if valid.size > 0 and float(np.nanmax(valid)) > 255.0:
                        auto_high = 2500.0
                    rendered = _normalize_rgb_with_range(
                        rgb,
                        0.0,
                        auto_high,
                        gamma=1.25,
                        brightness=1.15,
                    )
                ax.imshow(rendered)
            else:
                ax.imshow(_normalize_rgb(rgb))
            out_path = output_dir / filename
            fig.savefig(out_path, format=request.format, bbox_inches="tight", pad_inches=0.05)
            plt.close(fig)
            return str(out_path)
        else:
            data = _read_as_float(src, window, indexes=1)
        low, high = _resolve_single_band_range(data, rmin, rmax)

        # No-colorbar path: discard the titled 8×8 layout and render the
        # colormapped data edge-to-edge (axes fills the figure) so the output
        # has no white border — matching the RGB / EOX figures.
        if not include_colorbar:
            plt.close(fig)
            h_px, w_px = data.shape[:2]
            fig_w_in = 10.0
            fig_h_in = max(0.5, fig_w_in * (h_px / max(1, w_px)))
            fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=render_dpi)
            ax = fig.add_axes([0, 0, 1, 1])  # axes fills figure → no margins
            ax.set_axis_off()
            ax.imshow(data, cmap=_resolve_cmap(cmap), vmin=low, vmax=high, aspect="auto")
            out_path = output_dir / filename
            save_kwargs = {"pad_inches": 0}
            if request.format == "png":
                save_kwargs["transparent"] = True
            fig.savefig(out_path, format=request.format, **save_kwargs)
            plt.close(fig)
            return str(out_path)

        im = ax.imshow(data, cmap=_resolve_cmap(cmap), vmin=low, vmax=high)
        # Show colorbar only for single-band renderings; match colorbar height to image axes.
        divider = make_axes_locatable(ax)
        cax = divider.append_axes("right", size="5%", pad=0.15)
        cbar = fig.colorbar(im, cax=cax)
        cbar.ax.tick_params(labelsize=8)
        out_path = output_dir / filename
        fig.savefig(out_path, format=request.format, bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        return str(out_path)

    for layer in request.layers:
        try:
            is_sentinel = (layer.layer_type == "sentinel2")
            with rasterio.open(layer.url) as src:
                src_bounds = transform_bounds("EPSG:3857", src.crs, xmin, ymin, xmax, ymax, densify_pts=21)
                window = from_bounds(*src_bounds, transform=src.transform)
                full_window = Window(0, 0, src.width, src.height)
                window = window.intersection(full_window).round_offsets().round_lengths()
                if window.width <= 0 or window.height <= 0:
                    raise ValueError("Selection does not overlap layer extent.")

                if layer.bands and len(layer.bands) > 0:
                    for bs in layer.bands:
                        bname = bs.band_name or f"band{bs.band_index}"
                        title = f"{layer.name} — {bname}"
                        if custom_stem:
                            if n_layers > 1:
                                fname = f"{custom_stem}_{_sanitize_name(layer.name)}_{_sanitize_name(bname)}.{request.format}"
                            else:
                                fname = f"{custom_stem}_{_sanitize_name(bname)}.{request.format}"
                        else:
                            base_name = _with_location_after_tile(layer.name)
                            fname = f"{_sanitize_name(base_name)}_{_sanitize_name(bname)}.{request.format}"
                        cmap = bs.colormap if bs.colormap is not None else layer.colormap
                        rmin = bs.rescale_min if bs.rescale_min is not None else layer.rescale_min
                        rmax = bs.rescale_max if bs.rescale_max is not None else layer.rescale_max
                        path = _save_one_figure(
                            src, window, title, fname, cmap, rmin, rmax, bs.band_index, is_sentinel, layer.rgb_bands,
                            include_colorbar=(layer.include_colorbar is not False),
                        )
                        saved_files.append(path)
                else:
                    if custom_stem:
                        if n_layers > 1:
                            fname = f"{custom_stem}_{_sanitize_name(layer.name)}.{request.format}"
                        else:
                            fname = f"{custom_stem}.{request.format}"
                    else:
                        base_name = _with_location_after_tile(layer.name)
                        fname = f"{_sanitize_name(base_name)}.{request.format}"
                    path = _save_one_figure(src, window, layer.name, fname,
                                            layer.colormap, layer.rescale_min, layer.rescale_max, None,
                                            is_sentinel, layer.rgb_bands,
                                            include_colorbar=(layer.include_colorbar is not False))
                    saved_files.append(path)
        except Exception as e:
            errors.append({"layer_id": layer.layer_id, "name": layer.name, "error": str(e)})

    # Optionally save a high-resolution Google Satellite snapshot of the same
    # drawing area alongside the per-layer figures.
    if request.include_google_satellite:
        try:
            from routes.saved_features import _stitch_bbox_satellite, _burn_scale_bar  # noqa: WPS433
            sat_bytes, sat_meta = _stitch_bbox_satellite(
                float(wgs_bounds[0]),
                float(wgs_bounds[2]),
                float(wgs_bounds[1]),
                float(wgs_bounds[3]),
                buffer_m=0.0,
                max_width_px=int(request.google_satellite_max_width_px),
            )
            if sat_bytes is None:
                errors.append({
                    "layer_id": "_google_satellite",
                    "name": "Google Satellite",
                    "error": "Tile fetch failed (no provider returned imagery)",
                })
            else:
                # Burn a metric scale bar into the lower-left corner so the
                # exported HD satellite image is self-describing. Caller can
                # opt out via the UI checkbox when the bar would duplicate
                # another decoration.
                if request.include_google_satellite_scale_bar:
                    try:
                        sat_bytes = _burn_scale_bar(sat_bytes, sat_meta)
                    except Exception:
                        pass  # Scale bar is decorative; never block the export.
                stem = (request.filename_stem or "").strip()
                sat_name = (
                    f"{_sanitize_name(stem)}_google_satellite.png"
                    if stem
                    else f"google_satellite_{_sanitize_name(loc_tag)}.png"
                )
                sat_path = output_dir / sat_name
                sat_path.write_bytes(sat_bytes)
                saved_files.append(str(sat_path))
        except Exception as e:
            errors.append({
                "layer_id": "_google_satellite",
                "name": "Google Satellite",
                "error": str(e),
            })

    return {
        "success": len(saved_files) > 0,
        "saved_files": saved_files,
        "errors": errors,
        "output_dir": str(output_dir),
        "location_tag": loc_tag,
        "format": request.format,
    }
