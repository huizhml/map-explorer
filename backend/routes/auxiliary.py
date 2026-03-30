"""Auxiliary data endpoints: distance map, CR, profile entropy, ALS, GEDI."""

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from typing import List, Optional
from pathlib import Path
import asyncio
import json
import os
import subprocess
import tempfile
import numpy as np
import math

import geopandas as gpd
import pandas as pd
import pyarrow.parquet as pq
from fastapi import HTTPException
from shapely import wkb, wkt

import utils
from utils import create_vrt, vertical_profile, pixel_diversity_indices

try:
    import duckdb
except Exception:
    duckdb = None

router = APIRouter(prefix="/auxiliary", tags=["auxiliary"])

# ---------------------------------------------------------------------------
# Env vars
# ---------------------------------------------------------------------------

PREDICTIONS_LOCAL_BASE_PATH = os.environ.get("PREDICTIONS_LOCAL_BASE_PATH", "")
PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH = os.environ.get("PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH", "")
PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE = os.environ.get("PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE", "{tile}_Q{q}.vrt")
DISTANCE_MAPS_LOCAL_BASE_PATH = os.environ.get("DISTANCE_MAPS_LOCAL_BASE_PATH", "")
CR_LOCAL_BASE_PATH = os.environ.get("CR_LOCAL_BASE_PATH", "")
DIVERSITY_INDICES_LOCAL_BASE_PATH = os.environ.get("DIVERSITY_INDICES_LOCAL_BASE_PATH", "")
ALS_LOCAL_TEMPLATE = os.environ.get("ALS_LOCAL_TEMPLATE", "")
GEDI_LOCAL_BASE_PATH = os.environ.get("GEDI_LOCAL_BASE_PATH", "")

# ---------------------------------------------------------------------------
# Computation helpers
# ---------------------------------------------------------------------------


async def _compute_cr(tile_id: str, year: int) -> Path:
    path_a = Path(f"{PREDICTIONS_LOCAL_BASE_PATH}/{tile_id}/RH98_Q1.tif")
    path_b = Path(f"{PREDICTIONS_LOCAL_BASE_PATH}/{tile_id}/RH25_Q1.tif")
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
        "-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "OVERVIEW_RESAMPLING=AVERAGE",
    ]

    loop = asyncio.get_event_loop()
    for cmd in [calc_cmd, translate_cmd]:
        result = await loop.run_in_executor(None, lambda c=cmd: subprocess.run(c, capture_output=True, text=True))
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr)

    path_cr.unlink(missing_ok=True)
    return path_cr_cog


async def _compute_entropy(tile_id: str, year: int):
    path_entropy = Path(f"{DIVERSITY_INDICES_LOCAL_BASE_PATH}/{year}/tiles/geotiff/{tile_id}_Q1.tif")
    path_entropy_cog = Path(f"{DIVERSITY_INDICES_LOCAL_BASE_PATH}/{year}/tiles/cog/{tile_id}_Q1.tif")
    if path_entropy_cog.exists():
        return path_entropy_cog

    input_vrt_path = Path(PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE.format(tile=tile_id, q=1))
    if not input_vrt_path.exists():
        tile_dir = Path(f"{PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH}/{tile_id}")
        create_vrt(tile_dir, input_vrt_path)

    utils.compute_entropy(output_path=path_entropy, tile_id=tile_id, year=year, vrt_path=input_vrt_path)

    translate_cmd = [
        "gdal_translate", str(path_entropy), str(path_entropy_cog),
        "-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "OVERVIEW_RESAMPLING=AVERAGE",
    ]
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, lambda: subprocess.run(translate_cmd, capture_output=True, text=True))
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr)

    path_entropy.unlink(missing_ok=True)
    return path_entropy_cog


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

class AuxiliaryEntropyRequest(BaseModel):
    tile_name: str
    year: int
    metric: str = "entropy"

class AuxiliaryALSRequest(BaseModel):
    tile_name: str


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

    try:
        x_vals, y_vals = vertical_profile(rhs, min_rh=-20, max_rh=50, step=1, window=3)
        vp = [{"z": _safe(float(z)), "value": _safe(float(v))} for z, v in zip(x_vals.tolist(), y_vals.tolist())]
    except Exception as e:
        vp = []
        print(f"[gedi/point-profile] vertical_profile error: {e}")

    def _safe_scalar(v: float):
        return None if (math.isnan(v) or math.isinf(v)) else v

    try:
        fhd, enl1d, enl2d = _safe_scalar(float(pixel_diversity_indices(rhs, interval=request.fhd_interval, max_height=100)))
    except Exception as e:
        fhd, enl1d, enl2d = None, None, None
        print(f"[gedi/point-profile] pixel_diversity_indices error: {e}")

    return {
        "success": True,
        "rh_curve": [{"rh": i, "value": _safe(float(v))} for i, v in enumerate(rhs)],
        "vertical_profile": vp,
        "fhd": fhd,
        "enl1d": enl1d,
        "enl2d": enl2d,
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
        path_out = await _compute_cr(request.tile_name, request.year)
        return {"success": True, "url": str(path_out), "tile_name": request.tile_name, "layer_type": "cr"}
    except HTTPException as exc:
        return {"success": False, "error": exc.detail if isinstance(exc.detail, str) else str(exc.detail)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.options("/cr")
async def auxiliary_cr_options():
    return {"message": "OK"}


@router.post("/profile-entropy")
async def load_or_compute_profile_entropy(request: AuxiliaryEntropyRequest):
    if not DIVERSITY_INDICES_LOCAL_BASE_PATH:
        return {"success": False, "error": "DIVERSITY_INDICES_LOCAL_BASE_PATH env var is not set."}
    metric = request.metric.strip().lower()
    if metric not in {"entropy", "enl1d", "enl2d"}:
        return {"success": False, "error": f"Invalid metric '{request.metric}'."}
    path = Path(DIVERSITY_INDICES_LOCAL_BASE_PATH) / str(request.year) / "tiles" / "cog" / f"{request.tile_name}_{metric}.tif"
    if path.is_file():
        return {"success": True, "url": str(path), "tile_name": request.tile_name, "layer_type": "profile_entropy", "metric": metric}
    try:
        path_out = await _compute_entropy(request.tile_name, request.year)
        return {"success": True, "url": str(path_out), "tile_name": request.tile_name, "layer_type": "profile_entropy", "metric": metric}
    except HTTPException as exc:
        return {"success": False, "error": exc.detail if isinstance(exc.detail, str) else str(exc.detail)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.options("/profile-entropy")
async def auxiliary_profile_entropy_options():
    return {"message": "OK"}


@router.post("/als")
async def load_als(request: AuxiliaryALSRequest):
    if not ALS_LOCAL_TEMPLATE:
        return {"success": False, "error": "ALS_LOCAL_TEMPLATE env var is not set."}
    try:
        candidate = Path(ALS_LOCAL_TEMPLATE.format(tile=request.tile_name))
        if candidate.is_file():
            return {"success": True, "url": str(candidate), "tile_name": request.tile_name, "layer_type": "als"}
    except Exception:
        pass
    return {"success": False, "error": f"ALS tile not found for {request.tile_name}."}


@router.options("/als")
async def auxiliary_als_options():
    return {"message": "OK"}
