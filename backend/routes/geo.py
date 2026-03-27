"""GeoParquet, GeoJSON, FlatGeobuf proxy/local, geolocation, and tile-offset endpoints."""

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, Response
from pydantic import BaseModel
from typing import List, Optional
from urllib.parse import urlparse
import geopandas as gpd
import json
import os
import requests as http_requests

router = APIRouter(tags=["geo"])

S2_GRID_LOCAL_PATH = os.environ.get("S2_GRID_LOCAL_PATH", "")

# ---------------------------------------------------------------------------
# GeoParquet
# ---------------------------------------------------------------------------

@router.post("/geoparquet/info")
async def get_geoparquet_info(file_path: str):
    try:
        gdf = gpd.read_parquet(file_path)
        return {
            "crs": str(gdf.crs) if gdf.crs else None,
            "bounds": gdf.total_bounds.tolist(),
            "count": len(gdf),
            "columns": gdf.columns.tolist(),
            "geometry_types": gdf.geometry.geom_type.unique().tolist(),
            "memory_usage": gdf.memory_usage(deep=True).sum(),
        }
    except Exception as e:
        return {"error": str(e)}


@router.post("/geoparquet/geojson")
async def geoparquet_to_geojson(file_path: str, limit: int = 1000):
    try:
        gdf = gpd.read_parquet(file_path)
        if len(gdf) > limit:
            gdf = gdf.head(limit)
        return json.loads(gdf.to_json())
    except Exception as e:
        return {"error": str(e)}


@router.post("/geoparquet/sample")
async def get_geoparquet_sample(file_path: str, sample_size: int = 100):
    try:
        gdf = gpd.read_parquet(file_path)
        if len(gdf) > sample_size:
            gdf = gdf.sample(n=sample_size)
        return json.loads(gdf.to_json())
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# FlatGeobuf proxy / local
# ---------------------------------------------------------------------------

@router.get("/fgb/proxy")
async def proxy_fgb(url: str, request: Request):
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return Response(content=json.dumps({"error": "Invalid URL"}).encode(), media_type="application/json", status_code=400)

        range_header = request.headers.get("range")
        headers = {"Range": range_header} if range_header else {}
        response = http_requests.get(url, timeout=60, stream=True, headers=headers)
        response.raise_for_status()

        resp_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Range, Content-Range, Content-Length",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
            "Content-Type": "application/octet-stream",
            "Accept-Ranges": "bytes",
        }
        cl = response.headers.get("Content-Length")
        if cl:
            resp_headers["Content-Length"] = cl

        if range_header:
            cr = response.headers.get("Content-Range", "")
            if cr:
                resp_headers["Content-Range"] = cr
            status_code = 206 if response.status_code == 206 else 200
        else:
            status_code = 200

        def generate():
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

        return StreamingResponse(generate(), status_code=status_code, media_type="application/octet-stream", headers=resp_headers)
    except http_requests.exceptions.RequestException as e:
        return Response(content=json.dumps({"error": str(e)}).encode(), media_type="application/json", status_code=500)
    except Exception as e:
        return Response(content=json.dumps({"error": str(e)}).encode(), media_type="application/json", status_code=500)


@router.options("/fgb/proxy")
async def proxy_fgb_options():
    return Response(headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Range, Content-Length",
        "Access-Control-Max-Age": "3600",
    })


@router.get("/fgb/local")
async def serve_local_fgb(request: Request):
    if not S2_GRID_LOCAL_PATH or not os.path.isfile(S2_GRID_LOCAL_PATH):
        return Response(content=json.dumps({"error": "S2_GRID_LOCAL_PATH not set or file missing"}).encode(), media_type="application/json", status_code=404)

    file_size = os.path.getsize(S2_GRID_LOCAL_PATH)
    range_header = request.headers.get("range")
    cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        "Accept-Ranges": "bytes",
    }

    if range_header:
        parts = range_header.replace("bytes=", "").split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else file_size - 1
        end = min(end, file_size - 1)
        length = end - start + 1

        def generate():
            with open(S2_GRID_LOCAL_PATH, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    data = f.read(min(8192, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(generate(), status_code=206, media_type="application/octet-stream", headers={**cors, "Content-Length": str(length), "Content-Range": f"bytes {start}-{end}/{file_size}"})
    else:
        def generate():
            with open(S2_GRID_LOCAL_PATH, "rb") as f:
                while True:
                    data = f.read(8192)
                    if not data:
                        break
                    yield data

        return StreamingResponse(generate(), status_code=200, media_type="application/octet-stream", headers={**cors, "Content-Length": str(file_size)})


@router.head("/fgb/local")
async def head_local_fgb():
    if not S2_GRID_LOCAL_PATH or not os.path.isfile(S2_GRID_LOCAL_PATH):
        return Response(status_code=404)
    return Response(status_code=200, headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        "Accept-Ranges": "bytes",
        "Content-Length": str(os.path.getsize(S2_GRID_LOCAL_PATH)),
        "Content-Type": "application/octet-stream",
    })


@router.options("/fgb/local")
async def local_fgb_options():
    return Response(headers={
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Range, Content-Length",
        "Access-Control-Max-Age": "3600",
    })


# ---------------------------------------------------------------------------
# GeoJSON proxy endpoints
# ---------------------------------------------------------------------------

@router.post("/geojson/info")
async def get_geojson_info(url: str):
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return {"error": "Invalid URL format"}
        response = http_requests.get(url, timeout=30)
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict) or "type" not in data:
            return {"error": "Invalid GeoJSON format"}
        features = data.get("features", [])
        properties = list(features[0]["properties"].keys()) if features and "properties" in features[0] else []
        geom_types = list({f.get("geometry", {}).get("type", "Unknown") for f in features if "geometry" in f})
        return {"type": data.get("type"), "features": len(features), "properties": properties, "geometry_types": geom_types, "size_bytes": len(response.content), "crs": data.get("crs", {}).get("properties", {}).get("name", "EPSG:4326")}
    except Exception as e:
        return {"error": str(e)}


@router.post("/geojson/validate")
async def validate_geojson_url(url: str):
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return {"valid": False, "error": "Invalid URL format"}
        head = http_requests.head(url, timeout=10)
        head.raise_for_status()
        ct = head.headers.get("content-type", "").lower()
        if "json" not in ct and "geojson" not in ct:
            return {"valid": False, "warning": "URL may not contain JSON data"}
        return {"valid": True, "content_type": ct}
    except Exception as e:
        return {"valid": False, "error": str(e)}


@router.post("/geojson/sample")
async def get_geojson_sample(url: str, sample_size: int = 100):
    try:
        response = http_requests.get(url, timeout=30)
        response.raise_for_status()
        data = response.json()
        if "features" not in data:
            return {"error": "No features found"}
        features = data["features"]
        if len(features) > sample_size:
            import random
            features = random.sample(features, sample_size)
        sampled = {"type": data.get("type", "FeatureCollection"), "features": features}
        for key in ["crs", "bbox", "properties"]:
            if key in data:
                sampled[key] = data[key]
        return sampled
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Geolocation & tile offset
# ---------------------------------------------------------------------------

class GeolocationSearchRequest(BaseModel):
    latitude: float
    longitude: float


@router.post("/geolocation/search")
async def geolocation_search(request: GeolocationSearchRequest):
    if not (-90 <= request.latitude <= 90):
        return {"error": "Latitude must be between -90 and 90"}
    if not (-180 <= request.longitude <= 180):
        return {"error": "Longitude must be between -180 and 180"}
    return {"success": True, "latitude": request.latitude, "longitude": request.longitude}


@router.get("/geolocation/search")
async def geolocation_search_get(latitude: float, longitude: float):
    if not (-90 <= latitude <= 90):
        return {"error": "Latitude must be between -90 and 90"}
    if not (-180 <= longitude <= 180):
        return {"error": "Longitude must be between -180 and 180"}
    return {"success": True, "latitude": latitude, "longitude": longitude}


@router.options("/geolocation/search")
async def geolocation_search_options():
    return {"message": "OK"}


class TileOffsetRequest(BaseModel):
    tile_name: str
    latitude: float
    longitude: float
    geometry_coordinates: Optional[List[List[List[float]]]] = None


@router.post("/tile/offset")
async def get_tile_offset(request: TileOffsetRequest):
    try:
        lat, lon = request.latitude, request.longitude
        if not (-90 <= lat <= 90):
            return {"error": "Latitude must be between -90 and 90"}
        if not (-180 <= lon <= 180):
            return {"error": "Longitude must be between -180 and 180"}

        tile_bbox = None
        if request.geometry_coordinates:
            all_coords = [c for ring in request.geometry_coordinates for c in ring if len(c) >= 2]
            if all_coords:
                lons = [c[0] for c in all_coords]
                lats = [c[1] for c in all_coords]
                tile_bbox = [min(lons), min(lats), max(lons), max(lats)]

        if not tile_bbox:
            stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
            try:
                resp = http_requests.post(stac_url, json={"collections": ["sentinel-2-l2a"], "query": {"s2:mgrs_tile": {"eq": request.tile_name.upper()}}, "limit": 1}, headers={"Content-Type": "application/json", "User-Agent": "MapExplorer/1.0"}, timeout=30)
                resp.raise_for_status()
                features = resp.json().get("features", [])
                if features:
                    tile_bbox = features[0].get("bbox")
                    geom = features[0].get("geometry", {})
                    if not tile_bbox and geom.get("type") == "Polygon":
                        coords = geom.get("coordinates", [[]])[0]
                        if coords:
                            tile_bbox = [min(c[0] for c in coords), min(c[1] for c in coords), max(c[0] for c in coords), max(c[1] for c in coords)]
            except Exception as e:
                return {"error": f"Failed to get tile bounds: {e}"}

        if not tile_bbox or len(tile_bbox) != 4:
            return {"error": "Could not determine tile bounds"}

        min_lon, min_lat, max_lon, max_lat = tile_bbox
        col_norm = (lon - min_lon) / (max_lon - min_lon) if max_lon != min_lon else 0.5
        row_norm = (max_lat - lat) / (max_lat - min_lat) if max_lat != min_lat else 0.5
        pixels = 10980

        return {
            "success": True, "tile_name": request.tile_name.upper(),
            "point": {"latitude": lat, "longitude": lon},
            "tile_bounds": {"min_lon": min_lon, "min_lat": min_lat, "max_lon": max_lon, "max_lat": max_lat},
            "offset": {
                "column_normalized": col_norm, "row_normalized": row_norm,
                "column_degrees": lon - min_lon, "row_degrees": max_lat - lat,
                "column_pixels": round(col_norm * pixels, 2), "row_pixels": round(row_norm * pixels, 2),
            },
            "tile_dimensions": {"width_degrees": max_lon - min_lon, "height_degrees": max_lat - min_lat, "estimated_pixels": pixels},
        }
    except Exception as e:
        return {"error": str(e)}


@router.options("/tile/offset")
async def tile_offset_options():
    return {"message": "OK"}
