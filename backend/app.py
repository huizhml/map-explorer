from fastapi import FastAPI
from titiler.core.factory import TilerFactory
from titiler.mosaic.factory import MosaicTilerFactory
from titiler.extensions import cogViewerExtension  # adds /viewer to the COG tiler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from fastapi.responses import StreamingResponse
import geopandas as gpd
import pandas as pd
from pathlib import Path
import json
from typing import List, Dict, Any, Optional
import requests
from urllib.parse import urlparse, quote
from pydantic import BaseModel
from datetime import datetime
from pyproj import Transformer
import re
import time
import os

origins = [
    "http://localhost:9020",
    "http://127.0.0.1:9020",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    # add other dev origins if needed
]

# Custom middleware to ensure CORS headers on all responses
class CustomCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Handle preflight OPTIONS requests
        if request.method == "OPTIONS":
            
            return Response(
                status_code=200,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Expose-Headers": "*",
                    "Access-Control-Max-Age": "3600",
                }
            )
        
        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"
        response.headers["Access-Control-Expose-Headers"] = "*"
        return response

app = FastAPI(title="Canopy Height – TiTiler with Mosaic + Viewer")

# Add custom CORS middleware FIRST to ensure all responses get CORS headers
app.add_middleware(CustomCORSMiddleware)

# --- Log prediction env vars at startup ---
PREDICTIONS_LOCAL_BASE_PATH = os.environ.get('PREDICTIONS_LOCAL_BASE_PATH', '')
PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH = os.environ.get('PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH', '')
PREDICTIONS_LOCAL_PATH_TEMPLATE = os.environ.get('PREDICTIONS_LOCAL_PATH_TEMPLATE', '{tile}/RH{rh}_Q{q}.tif')
PREDICTIONS_BASE_URL = os.environ.get('PREDICTIONS_BASE_URL', '')
PREDICTIONS_REMOTE_PATH_TEMPLATE = os.environ.get('PREDICTIONS_REMOTE_PATH_TEMPLATE', '{zone}-{year}/{tile}/RH{rh}_Q{q}.tif')
PREDICTIONS_MOSAIC_LOCAL_PATH = os.environ.get('PREDICTIONS_MOSAIC_LOCAL_PATH', '')
DISTANCE_MAPS_LOCAL_BASE_PATH = os.environ.get('DISTANCE_MAPS_LOCAL_BASE_PATH', '')
S2_GRID_LOCAL_PATH = os.environ.get('S2_GRID_LOCAL_PATH', '')
print("=== Prediction env vars ===")
print(f"  PREDICTIONS_LOCAL_BASE_PATH  = {PREDICTIONS_LOCAL_BASE_PATH}")
print(f"  PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH = {PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH}")
print(f"  PREDICTIONS_LOCAL_PATH_TEMPLATE = {PREDICTIONS_LOCAL_PATH_TEMPLATE}")
print(f"  PREDICTIONS_MOSAIC_LOCAL_PATH = {PREDICTIONS_MOSAIC_LOCAL_PATH}")
print(f"  PREDICTIONS_BASE_URL         = {PREDICTIONS_BASE_URL}")
print(f"  PREDICTIONS_REMOTE_PATH_TEMPLATE = {PREDICTIONS_REMOTE_PATH_TEMPLATE}")
print(f"  DISTANCE_MAPS_LOCAL_BASE_PATH = {DISTANCE_MAPS_LOCAL_BASE_PATH}")
print(f"  S2_GRID_LOCAL_PATH           = {S2_GRID_LOCAL_PATH}")
print("===========================")

# COG tiler with a simple HTML viewer at /cog/viewer
cog = TilerFactory(extensions=[cogViewerExtension()])
app.include_router(cog.router, prefix="/cog", tags=["cog"])

# MosaicJSON tiler (serve /mosaicjson/tiles, /tilejson.json, /thumbnail, etc.)
mosaic = MosaicTilerFactory()
app.include_router(mosaic.router, tags=["mosaicjson"])

# Custom exception handler for TileOutsideBounds errors
# Returns a transparent 256x256 PNG instead of a 500 error
from fastapi import HTTPException, Request
from fastapi.responses import Response
from rio_tiler.errors import TileOutsideBounds
import io
from PIL import Image

@app.exception_handler(TileOutsideBounds)
async def tile_outside_bounds_handler(request: Request, exc: TileOutsideBounds):
    """Return a transparent tile for out-of-bounds requests instead of erroring"""
    # Create a transparent 256x256 PNG
    img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",  # Cache empty tiles
        }
    )


@app.get("/")
async def read_root():
    return {"message": "Hello World"}

@app.get("/mosaicjson/tiles/{z}/{x}/{y}.png")
async def get_mosaicjson_tile(z: int, x: int, y: int):
    return {"message": "Hello World"}

@app.get("/deploy/status")
async def get_deploy_status():
    return {"message": "Hello World"}

def sign_planetary_computer_url(url: str) -> str:
    """Sign a Planetary Computer URL using their signing service"""
    if not url:
        return url
    
    # Sign URLs from blob storage that are part of Planetary Computer
    # This includes both direct blob URLs and Planetary Computer URLs
    needs_signing = (
        'blob.core.windows.net' in url or 
        'planetarycomputer.microsoft.com' in url
    )
    
    if not needs_signing:
        return url
    
    try:
        # Use Planetary Computer's signing service
        # requests automatically URL-encodes query parameters
        signing_url = "https://planetarycomputer.microsoft.com/api/sas/v1/sign"
        
        # Retry logic for signing requests
        max_retries = 3
        retry_delay = 1
        signed_url = url
        
        for attempt in range(max_retries):
            try:
                response = requests.get(signing_url, params={"href": url}, timeout=30)
                response.raise_for_status()
                signed_data = response.json()
                signed_url = signed_data.get("href", url)
                break  # Success, exit retry loop
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout) as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)
                    print(f"URL signing timeout (attempt {attempt + 1}/{max_retries}). Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                else:
                    print(f"Warning: URL signing failed after {max_retries} attempts, returning original URL")
                    return url
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)
                    print(f"URL signing error (attempt {attempt + 1}/{max_retries}): {str(e)}. Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                else:
                    print(f"Warning: URL signing failed after {max_retries} attempts, returning original URL")
                    return url
        # Verify we got a signed URL (should contain SAS token parameters)
        if signed_url != url:
            # Check if it has signing parameters (indicating successful signing)
            has_sas_token = any(param in signed_url for param in ['sig=', 'se=', 'sv=', 'sp='])
            if has_sas_token:
                print(f"Successfully signed URL (length: {len(signed_url)})")
            else:
                print(f"Warning: Signed URL doesn't appear to have SAS token")
            return signed_url
        else:
            print(f"Warning: URL signing returned same URL - signing may have failed")
            print(f"URL: {url[:150]}")
            print(f"Response: {signed_data}")
            return url
    except Exception as e:
        print(f"Error signing URL: {e}")
        print(f"URL was: {url[:150]}")
        import traceback
        traceback.print_exc()
        return url

@app.post("/geoparquet/info")
async def get_geoparquet_info(file_path: str):
    """Get metadata and basic info about a GeoParquet file"""
    try:
        gdf = gpd.read_parquet(file_path)
        return {
            "crs": str(gdf.crs) if gdf.crs else None,
            "bounds": gdf.total_bounds.tolist(),
            "count": len(gdf),
            "columns": gdf.columns.tolist(),
            "geometry_types": gdf.geometry.geom_type.unique().tolist(),
            "memory_usage": gdf.memory_usage(deep=True).sum()
        }
    except Exception as e:
        return {"error": str(e)}

@app.post("/geoparquet/geojson")
async def geoparquet_to_geojson(file_path: str, limit: int = 1000):
    """Convert GeoParquet to GeoJSON for visualization"""
    try:
        gdf = gpd.read_parquet(file_path)
        
        # Limit features for performance
        if len(gdf) > limit:
            gdf = gdf.head(limit)
        
        # Convert to GeoJSON
        geojson = gdf.to_json()
        return json.loads(geojson)
    except Exception as e:
        return {"error": str(e)}

@app.post("/geoparquet/sample")
async def get_geoparquet_sample(file_path: str, sample_size: int = 100):
    """Get a sample of features from GeoParquet file"""
    try:
        gdf = gpd.read_parquet(file_path)
        
        # Sample the data
        if len(gdf) > sample_size:
            gdf_sample = gdf.sample(n=sample_size)
        else:
            gdf_sample = gdf
        
        # Convert to GeoJSON
        geojson = gdf_sample.to_json()
        return json.loads(geojson)
    except Exception as e:
        return {"error": str(e)}

class GeoJSONProxyRequest(BaseModel):
    url: str

class Sentinel2QueryRequest(BaseModel):
    extent: Optional[List[float]] = None  # [minX, minY, maxX, maxY] in EPSG:3857 (optional)
    year: int
    mgrs_tile: str

@app.post("/geojson/proxy")
async def proxy_geojson(request: GeoJSONProxyRequest):
    """Proxy GeoJSON or PMTiles data to bypass CORS restrictions"""
    try:
        # Validate URL
        parsed_url = urlparse(request.url)
        if not parsed_url.scheme or not parsed_url.netloc:
            return {"error": "Invalid URL format"}
        
        # Check if it's a PMTiles file
        is_pmtiles = request.url.lower().endswith('.pmtiles') or 'pmtiles' in request.url.lower()
        
        # Fetch data server-side
        response = requests.get(request.url, timeout=30, stream=True)
        response.raise_for_status()
        
        # If PMTiles, return as binary stream
        if is_pmtiles:
            # Read the binary content
            content = response.content
            return Response(
                content=content,
                media_type='application/x-protobuf',
                headers={
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/x-protobuf',
                    'Content-Length': str(len(content)),
                    'Cache-Control': 'public, max-age=3600',
                }
            )
        
        # Otherwise, treat as GeoJSON
        geojson_data = response.json()
        
        # Validate GeoJSON structure
        if not isinstance(geojson_data, dict) or 'type' not in geojson_data:
            return {"error": "Invalid GeoJSON format"}
        
        return geojson_data
        
    except requests.exceptions.RequestException as e:
        return {"error": f"Failed to fetch URL: {str(e)}"}
    except json.JSONDecodeError as e:
        # If JSON decode fails and URL looks like PMTiles, return error suggesting direct access
        if request.url.lower().endswith('.pmtiles') or 'pmtiles' in request.url.lower():
            return {"error": f"PMTiles files should be accessed directly, not through JSON proxy. Use the URL directly with PMTilesVectorSource."}
        return {"error": f"Invalid JSON: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}

@app.options("/geojson/proxy")
async def proxy_geojson_options():
    """Handle preflight requests for the proxy endpoint"""
    return {"message": "OK"}

@app.get("/fgb/proxy")
async def proxy_fgb(url: str, request: Request):
    """Proxy FlatGeobuf files with range request support for flatgeobuf library"""
    try:
        # Validate URL
        parsed_url = urlparse(url)
        if not parsed_url.scheme or not parsed_url.netloc:
            return Response(
                content=json.dumps({"error": "Invalid URL format"}).encode(),
                media_type='application/json',
                status_code=400
            )
        
        # Get range header if present (for HTTP range requests)
        range_header = request.headers.get('range')
        
        headers = {}
        if range_header:
            headers['Range'] = range_header
        
        # Fetch data server-side with streaming for large files
        response = requests.get(url, timeout=60, stream=True, headers=headers)
        response.raise_for_status()
        
        # Get content length from response
        content_length = response.headers.get('Content-Length')
        
        # Prepare response headers
        response_headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Range, Content-Length',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
            'Content-Type': 'application/octet-stream',
            'Accept-Ranges': 'bytes',
        }
        
        # Always stream the response for efficiency (works for both full and range requests)
        
        # Handle range responses (206 Partial Content)
        if range_header:
            content_range = response.headers.get('Content-Range', '')
            if content_length:
                response_headers['Content-Length'] = content_length
            if content_range:
                response_headers['Content-Range'] = content_range
            
            status_code = 206 if response.status_code == 206 else 200
        else:
            # Full content response
            if content_length:
                response_headers['Content-Length'] = content_length
            status_code = 200
        
        def generate():
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        
        return StreamingResponse(
            generate(),
            status_code=status_code,
            media_type='application/octet-stream',
            headers=response_headers
        )
        
    except requests.exceptions.RequestException as e:
        return Response(
            content=json.dumps({"error": f"Failed to fetch FlatGeobuf URL: {str(e)}"}).encode(),
            media_type='application/json',
            status_code=500
        )
    except Exception as e:
        return Response(
            content=json.dumps({"error": str(e)}).encode(),
            media_type='application/json',
            status_code=500
        )

@app.options("/fgb/proxy")
async def proxy_fgb_options():
    """Handle preflight requests for the FlatGeobuf proxy endpoint"""
    return Response(
        headers={
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Range, Content-Length',
            'Access-Control-Max-Age': '3600',
        }
    )

@app.get("/fgb/local")
async def serve_local_fgb(request: Request):
    """Serve the local FlatGeobuf file with HTTP range request support."""
    

    if not S2_GRID_LOCAL_PATH:
        return Response(
            content=json.dumps({"error": "S2_GRID_LOCAL_PATH env var is not set"}).encode(),
            media_type='application/json', status_code=500,
        )
    if not os.path.isfile(S2_GRID_LOCAL_PATH):
        return Response(
            content=json.dumps({"error": f"File not found: {S2_GRID_LOCAL_PATH}"}).encode(),
            media_type='application/json', status_code=404,
        )

    file_size = os.path.getsize(S2_GRID_LOCAL_PATH)
    range_header = request.headers.get('range')

    cors_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        'Accept-Ranges': 'bytes',
    }

    if range_header:
        # Parse "bytes=start-end"
        range_spec = range_header.replace('bytes=', '')
        parts = range_spec.split('-')
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else file_size - 1
        end = min(end, file_size - 1)
        length = end - start + 1

        def generate():
            with open(S2_GRID_LOCAL_PATH, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    data = f.read(chunk_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            generate(), status_code=206, media_type='application/octet-stream',
            headers={**cors_headers,
                     'Content-Length': str(length),
                     'Content-Range': f'bytes {start}-{end}/{file_size}'},
        )
    else:
        def generate():
            with open(S2_GRID_LOCAL_PATH, 'rb') as f:
                while True:
                    data = f.read(8192)
                    if not data:
                        break
                    yield data

        return StreamingResponse(
            generate(), status_code=200, media_type='application/octet-stream',
            headers={**cors_headers, 'Content-Length': str(file_size)},
        )

@app.head("/fgb/local")
async def head_local_fgb():
    """HEAD request for the local FlatGeobuf file (needed by flatgeobuf library)."""
    if not S2_GRID_LOCAL_PATH or not os.path.isfile(S2_GRID_LOCAL_PATH):
        return Response(status_code=404)
    file_size = os.path.getsize(S2_GRID_LOCAL_PATH)
    return Response(
        status_code=200,
        headers={
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
            'Accept-Ranges': 'bytes',
            'Content-Length': str(file_size),
            'Content-Type': 'application/octet-stream',
        },
    )

@app.options("/fgb/local")
async def local_fgb_options():
    return Response(
        headers={
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Range, Content-Length',
            'Access-Control-Max-Age': '3600',
        }
    )

@app.post("/geojson/info")
async def get_geojson_info(url: str):
    """Get metadata and basic info about a GeoJSON URL"""
    try:
        # Validate URL
        parsed_url = urlparse(url)
        if not parsed_url.scheme or not parsed_url.netloc:
            return {"error": "Invalid URL format"}
        
        # Fetch GeoJSON data
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        
        geojson_data = response.json()
        
        # Validate GeoJSON structure
        if not isinstance(geojson_data, dict) or 'type' not in geojson_data:
            return {"error": "Invalid GeoJSON format"}
        
        # Extract metadata
        features = geojson_data.get('features', [])
        properties = []
        geometry_types = []
        
        if features:
            # Get properties from first feature
            first_feature = features[0]
            if 'properties' in first_feature:
                properties = list(first_feature['properties'].keys())
            
            # Get geometry types
            geometry_types = list(set(
                f.get('geometry', {}).get('type', 'Unknown') 
                for f in features 
                if 'geometry' in f
            ))
        
        return {
            "type": geojson_data.get('type', 'Unknown'),
            "features": len(features),
            "properties": properties,
            "geometry_types": geometry_types,
            "size_bytes": len(response.content),
            "crs": geojson_data.get('crs', {}).get('properties', {}).get('name', 'EPSG:4326')
        }
        
    except requests.exceptions.RequestException as e:
        return {"error": f"Failed to fetch URL: {str(e)}"}
    except json.JSONDecodeError as e:
        return {"error": f"Invalid JSON: {str(e)}"}
    except Exception as e:
        return {"error": str(e)}

@app.post("/geojson/validate")
async def validate_geojson_url(url: str):
    """Validate if a URL contains valid GeoJSON data"""
    try:
        parsed_url = urlparse(url)
        if not parsed_url.scheme or not parsed_url.netloc:
            return {"valid": False, "error": "Invalid URL format"}
        
        # Quick HEAD request to check if URL exists
        head_response = requests.head(url, timeout=10)
        head_response.raise_for_status()
        
        # Check content type
        content_type = head_response.headers.get('content-type', '').lower()
        if 'json' not in content_type and 'geojson' not in content_type:
            return {"valid": False, "warning": "URL may not contain JSON data"}
        
        return {"valid": True, "content_type": content_type}
        
    except requests.exceptions.RequestException as e:
        return {"valid": False, "error": f"URL not accessible: {str(e)}"}
    except Exception as e:
        return {"valid": False, "error": str(e)}

@app.post("/geojson/sample")
async def get_geojson_sample(url: str, sample_size: int = 100):
    """Get a sample of features from GeoJSON URL"""
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        
        geojson_data = response.json()
        
        if 'features' not in geojson_data:
            return {"error": "No features found in GeoJSON"}
        
        features = geojson_data['features']
        
        # Sample the features
        if len(features) > sample_size:
            import random
            sampled_features = random.sample(features, sample_size)
        else:
            sampled_features = features
        
        # Create new GeoJSON with sampled features
        sampled_geojson = {
            "type": geojson_data.get('type', 'FeatureCollection'),
            "features": sampled_features
        }
        
        # Copy other properties if they exist
        for key in ['crs', 'bbox', 'properties']:
            if key in geojson_data:
                sampled_geojson[key] = geojson_data[key]
        
        return sampled_geojson
        
    except Exception as e:
        return {"error": str(e)}

def get_socket_error_message(error_code):
    """Get human-readable message for socket error codes"""
    import errno
    error_messages = {
        35: "Resource temporarily unavailable (EAGAIN) - Connection refused or blocked by firewall",
        61: "Connection refused (ECONNREFUSED) - Port may be blocked or service unavailable",
        51: "Network is unreachable (ENETUNREACH) - Network routing issue",
        64: "Host is down (EHOSTDOWN) - Server is not responding",
        65: "No route to host (EHOSTUNREACH) - Cannot reach the host",
        113: "No route to host (EHOSTUNREACH) - Network routing problem",
        111: "Connection refused - Port blocked or service down",
    }
    # Try to get errno message
    try:
        import errno
        errno_name = errno.errorcode.get(error_code, f"UNKNOWN({error_code})")
    except:
        errno_name = f"ERROR({error_code})"
    
    return error_messages.get(error_code, f"{errno_name}: TCP connection failed (likely firewall/proxy blocking port 443)")

def check_planetary_computer_accessible(timeout=5):
    """Quick check if Microsoft Planetary Computer is accessible with detailed diagnostics"""
    import socket
    
    stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
    host = "planetarycomputer.microsoft.com"
    port = 443
    
    diagnostics = []
    
    # Test 1: DNS resolution
    try:
        ip_address = socket.gethostbyname(host)
        diagnostics.append(f"✓ DNS resolved: {host} -> {ip_address}")
    except socket.gaierror as e:
        diagnostics.append(f"✗ DNS resolution failed: {str(e)}")
        print("\n".join(diagnostics))
        return False, diagnostics
    except Exception as e:
        diagnostics.append(f"✗ DNS check error: {type(e).__name__}: {str(e)}")
    
    # Test 2: TCP connection to port 443
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        result = sock.connect_ex((host, port))
        sock.close()
        if result == 0:
            diagnostics.append(f"✓ TCP connection to {host}:{port} successful")
        else:
            error_msg = get_socket_error_message(result)
            diagnostics.append(f"✗ TCP connection failed: {error_msg}")
            diagnostics.append(f"  → This typically means:")
            if result == 35:
                diagnostics.append(f"     • Firewall is blocking port 443 (HTTPS)")
                diagnostics.append(f"     • Corporate network/VPN restrictions")
                diagnostics.append(f"     • Proxy configuration needed")
            else:
                diagnostics.append(f"     • Port 443 may be blocked by firewall")
                diagnostics.append(f"     • Network routing or proxy issue")
            print("\n".join(diagnostics))
            return False, diagnostics
    except socket.timeout:
        diagnostics.append(f"✗ TCP connection timeout to {host}:{port}")
        print("\n".join(diagnostics))
        return False, diagnostics
    except Exception as e:
        diagnostics.append(f"✗ TCP connection error: {type(e).__name__}: {str(e)}")
        print("\n".join(diagnostics))
        return False, diagnostics
    
    # Test 3: HTTP/HTTPS request
    try:
        response = requests.get(stac_url, timeout=timeout, verify=True)
        if response.status_code == 200:
            diagnostics.append(f"✓ HTTP request successful: Status {response.status_code}")
            print("\n".join(diagnostics))
            return True, diagnostics
        else:
            diagnostics.append(f"⚠ HTTP request returned status {response.status_code}")
            print("\n".join(diagnostics))
            return False, diagnostics
    except requests.exceptions.SSLError as e:
        diagnostics.append(f"✗ SSL/TLS error: {str(e)}")
        print("\n".join(diagnostics))
        return False, diagnostics
    except requests.exceptions.ConnectTimeout as e:
        diagnostics.append(f"✗ Connection timeout (HTTPS): {str(e)}")
        print("\n".join(diagnostics))
        return False, diagnostics
    except requests.exceptions.ConnectionError as e:
        diagnostics.append(f"✗ Connection error: {str(e)}")
        print("\n".join(diagnostics))
        return False, diagnostics
    except Exception as e:
        diagnostics.append(f"✗ Request error: {type(e).__name__}: {str(e)}")
        print("\n".join(diagnostics))
        return False, diagnostics

@app.options("/sentinel2/query")
async def query_sentinel2_options():
    """Handle CORS preflight for sentinel2/query endpoint"""
    return {"message": "OK"}

@app.post("/sentinel2/query")
async def query_sentinel2(request: Sentinel2QueryRequest):
    """Query Sentinel-2 images using tile name from GeoJSON layer"""
    try:
        # Date range for the specified year
        start_date = f"{request.year}-01-01T00:00:00Z"
        end_date = f"{request.year}-12-31T23:59:59Z"
        mgrs_tile = request.mgrs_tile
        
        # Quick connectivity check before attempting full query
        print(f"Checking connectivity to Microsoft Planetary Computer...")
        is_accessible, diagnostics = check_planetary_computer_accessible(timeout=5)
        if not is_accessible:
            diagnostics_text = "\n".join(diagnostics) if diagnostics else "Connection test failed"
            return {
                "success": False,
                "error": f"Cannot connect to Microsoft Planetary Computer.\n\nDiagnostics:\n{diagnostics_text}\n\nPossible causes:\n"
                         f"1. Firewall/proxy blocking HTTPS connections to planetarycomputer.microsoft.com\n"
                         f"2. Network DNS issues (cannot resolve domain name)\n"
                         f"3. VPN or corporate network restrictions\n"
                         f"4. SSL/TLS certificate issues\n"
                         f"5. Service temporarily unavailable\n\n"
                         f"To diagnose: Run 'python test_pc_connection.py' from your terminal",
                "count": 0,
                "images": [],
                "bbox": None,
                "year": request.year,
                "tile": mgrs_tile,
                "diagnostics": diagnostics
            }
        
        # Microsoft Planetary Computer STAC API endpoint
        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        search_url = f"{stac_url}/search"
        
        # Build the STAC search query - primarily using tile name from GeoJSON
        # Extent is optional and only used as additional filter if provided
        search_params = {
            "collections": ["sentinel-2-l2a"],
            "datetime": f"{start_date}/{end_date}",
            "limit": 200,  # Increased limit for more results
            "sortby": [{"field": "properties.datetime", "direction": "desc"}],
            "query": {"s2:mgrs_tile": {"eq": mgrs_tile}}
        }
        
        # Only add bbox filter if extent is provided (tile name is primary filter)
        bbox = None
        if request.extent:
            # Transform extent from EPSG:3857 to EPSG:4326 (WGS84)
            transformer = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
            minx, miny = transformer.transform(request.extent[0], request.extent[1])
            maxx, maxy = transformer.transform(request.extent[2], request.extent[3])
            bbox = [minx, miny, maxx, maxy]
            search_params["bbox"] = bbox
        
        # Make the request to STAC API with retry logic
        max_retries = 3
        retry_delay = 2  # seconds
        data = None
        
        # Add headers for Microsoft Planetary Computer API
        headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'MapExplorer/1.0'
        }
        
        # Debug: Print query details (first attempt only)
        print(f"Querying Microsoft Planetary Computer for tile: {mgrs_tile}, year: {request.year}")
        print(f"Query URL: {search_url}")
        print(f"Query params: {json.dumps(search_params, indent=2)}")
        
        for attempt in range(max_retries):
            print(f"Attempt {attempt + 1}/{max_retries}...")
            try:
                # Use 30 second timeout for query after connectivity check passes
                response = requests.post(search_url, json=search_params, headers=headers, timeout=30)
                response.raise_for_status()
                data = response.json()
                print(f"✓ Successfully received response with {len(data.get('features', []))} features")
                break  # Success, exit retry loop
            except requests.exceptions.HTTPError as e:
                # HTTP error responses (4xx, 5xx)
                response = e.response
                error_details = f"HTTP {response.status_code}"
                try:
                    error_body = response.json()
                    error_details += f": {error_body}"
                    print(f"HTTP Error Response: {error_details}")
                except:
                    error_details += f": {response.text[:200]}"
                    print(f"HTTP Error Response (non-JSON): {error_details}")
                
                if response.status_code == 429:
                    # Rate limited - wait longer before retry
                    if attempt < max_retries - 1:
                        wait_time = retry_delay * (2 ** attempt) * 2  # Longer wait for rate limiting
                        print(f"Rate limited (attempt {attempt + 1}/{max_retries}). Waiting {wait_time}s...")
                        time.sleep(wait_time)
                        continue
                
                # For other HTTP errors, don't retry
                return {
                    "success": False,
                    "error": f"HTTP Error from Microsoft Planetary Computer: {error_details}",
                    "count": 0,
                    "images": [],
                    "bbox": bbox,
                    "year": request.year,
                    "tile": mgrs_tile
                }
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout) as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)  # Exponential backoff
                    print(f"Connection timeout (attempt {attempt + 1}/{max_retries}). Retrying in {wait_time}s...")
                    print(f"Error details: {str(e)}")
                    time.sleep(wait_time)
                else:
                    # Last attempt failed
                    print(f"✗ Final timeout error: {str(e)}")
                    return {
                        "success": False,
                        "error": f"Connection to Microsoft Planetary Computer timed out after {max_retries} attempts (30s each). This usually indicates:\n"
                                f"1. Network connectivity issues or firewall blocking planetarycomputer.microsoft.com\n"
                                f"2. VPN/proxy configuration problems\n"
                                f"3. DNS resolution issues\n"
                                f"4. Service temporarily unavailable\n\n"
                                f"Try: Checking your internet connection, disabling VPN, or testing with: python test_pc_connection.py",
                        "count": 0,
                        "images": [],
                        "bbox": bbox,
                        "year": request.year,
                        "tile": mgrs_tile
                    }
            except requests.exceptions.RequestException as e:
                # Other request errors
                print(f"Request exception: {type(e).__name__}: {str(e)}")
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)
                    print(f"Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                else:
                    return {
                        "success": False,
                        "error": f"Failed to query Microsoft Planetary Computer: {type(e).__name__}: {str(e)}",
                        "count": 0,
                        "images": [],
                        "bbox": bbox,
                        "year": request.year,
                        "tile": mgrs_tile
                    }
        
        if data is None:
            return {
                "success": False,
                "error": "Failed to retrieve data from Microsoft Planetary Computer after multiple attempts.",
                "count": 0,
                "images": [],
                "bbox": bbox,
                "year": request.year,
                "tile": mgrs_tile
            }
        
        # Extract relevant metadata from features
        images = []
        for feature in data.get('features', []):
            properties = feature.get('properties', {})
            assets = feature.get('assets', {})
            
            # Get visual asset URL directly from assets['visual'].href
            visual_url = None
            if 'visual' in assets and assets.get('visual'):
                visual_url = assets['visual'].get('href', None)
            
            # Don't sign URLs during initial query - sign them on-demand when loading images
            
            # Get bbox from feature
            feature_bbox = feature.get('bbox')
            geometry = feature.get('geometry')
            
            # Calculate bbox from geometry if not present
            if not feature_bbox and geometry and geometry.get('type') == 'Polygon':
                coords = geometry.get('coordinates', [[]])[0]
                if coords:
                    lons = [coord[0] for coord in coords]
                    lats = [coord[1] for coord in coords]
                    feature_bbox = [min(lons), min(lats), max(lons), max(lats)]
            
            # Extract key metadata
            # Get MGRS tile from properties (s2:mgrs_tile) or parse from ID
            mgrs_tile = properties.get('s2:mgrs_tile') or properties.get('mgrs_tile')
            if not mgrs_tile:
                # Try to extract from image ID pattern: _T{TILE}_
                id_match = re.search(r'_T([A-Z0-9]{5})_', feature.get('id', ''))
                if id_match:
                    mgrs_tile = id_match.group(1)
            
            image_info = {
                "id": feature.get('id', 'N/A'),
                "datetime": properties.get('datetime', 'N/A'),
                "cloud_cover": properties.get('eo:cloud_cover', 0),
                "nodata percentage": properties.get('s2:nodata_pixel_percentage', 0),
                "platform": properties.get('platform', 'N/A'),
                "constellation": properties.get('constellation', 'N/A'),
                "instruments": properties.get('instruments', []),
                "gsd": properties.get('gsd', 'N/A'),  # Ground Sample Distance
                "proj_epsg": properties.get('proj:epsg', 'N/A'),
                "mgrs_tile": mgrs_tile,  # Add MGRS tile name
                "assets": list(assets.keys()),
                "thumbnail": assets.get('thumbnail', {}).get('href', None),
                "preview": assets.get('preview', {}).get('href', None),
                "visual_url": visual_url,  # Add visual asset URL
                "bbox": feature_bbox,  # Add bbox
            }
            
            images.append(image_info)
        
        return {
            "success": True,
            "count": len(images),
            "images": images,
            "bbox": bbox,
            "year": request.year,
        }
        
    except requests.exceptions.RequestException as e:
        return {"success": False, "error": f"Failed to query Planetary Computer: {str(e)}"}
    except Exception as e:
        return {"success": False, "error": f"Error: {str(e)}"}

@app.get("/sentinel2/test-connection")
async def test_planetary_computer_connection():
    """Test connectivity to Microsoft Planetary Computer API with detailed diagnostics"""
    
    try:
        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        host = "planetarycomputer.microsoft.com"
        results = {
            "timestamp": datetime.now().isoformat(),
            "environment": {},
            "network": {},
            "endpoints": {}
        }
        
        # Check environment variables
        results["environment"]["http_proxy"] = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or "Not set"
        results["environment"]["https_proxy"] = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "Not set"
        results["environment"]["no_proxy"] = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or "Not set"
        
        # Network diagnostics using the enhanced check function
        is_accessible, diagnostics = check_planetary_computer_accessible(timeout=10)
        results["network"]["accessibility"] = "Accessible" if is_accessible else "Not accessible"
        results["network"]["diagnostics"] = diagnostics
        
        if not is_accessible:
            return results
        
        # Test 1: Check if base endpoint is accessible
        try:
            response = requests.get(stac_url, timeout=10)
            results["endpoints"]["base"] = {
                "status": response.status_code,
                "accessible": response.status_code == 200
            }
            if response.status_code == 200:
                data = response.json()
                results["endpoints"]["base"]["stac_version"] = data.get("stac_version", "Unknown")
        except Exception as e:
            results["endpoints"]["base"] = {"error": str(e), "accessible": False}
        
        # Test 2: Try a simple collections query
        try:
            collections_url = f"{stac_url}/collections"
            response = requests.get(collections_url, timeout=10)
            if response.status_code == 200:
                collections_data = response.json()
                collections_count = len(collections_data.get('collections', []))
                sentinel2_found = any(c.get('id') == 'sentinel-2-l2a' for c in collections_data.get('collections', []))
                results["endpoints"]["collections"] = {
                    "status": response.status_code,
                    "collections_count": collections_count,
                    "sentinel2_l2a_found": sentinel2_found,
                    "accessible": True
                }
            else:
                results["endpoints"]["collections"] = {
                    "status": response.status_code,
                    "accessible": False
                }
        except Exception as e:
            results["endpoints"]["collections"] = {"error": str(e), "accessible": False}
        
        # Test 3: Try a minimal search query
        try:
            search_url = f"{stac_url}/search"
            test_params = {
                "collections": ["sentinel-2-l2a"],
                "limit": 1
            }
            headers = {'Content-Type': 'application/json', 'User-Agent': 'MapExplorer/1.0'}
            response = requests.post(search_url, json=test_params, headers=headers, timeout=10)
            if response.status_code == 200:
                search_data = response.json()
                features_count = len(search_data.get('features', []))
                results["endpoints"]["search"] = {
                    "status": response.status_code,
                    "features_count": features_count,
                    "accessible": True
                }
            else:
                results["endpoints"]["search"] = {
                    "status": response.status_code,
                    "response_text": response.text[:200],
                    "accessible": False
                }
        except Exception as e:
            results["endpoints"]["search"] = {"error": str(e), "error_type": type(e).__name__, "accessible": False}
        
        return results
    except Exception as e:
        return {"error": f"Test failed: {str(e)}", "error_type": type(e).__name__}

@app.get("/sentinel2/tile-coordinates/{tile_name}")
async def get_tile_coordinates(tile_name: str):
    """Get the center coordinates of a Sentinel-2 MGRS tile"""
    try:
        # Query STAC API to find a representative item from this tile
        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        search_url = f"{stac_url}/search"
        
        # Search for any recent item from this tile
        search_params = {
            "collections": ["sentinel-2-l2a"],
            "query": {"s2:mgrs_tile": {"eq": tile_name.upper()}},
            "limit": 1,
        }
        
        # Retry logic for connection timeout
        max_retries = 3
        retry_delay = 2
        data = None
        
        headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'MapExplorer/1.0'
        }
        
        for attempt in range(max_retries):
            try:
                response = requests.post(search_url, json=search_params, headers=headers, timeout=60)
                response.raise_for_status()
                data = response.json()
                break  # Success, exit retry loop
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout) as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)
                    print(f"Tile coordinates query timeout (attempt {attempt + 1}/{max_retries}). Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                else:
                    return {"error": f"Connection to Microsoft Planetary Computer timed out after {max_retries} attempts. Please check your internet connection."}
        
        if data is None:
            return {"error": "Failed to retrieve tile coordinates after multiple attempts."}
        features = data.get('features', [])
        
        if not features:
            return {"error": f"Tile {tile_name} not found"}
        
        # Get the geometry of the first feature and calculate centroid
        feature = features[0]
        geometry = feature.get('geometry', {})
        
        if geometry.get('type') == 'Polygon':
            coordinates = geometry.get('coordinates', [[]])[0]
            # Calculate centroid
            lons = [coord[0] for coord in coordinates]
            lats = [coord[1] for coord in coordinates]
            center_lon = sum(lons) / len(lons)
            center_lat = sum(lats) / len(lats)
            
            return {
                "tile": tile_name.upper(),
                "longitude": center_lon,
                "latitude": center_lat,
            }
        
        return {"error": f"Invalid geometry for tile {tile_name}"}
        
    except requests.exceptions.RequestException as e:
        return {"error": f"Failed to query tile: {str(e)}"}
    except Exception as e:
        return {"error": f"Error: {str(e)}"}

class GeolocationSearchRequest(BaseModel):
    latitude: float
    longitude: float

@app.post("/geolocation/search")
async def geolocation_search(request: GeolocationSearchRequest):
    """Search for a location using latitude and longitude coordinates"""
    try:
        lat = request.latitude
        lon = request.longitude
        
        # Validate coordinates
        if not (-90 <= lat <= 90):
            return {"error": "Latitude must be between -90 and 90 degrees"}
        
        if not (-180 <= lon <= 180):
            return {"error": "Longitude must be between -180 and 180 degrees"}
        
        return {
            "success": True,
            "latitude": lat,
            "longitude": lon,
        }
    except Exception as e:
        return {"error": f"Error: {str(e)}"}

@app.get("/geolocation/search")
async def geolocation_search_get(latitude: float, longitude: float):
    """Search for a location using latitude and longitude coordinates (GET endpoint)"""
    try:
        # Validate coordinates
        if not (-90 <= latitude <= 90):
            return {"error": "Latitude must be between -90 and 90 degrees"}
        
        if not (-180 <= longitude <= 180):
            return {"error": "Longitude must be between -180 and 180 degrees"}
        
        return {
            "success": True,
            "latitude": latitude,
            "longitude": longitude,
        }
    except Exception as e:
        return {"error": f"Error: {str(e)}"}

@app.options("/geolocation/search")
async def geolocation_search_options():
    """Handle CORS preflight for geolocation/search endpoint"""
    return {"message": "OK"}

class TileOffsetRequest(BaseModel):
    tile_name: str
    latitude: float
    longitude: float
    geometry_coordinates: Optional[List[List[List[float]]]] = None  # Optional: polygon coordinates from geometry

@app.post("/tile/offset")
async def get_tile_offset(request: TileOffsetRequest):
    """Calculate column and row offset of a point relative to a tile's bounding box"""
    try:
        lat = request.latitude
        lon = request.longitude
        
        # Validate coordinates
        if not (-90 <= lat <= 90):
            return {"error": "Latitude must be between -90 and 90 degrees"}
        
        if not (-180 <= lon <= 180):
            return {"error": "Longitude must be between -180 and 180 degrees"}
        
        # Get tile bounds from geometry if provided, otherwise query STAC API
        tile_bbox = None
        
        if request.geometry_coordinates:
            # Calculate bbox from geometry coordinates
            # geometry_coordinates should be a polygon: [[[lon, lat], [lon, lat], ...]]
            all_coords = []
            for ring in request.geometry_coordinates:
                for coord in ring:
                    if len(coord) >= 2:
                        all_coords.append(coord)
            
            if all_coords:
                lons = [c[0] for c in all_coords]
                lats = [c[1] for c in all_coords]
                tile_bbox = [min(lons), min(lats), max(lons), max(lats)]
        
        # If no geometry provided, query STAC API for tile bounds
        if not tile_bbox:
            stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
            search_url = f"{stac_url}/search"
            
            search_params = {
                "collections": ["sentinel-2-l2a"],
                "query": {"s2:mgrs_tile": {"eq": request.tile_name.upper()}},
                "limit": 1,
            }
            
            headers = {
                'Content-Type': 'application/json',
                'User-Agent': 'MapExplorer/1.0'
            }
            
            try:
                response = requests.post(search_url, json=search_params, headers=headers, timeout=30)
                response.raise_for_status()
                data = response.json()
                features = data.get('features', [])
                
                if features:
                    feature = features[0]
                    tile_bbox = feature.get('bbox')
                    geometry = feature.get('geometry', {})
                    
                    # Calculate bbox from geometry if not present
                    if not tile_bbox and geometry.get('type') == 'Polygon':
                        coords = geometry.get('coordinates', [[]])[0]
                        if coords:
                            lons = [coord[0] for coord in coords]
                            lats = [coord[1] for coord in coords]
                            tile_bbox = [min(lons), min(lats), max(lons), max(lats)]
            except Exception as e:
                return {"error": f"Failed to get tile bounds: {str(e)}"}
        
        if not tile_bbox or len(tile_bbox) != 4:
            return {"error": "Could not determine tile bounds"}
        
        # tile_bbox is [min_lon, min_lat, max_lon, max_lat]
        min_lon, min_lat, max_lon, max_lat = tile_bbox
        
        # Calculate offset (normalized 0-1, where 0 is at min and 1 is at max)
        # Column offset (x-axis, longitude)
        if max_lon != min_lon:
            column_offset_normalized = (lon - min_lon) / (max_lon - min_lon)
        else:
            column_offset_normalized = 0.5
        
        # Row offset (y-axis, latitude) - note: latitude decreases as we go south
        # In image coordinates, row 0 is typically at the top (max_lat), row max is at bottom (min_lat)
        if max_lat != min_lat:
            # Normalized from top (0) to bottom (1)
            row_offset_normalized = (max_lat - lat) / (max_lat - min_lat)
        else:
            row_offset_normalized = 0.5
        
        # Calculate offset in degrees
        column_offset_degrees = lon - min_lon
        row_offset_degrees = max_lat - lat  # Positive means offset from top
        
        # Calculate tile dimensions in degrees
        tile_width_degrees = max_lon - min_lon
        tile_height_degrees = max_lat - min_lat
        
        # Sentinel-2 tiles are approximately 109.8 km x 109.8 km
        # At 10m resolution, that's 10980 x 10980 pixels
        # We'll estimate pixel offsets based on this standard resolution
        # Note: Actual resolution may vary, but this gives a reasonable estimate
        standard_resolution_m = 10  # meters per pixel
        tile_size_m = 109800  # meters (109.8 km)
        pixels_per_tile = tile_size_m / standard_resolution_m  # 10980 pixels
        
        # Convert normalized offsets to pixel offsets
        column_offset_pixels = column_offset_normalized * pixels_per_tile
        row_offset_pixels = row_offset_normalized * pixels_per_tile
        
        return {
            "success": True,
            "tile_name": request.tile_name.upper(),
            "point": {
                "latitude": lat,
                "longitude": lon,
            },
            "tile_bounds": {
                "min_lon": min_lon,
                "min_lat": min_lat,
                "max_lon": max_lon,
                "max_lat": max_lat,
            },
            "offset": {
                "column_normalized": column_offset_normalized,
                "row_normalized": row_offset_normalized,
                "column_degrees": column_offset_degrees,
                "row_degrees": row_offset_degrees,
                "column_pixels": round(column_offset_pixels, 2),  # Estimated at 10m resolution
                "row_pixels": round(row_offset_pixels, 2),  # Estimated at 10m resolution
            },
            "tile_dimensions": {
                "width_degrees": tile_width_degrees,
                "height_degrees": tile_height_degrees,
                "estimated_pixels": pixels_per_tile,
            }
        }
    except Exception as e:
        return {"error": f"Error calculating offset: {str(e)}"}

@app.options("/tile/offset")
async def tile_offset_options():
    """Handle CORS preflight for tile/offset endpoint"""
    return {"message": "OK"}

# -------------------- Mosaic (low-res overview) --------------------
@app.get("/predictions/mosaic-url")
async def get_mosaic_url(year: int, rh_index: int = 98, q_index: int = 1):
    """Return the mosaic JSON URL for a given year/RH/Q combination.

    Env vars:
      - PREDICTIONS_MOSAIC_LOCAL_PATH : path template for local mosaic JSON files
        Placeholders: {year}, {rh}, {q}
        Example: /data/mosaic_{year}/rh{rh}_q{q}.mosaic.json
      - PREDICTIONS_MOSAIC_REMOTE_URL : URL template for remote mosaic JSON files
        Placeholders: {year}, {rh}, {q}
    """
    import os

    fmt = dict(year=year, rh=rh_index, q=q_index)

    if year == 2020:
        template = os.environ.get("PREDICTIONS_MOSAIC_LOCAL_PATH", "")
        if not template:
            return {"success": False, "error": "PREDICTIONS_MOSAIC_LOCAL_PATH env var is not set"}
        try:
            path = template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_MOSAIC_LOCAL_PATH: {e}"}
        if not os.path.isfile(path):
            return {"success": False, "error": f"Mosaic file not found: {path}"}
        return {"success": True, "url": path, "year": year, "source": "local"}
    else:
        template = os.environ.get("PREDICTIONS_MOSAIC_REMOTE_URL", "")
        if not template:
            return {"success": False, "error": "PREDICTIONS_MOSAIC_REMOTE_URL env var is not set"}
        try:
            url = template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_MOSAIC_REMOTE_URL: {e}"}
        return {"success": True, "url": url, "year": year, "source": "remote"}

# -------------------- Predictions (S3-like storage) --------------------
class PredictionsRequest(BaseModel):
    year: int
    tile_name: str
    rh_index: int
    q_index: int
    source: str = "blended"

@app.post("/predictions/load")
async def load_predictions(request: PredictionsRequest):
    """Load prediction data. Auto-selects local or remote based on the year.

    Local data (env vars):
      - PREDICTIONS_LOCAL_BASE_PATH : root directory on disk (e.g. /data/predictions)
      - PREDICTIONS_LOCAL_PATH_TEMPLATE : path under base, default "{tile}/RH{rh}_Q{q}.tif"
        Available placeholders: {zone}, {year}, {tile}, {rh}, {q}

    Remote data (env vars):
      - PREDICTIONS_BASE_URL : bucket / CDN URL (e.g. https://465001846.lumidata.eu/)
      - PREDICTIONS_REMOTE_PATH_TEMPLATE : path under base, default "{zone}-{year}/{tile}/RH{rh}_Q{q}.tif"
        Available placeholders: {zone}, {year}, {tile}, {rh}, {q}

    Returns a URL (local path or remote URL) for TiTiler to serve the COG file.
    """

    zone = request.tile_name[:3].lower()
    fmt = dict(zone=zone, year=request.year, tile=request.tile_name,
               rh=request.rh_index, q=request.q_index)

    # Debug: log request and env vars at request time
    print(f"[predictions/load] year={request.year} (type={type(request.year).__name__}), tile={request.tile_name}, source={request.source}")
    print(f"[predictions/load] PREDICTIONS_LOCAL_BASE_PATH = '{os.environ.get('PREDICTIONS_LOCAL_BASE_PATH', '')}'")

    # --- Route by year: 2020 → local disk, 2024 → remote URL ---
    if request.year == 2020:
        # LOCAL ONLY for 2020
        if request.source == "original":
            local_base = PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH
            if not local_base:
                return {"success": False, "error": "PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH env var is not set. Cannot load original 2020 data."}
        else:
            local_base = PREDICTIONS_LOCAL_BASE_PATH
            if not local_base:
                return {"success": False, "error": "PREDICTIONS_LOCAL_BASE_PATH env var is not set. Cannot load local 2020 data."}
        print(f"local_base: {local_base} (source={request.source})")
        local_template = PREDICTIONS_LOCAL_PATH_TEMPLATE
        try:
            local_rel = local_template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_LOCAL_PATH_TEMPLATE: {e}"}

        local_path = os.path.join(local_base, local_rel)
        if os.path.isfile(local_path):
            return {
                "success": True,
                "url": local_path,
                "tile_name": request.tile_name,
                "rh_index": request.rh_index,
                "q_index": request.q_index,
                "year": request.year,
                "source": "local",
            }
        else:
            return {"success": False, "error": f"Local file not found: {local_path}"}
    else:
        # REMOTE ONLY for 2024 (and any other year)
        base_url = PREDICTIONS_BASE_URL
        if not base_url:
            return {"success": False, "error": "PREDICTIONS_BASE_URL env var is not set. Cannot load remote data."}

        remote_template = PREDICTIONS_REMOTE_PATH_TEMPLATE
        try:
            remote_rel = remote_template.format(**fmt)
        except Exception as e:
            return {"success": False, "error": f"Invalid PREDICTIONS_REMOTE_PATH_TEMPLATE: {e}"}

        cog_url = base_url.rstrip("/") + "/" + remote_rel.lstrip("/")

        try:
            resp = requests.head(cog_url, timeout=10)
            resp.raise_for_status()

            return {
                "success": True,
                "url": cog_url,
                "tile_name": request.tile_name,
                "rh_index": request.rh_index,
                "q_index": request.q_index,
                "year": request.year,
                "source": "remote",
                "content_type": resp.headers.get("Content-Type", ""),
                "content_length": resp.headers.get("Content-Length", ""),
            }
        except requests.exceptions.RequestException as e:
            return {"success": False, "error": f"COG file not accessible: {str(e)}", "url": cog_url}
        except Exception as e:
            return {"success": False, "error": f"Unexpected error: {str(e)}", "url": cog_url}

@app.options("/predictions/load")
async def predictions_load_options():
    """Handle CORS preflight for predictions/load endpoint"""
    return {"message": "OK"}

# -------------------- Auxiliary data --------------------
class AuxiliaryTileRequest(BaseModel):
    tile_name: str

@app.post("/auxiliary/distance-map")
async def load_distance_map(request: AuxiliaryTileRequest):
    """Load a distance map GeoTIFF for a given MGRS tile.

    Env vars:
      - DISTANCE_MAPS_LOCAL_BASE_PATH : root directory containing {tile}.tif files
    """
    if not DISTANCE_MAPS_LOCAL_BASE_PATH:
        return {"success": False, "error": "DISTANCE_MAPS_LOCAL_BASE_PATH env var is not set."}

    local_path = os.path.join(DISTANCE_MAPS_LOCAL_BASE_PATH, f"{request.tile_name}.tif")
    print(f"[auxiliary/distance-map] tile={request.tile_name}, path={local_path}")

    if os.path.isfile(local_path):
        return {
            "success": True,
            "url": local_path,
            "tile_name": request.tile_name,
            "layer_type": "distance_map",
        }
    return {"success": False, "error": f"Distance map not found: {local_path}"}

@app.options("/auxiliary/distance-map")
async def auxiliary_distance_map_options():
    return {"message": "OK"}

@app.get("/predictions/info")
async def get_predictions_cog_info(tile_name: str, rh_index: int, q_index: int):
    """Get COG metadata via TiTiler for a prediction file"""
    import os
    base_url = os.environ.get("PREDICTIONS_BASE_URL")
    path_template = os.environ.get("PREDICTIONS_PATH_TEMPLATE", "{tile}/RH{rh}_Q{q}.tif")

    if not base_url:
        return {"success": False, "error": "PREDICTIONS_BASE_URL is not set on the server"}

    try:
        path = path_template.format(tile=tile_name, rh=rh_index, q=q_index)
        cog_url = base_url.rstrip("/") + "/" + path.lstrip("/")
        
        # Use TiTiler's info endpoint to get COG metadata
        # This avoids downloading the entire file
        info_url = f"http://localhost:8000/cog/info?url={quote(cog_url)}"
        resp = requests.get(info_url, timeout=30)
        resp.raise_for_status()
        
        info_data = resp.json()
        print('info: -------------')
        print(info_data)
        return {
            "success": True,
            "url": cog_url,
            "info": info_data,
            "tile_name": tile_name,
            "rh_index": rh_index,
            "q_index": q_index,
        }
    except Exception as e:
        return {"success": False, "error": f"Failed to get COG info: {str(e)}"}

@app.post("/sentinel2/sign-url")
async def sign_url(request: Dict[str, Any]):
    """Sign a Planetary Computer URL"""
    try:
        url = request.get('url')
        if not url:
            return {"error": "url is required"}
        
        signed_url = sign_planetary_computer_url(url)
        
        return {
            "signed_url": signed_url,
            "original_url": url,
        }
    except Exception as e:
        return {"error": f"Failed to sign URL: {str(e)}"}

@app.get("/sentinel2/proxy")
async def proxy_sentinel2_geotiff(url: str):
    """Proxy GeoTIFF requests with automatic URL signing"""
    try:
        # Sign the URL first
        signed_url = sign_planetary_computer_url(url)
        
        # Fetch the data
        response = requests.get(signed_url, timeout=30, stream=True)
        response.raise_for_status()
        
        # Return the data with appropriate headers
        from fastapi.responses import Response
        return Response(
            content=response.content,
            media_type=response.headers.get('content-type', 'image/tiff'),
            headers={
                'Access-Control-Allow-Origin': '*',
                'Content-Length': str(len(response.content)),
            }
        )
    except Exception as e:
        return {"error": f"Failed to proxy GeoTIFF: {str(e)}"}

@app.post("/sentinel2/load-image")
async def load_sentinel2_image(request: Dict[str, Any]):
    """Get signed URLs for Sentinel-2 image assets"""
    try:
        item_id = request.get('item_id')
        if not item_id:
            return {"error": "item_id is required"}
        
        # Query STAC API to get the item with retry logic
        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        item_url = f"{stac_url}/collections/sentinel-2-l2a/items/{item_id}"
        
        max_retries = 3
        retry_delay = 2
        item = None
        
        headers = {
            'User-Agent': 'MapExplorer/1.0'
        }
        
        for attempt in range(max_retries):
            try:
                response = requests.get(item_url, headers=headers, timeout=60)
                response.raise_for_status()
                item = response.json()
                break  # Success, exit retry loop
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout) as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)
                    print(f"Load image query timeout (attempt {attempt + 1}/{max_retries}). Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                else:
                    return {"error": f"Connection to Microsoft Planetary Computer timed out after {max_retries} attempts. Please check your internet connection."}
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    wait_time = retry_delay * (2 ** attempt)
                    print(f"Load image query error (attempt {attempt + 1}/{max_retries}): {str(e)}. Retrying in {wait_time}s...")
                    time.sleep(wait_time)
                else:
                    return {"error": f"Failed to load image from Microsoft Planetary Computer: {str(e)}"}
        
        if item is None:
            return {"error": "Failed to retrieve image item after multiple attempts."}
        assets = item.get('assets', {})
        
        # Get the visual asset URL directly from assets['visual'].href
        if 'visual' not in assets or not assets.get('visual'):
            return {"error": "No visual asset found for this item"}
        
        href = assets['visual'].get('href', '')
        print(f"Original href: {href}")
        # Sign the URL if it's from Planetary Computer
        signed_href = sign_planetary_computer_url(href)
        
        # Get bbox from item geometry or properties
        bbox = item.get('bbox')
        geometry = item.get('geometry')
        
        # If no bbox, try to calculate from geometry
        if not bbox and geometry and geometry.get('type') == 'Polygon':
            coords = geometry.get('coordinates', [[]])[0]
            if coords:
                lons = [coord[0] for coord in coords]
                lats = [coord[1] for coord in coords]
                bbox = [min(lons), min(lats), max(lons), max(lats)]
        
        return {
            "item_id": item_id,
            "url": signed_href,
            "title": f"Sentinel-2 {item_id}",
            "datetime": item.get('properties', {}).get('datetime', ''),
            "bbox": bbox,
        }
        
    except requests.exceptions.RequestException as e:
        return {"error": f"Failed to load image: {str(e)}"}
    except Exception as e:
        return {"error": f"Error: {str(e)}"}