"""Sentinel-2 query, signing, proxy, and image loading endpoints."""

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from pyproj import Transformer
import requests
import re
import time
import os
from datetime import datetime

router = APIRouter(prefix="/sentinel2", tags=["sentinel2"])

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sign_planetary_computer_url(url: str) -> str:
    if not url:
        return url

    needs_signing = (
        "blob.core.windows.net" in url
        or "planetarycomputer.microsoft.com" in url
    )
    if not needs_signing:
        return url

    try:
        signing_url = "https://planetarycomputer.microsoft.com/api/sas/v1/sign"
        max_retries = 3
        retry_delay = 1
        signed_url = url

        for attempt in range(max_retries):
            try:
                response = requests.get(signing_url, params={"href": url}, timeout=30)
                response.raise_for_status()
                signed_data = response.json()
                signed_url = signed_data.get("href", url)
                break
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout):
                if attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt))
                else:
                    return url
            except requests.exceptions.RequestException:
                if attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt))
                else:
                    return url

        if signed_url != url:
            has_sas = any(p in signed_url for p in ["sig=", "se=", "sv=", "sp="])
            if has_sas:
                print(f"Successfully signed URL (length: {len(signed_url)})")
            return signed_url
        return url
    except Exception as e:
        print(f"Error signing URL: {e}")
        import traceback
        traceback.print_exc()
        return url


def _get_socket_error_message(error_code: int) -> str:
    error_messages = {
        35: "Resource temporarily unavailable (EAGAIN)",
        61: "Connection refused (ECONNREFUSED)",
        51: "Network is unreachable (ENETUNREACH)",
        64: "Host is down (EHOSTDOWN)",
        65: "No route to host (EHOSTUNREACH)",
        113: "No route to host (EHOSTUNREACH)",
        111: "Connection refused",
    }
    try:
        import errno
        errno_name = errno.errorcode.get(error_code, f"UNKNOWN({error_code})")
    except Exception:
        errno_name = f"ERROR({error_code})"
    return error_messages.get(error_code, f"{errno_name}: TCP connection failed")


def _check_planetary_computer_accessible(timeout: int = 5):
    import socket

    host = "planetarycomputer.microsoft.com"
    port = 443
    stac_url = f"https://{host}/api/stac/v1"
    diagnostics: list[str] = []

    try:
        ip = socket.gethostbyname(host)
        diagnostics.append(f"✓ DNS resolved: {host} -> {ip}")
    except socket.gaierror as e:
        diagnostics.append(f"✗ DNS resolution failed: {e}")
        return False, diagnostics
    except Exception as e:
        diagnostics.append(f"✗ DNS check error: {type(e).__name__}: {e}")

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        result = sock.connect_ex((host, port))
        sock.close()
        if result == 0:
            diagnostics.append(f"✓ TCP connection to {host}:{port} successful")
        else:
            diagnostics.append(f"✗ TCP connection failed: {_get_socket_error_message(result)}")
            return False, diagnostics
    except socket.timeout:
        diagnostics.append(f"✗ TCP connection timeout to {host}:{port}")
        return False, diagnostics
    except Exception as e:
        diagnostics.append(f"✗ TCP connection error: {type(e).__name__}: {e}")
        return False, diagnostics

    try:
        response = requests.get(stac_url, timeout=timeout, verify=True)
        if response.status_code == 200:
            diagnostics.append(f"✓ HTTP request successful: Status {response.status_code}")
            return True, diagnostics
        diagnostics.append(f"⚠ HTTP request returned status {response.status_code}")
        return False, diagnostics
    except Exception as e:
        diagnostics.append(f"✗ Request error: {type(e).__name__}: {e}")
        return False, diagnostics


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class Sentinel2QueryRequest(BaseModel):
    extent: Optional[List[float]] = None
    year: int
    mgrs_tile: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.options("/query")
async def query_sentinel2_options():
    return {"message": "OK"}


@router.post("/query")
async def query_sentinel2(request: Sentinel2QueryRequest):
    try:
        start_date = f"{request.year}-01-01T00:00:00Z"
        end_date = f"{request.year}-12-31T23:59:59Z"
        mgrs_tile = request.mgrs_tile

        print(f"Checking connectivity to Microsoft Planetary Computer...")
        is_accessible, diagnostics = _check_planetary_computer_accessible(timeout=5)
        if not is_accessible:
            diagnostics_text = "\n".join(diagnostics) if diagnostics else "Connection test failed"
            return {
                "success": False,
                "error": f"Cannot connect to Microsoft Planetary Computer.\n\nDiagnostics:\n{diagnostics_text}",
                "count": 0, "images": [], "bbox": None,
                "year": request.year, "tile": mgrs_tile, "diagnostics": diagnostics,
            }

        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        search_url = f"{stac_url}/search"

        search_params: dict = {
            "collections": ["sentinel-2-l2a"],
            "datetime": f"{start_date}/{end_date}",
            "limit": 200,
            "sortby": [{"field": "properties.datetime", "direction": "desc"}],
            "query": {"s2:mgrs_tile": {"eq": mgrs_tile}},
        }

        bbox = None
        if request.extent:
            transformer = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
            minx, miny = transformer.transform(request.extent[0], request.extent[1])
            maxx, maxy = transformer.transform(request.extent[2], request.extent[3])
            bbox = [minx, miny, maxx, maxy]
            search_params["bbox"] = bbox

        headers = {"Content-Type": "application/json", "User-Agent": "MapExplorer/1.0"}
        max_retries, retry_delay, data = 3, 2, None

        for attempt in range(max_retries):
            try:
                response = requests.post(search_url, json=search_params, headers=headers, timeout=30)
                response.raise_for_status()
                data = response.json()
                break
            except requests.exceptions.HTTPError as e:
                resp = e.response
                if resp.status_code == 429 and attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt) * 2)
                    continue
                try:
                    detail = str(resp.json())
                except Exception:
                    detail = resp.text[:200]
                return {"success": False, "error": f"HTTP {resp.status_code}: {detail}", "count": 0, "images": [], "bbox": bbox, "year": request.year, "tile": mgrs_tile}
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout):
                if attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt))
                else:
                    return {"success": False, "error": "Connection timed out", "count": 0, "images": [], "bbox": bbox, "year": request.year, "tile": mgrs_tile}
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt))
                else:
                    return {"success": False, "error": str(e), "count": 0, "images": [], "bbox": bbox, "year": request.year, "tile": mgrs_tile}

        if data is None:
            return {"success": False, "error": "No data after retries", "count": 0, "images": [], "bbox": bbox, "year": request.year, "tile": mgrs_tile}

        images = []
        for feature in data.get("features", []):
            props = feature.get("properties", {})
            assets = feature.get("assets", {})
            visual_url = assets.get("visual", {}).get("href") if "visual" in assets else None
            feature_bbox = feature.get("bbox")
            geometry = feature.get("geometry")
            if not feature_bbox and geometry and geometry.get("type") == "Polygon":
                coords = geometry.get("coordinates", [[]])[0]
                if coords:
                    lons = [c[0] for c in coords]
                    lats = [c[1] for c in coords]
                    feature_bbox = [min(lons), min(lats), max(lons), max(lats)]

            tile = props.get("s2:mgrs_tile") or props.get("mgrs_tile")
            if not tile:
                m = re.search(r"_T([A-Z0-9]{5})_", feature.get("id", ""))
                if m:
                    tile = m.group(1)

            images.append({
                "id": feature.get("id", "N/A"),
                "datetime": props.get("datetime", "N/A"),
                "cloud_cover": props.get("eo:cloud_cover", 0),
                "nodata percentage": props.get("s2:nodata_pixel_percentage", 0),
                "platform": props.get("platform", "N/A"),
                "constellation": props.get("constellation", "N/A"),
                "instruments": props.get("instruments", []),
                "gsd": props.get("gsd", "N/A"),
                "proj_epsg": props.get("proj:epsg", "N/A"),
                "mgrs_tile": tile,
                "assets": list(assets.keys()),
                "thumbnail": assets.get("thumbnail", {}).get("href"),
                "preview": assets.get("preview", {}).get("href"),
                "visual_url": visual_url,
                "bbox": feature_bbox,
            })

        return {"success": True, "count": len(images), "images": images, "bbox": bbox, "year": request.year}
    except requests.exceptions.RequestException as e:
        return {"success": False, "error": f"Failed to query Planetary Computer: {e}"}
    except Exception as e:
        return {"success": False, "error": f"Error: {e}"}


@router.get("/test-connection")
async def test_planetary_computer_connection():
    try:
        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        results: dict = {
            "timestamp": datetime.now().isoformat(),
            "environment": {
                "http_proxy": os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or "Not set",
                "https_proxy": os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "Not set",
                "no_proxy": os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or "Not set",
            },
            "network": {},
            "endpoints": {},
        }

        is_accessible, diagnostics = _check_planetary_computer_accessible(timeout=10)
        results["network"]["accessibility"] = "Accessible" if is_accessible else "Not accessible"
        results["network"]["diagnostics"] = diagnostics
        if not is_accessible:
            return results

        try:
            resp = requests.get(stac_url, timeout=10)
            results["endpoints"]["base"] = {"status": resp.status_code, "accessible": resp.status_code == 200}
            if resp.status_code == 200:
                results["endpoints"]["base"]["stac_version"] = resp.json().get("stac_version", "Unknown")
        except Exception as e:
            results["endpoints"]["base"] = {"error": str(e), "accessible": False}

        try:
            resp = requests.get(f"{stac_url}/collections", timeout=10)
            if resp.status_code == 200:
                colls = resp.json().get("collections", [])
                results["endpoints"]["collections"] = {
                    "status": 200, "collections_count": len(colls),
                    "sentinel2_l2a_found": any(c.get("id") == "sentinel-2-l2a" for c in colls),
                    "accessible": True,
                }
            else:
                results["endpoints"]["collections"] = {"status": resp.status_code, "accessible": False}
        except Exception as e:
            results["endpoints"]["collections"] = {"error": str(e), "accessible": False}

        try:
            resp = requests.post(f"{stac_url}/search", json={"collections": ["sentinel-2-l2a"], "limit": 1}, headers={"Content-Type": "application/json", "User-Agent": "MapExplorer/1.0"}, timeout=10)
            if resp.status_code == 200:
                results["endpoints"]["search"] = {"status": 200, "features_count": len(resp.json().get("features", [])), "accessible": True}
            else:
                results["endpoints"]["search"] = {"status": resp.status_code, "accessible": False}
        except Exception as e:
            results["endpoints"]["search"] = {"error": str(e), "accessible": False}

        return results
    except Exception as e:
        return {"error": f"Test failed: {e}"}


@router.get("/tile-coordinates/{tile_name}")
async def get_tile_coordinates(tile_name: str):
    try:
        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        search_params = {"collections": ["sentinel-2-l2a"], "query": {"s2:mgrs_tile": {"eq": tile_name.upper()}}, "limit": 1}
        headers = {"Content-Type": "application/json", "User-Agent": "MapExplorer/1.0"}
        max_retries, retry_delay, data = 3, 2, None

        for attempt in range(max_retries):
            try:
                response = requests.post(f"{stac_url}/search", json=search_params, headers=headers, timeout=60)
                response.raise_for_status()
                data = response.json()
                break
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout):
                if attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt))
                else:
                    return {"error": "Connection timed out"}

        if data is None:
            return {"error": "Failed to retrieve tile coordinates"}
        features = data.get("features", [])
        if not features:
            return {"error": f"Tile {tile_name} not found"}

        geometry = features[0].get("geometry", {})
        if geometry.get("type") == "Polygon":
            coords = geometry.get("coordinates", [[]])[0]
            lons = [c[0] for c in coords]
            lats = [c[1] for c in coords]
            return {"tile": tile_name.upper(), "longitude": sum(lons) / len(lons), "latitude": sum(lats) / len(lats)}
        return {"error": f"Invalid geometry for tile {tile_name}"}
    except Exception as e:
        return {"error": str(e)}


@router.post("/sign-url")
async def sign_url(request: Dict[str, Any]):
    try:
        url = request.get("url")
        if not url:
            return {"error": "url is required"}
        return {"signed_url": sign_planetary_computer_url(url), "original_url": url}
    except Exception as e:
        return {"error": f"Failed to sign URL: {e}"}


@router.get("/proxy")
async def proxy_sentinel2_geotiff(url: str):
    try:
        signed_url = sign_planetary_computer_url(url)
        response = requests.get(signed_url, timeout=30, stream=True)
        response.raise_for_status()
        return Response(
            content=response.content,
            media_type=response.headers.get("content-type", "image/tiff"),
            headers={"Access-Control-Allow-Origin": "*", "Content-Length": str(len(response.content))},
        )
    except Exception as e:
        return {"error": f"Failed to proxy GeoTIFF: {e}"}


@router.post("/load-image")
async def load_sentinel2_image(request: Dict[str, Any]):
    try:
        item_id = request.get("item_id")
        if not item_id:
            return {"error": "item_id is required"}

        stac_url = "https://planetarycomputer.microsoft.com/api/stac/v1"
        item_url = f"{stac_url}/collections/sentinel-2-l2a/items/{item_id}"
        headers = {"User-Agent": "MapExplorer/1.0"}
        max_retries, retry_delay, item = 3, 2, None

        for attempt in range(max_retries):
            try:
                response = requests.get(item_url, headers=headers, timeout=60)
                response.raise_for_status()
                item = response.json()
                break
            except (requests.exceptions.Timeout, requests.exceptions.ConnectTimeout):
                if attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt))
                else:
                    return {"error": "Connection timed out"}
            except requests.exceptions.RequestException as e:
                if attempt < max_retries - 1:
                    time.sleep(retry_delay * (2 ** attempt))
                else:
                    return {"error": str(e)}

        if item is None:
            return {"error": "Failed to retrieve image item"}
        assets = item.get("assets", {})
        if "visual" not in assets:
            return {"error": "No visual asset found"}

        href = assets["visual"].get("href", "")
        signed_href = sign_planetary_computer_url(href)

        bbox = item.get("bbox")
        geometry = item.get("geometry")
        if not bbox and geometry and geometry.get("type") == "Polygon":
            coords = geometry.get("coordinates", [[]])[0]
            if coords:
                lons = [c[0] for c in coords]
                lats = [c[1] for c in coords]
                bbox = [min(lons), min(lats), max(lons), max(lats)]

        return {
            "item_id": item_id, "url": signed_href,
            "title": f"Sentinel-2 {item_id}",
            "datetime": item.get("properties", {}).get("datetime", ""),
            "bbox": bbox,
        }
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Cloud-free true-colour image of a small window (the 3D cube's ground)
# ---------------------------------------------------------------------------

import base64 as _b64
import json
import io as _io
import threading as _threading
from collections import OrderedDict as _OrderedDict
from concurrent.futures import ThreadPoolExecutor as _Pool

_PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
_PC_TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a"
_CLOUDY_SCL = (3, 8, 9, 10)  # cloud shadow, cloud medium / high, cirrus
_MAX_WINDOW_M = 5000  # larger requests are not a cube window
_window_cache: "_OrderedDict[tuple, dict]" = _OrderedDict()
_window_lock = _threading.Lock()
_token: Dict[str, Any] = {"value": None, "until": 0.0}


_token_lock = _threading.Lock()


def _pc_token() -> str:
    """One SAS token for the whole collection, instead of one signing call per
    file. Locked: the parallel scene checks would otherwise all ask at once and
    be rate-limited (HTTP 429)."""
    with _token_lock:
        if _token["value"] and time.time() < _token["until"] - 120:
            return _token["value"]
        return _fetch_token()


def _fetch_token() -> str:
    # The token endpoint rate-limits (HTTP 429): back off rather than fail.
    for attempt in range(5):
        r = requests.get(_PC_TOKEN, timeout=30)
        if r.status_code != 429:
            break
        time.sleep(float(r.headers.get("Retry-After", 2 ** attempt)))
    r.raise_for_status()
    body = r.json()
    _token["value"] = body["token"]
    try:
        _token["until"] = datetime.fromisoformat(body["msft:expiry"].replace("Z", "+00:00")).timestamp()
    except Exception:
        _token["until"] = time.time() + 1800
    return _token["value"]


def _warp_window(href: str, crs: str, bounds, size: int, resampling):
    """Any raster, read into the window (crs, bounds) at size x size px, north up."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import reproject, transform_bounds
    from rasterio.windows import Window, from_bounds as win_from_bounds

    with rasterio.open(f"{href}?{_pc_token()}") as src:
        sb = transform_bounds(crs, src.crs, *bounds)
        w = win_from_bounds(*sb, src.transform).round_offsets().round_lengths()
        w = Window(max(w.col_off - 8, 0), max(w.row_off - 8, 0), w.width + 16, w.height + 16)
        data = src.read(window=w)
        src_tf = src.window_transform(w)
        out = np.zeros((data.shape[0], size, size), data.dtype)
        dst_tf = from_bounds(*bounds, size, size)
        for b in range(data.shape[0]):
            reproject(data[b], out[b], src_transform=src_tf, src_crs=src.crs,
                      dst_transform=dst_tf, dst_crs=crs, resampling=resampling)
    return out


def _display_stretch(rgb):
    """TCI maps reflectance 0-0.2 to 0-255, so a forest is near-black. For display
    only: one plain gain for the three bands, x3, so windows of different places
    are equally bright and comparable. Lowered where the window is bright
    (bare soil, fields) so its 99th percentile stays at 200 and does not clip.
    Percentile stretches looked over-bright and over-saturated on forest (user,
    2026-10-29)."""
    import numpy as np

    gain = min(3.0, 200.0 / max(float(np.percentile(rgb, 99)), 1.0))
    return np.clip(rgb * gain, 0, 255)


@router.get("/window-image")
def sentinel2_window_image(crs: str, bounds: str, year: int, size: int = 512):
    """The least cloudy Sentinel-2 L2A scene of `year` that is cloud-free over the
    window, as a true-colour JPEG warped onto the window (row 0 = north edge).

    Used under the explorer's 3D cube: the same year as the VSM data, unlike the
    undated high-resolution basemaps. Outside the tropics the leaf-on season
    (around day 200) is preferred, so a deciduous forest is not shown bare.
    Scenes are checked on their SCL (scene classification) band; if none is
    entirely clear, the clearest one is returned and `cloud_fraction` says so.
    """
    import numpy as np
    from PIL import Image
    from rasterio.warp import Resampling, transform_bounds

    try:
        b = [float(v) for v in bounds.split(",")]
        assert len(b) == 4 and b[2] > b[0] and b[3] > b[1]
    except Exception:
        return Response('{"error": "bounds must be left,bottom,right,top"}', status_code=400, media_type="application/json")
    if b[2] - b[0] > _MAX_WINDOW_M or b[3] - b[1] > _MAX_WINDOW_M:
        return Response('{"error": "window too large"}', status_code=400, media_type="application/json")
    size = max(64, min(1024, int(size)))
    key = (crs, tuple(round(v, 2) for v in b), year, size)
    with _window_lock:
        if key in _window_cache:
            _window_cache.move_to_end(key)
            return _window_cache[key]

    lon0, lat0, lon1, lat1 = transform_bounds(crs, "EPSG:4326", *b)
    r = requests.post(_PC_STAC, json={
        "collections": ["sentinel-2-l2a"], "bbox": [lon0, lat0, lon1, lat1],
        "datetime": f"{year}-01-01T00:00:00Z/{year}-12-31T23:59:59Z",
        "query": {"eo:cloud_cover": {"lt": 60}}, "limit": 200,
    }, headers={"User-Agent": "MapExplorer/1.0"}, timeout=60)
    r.raise_for_status()
    temperate = abs((lat0 + lat1) / 2) > 30

    def order(f):
        p = f["properties"]
        doy = datetime.fromisoformat(p["datetime"][:10]).timetuple().tm_yday
        return (abs(doy - 200) // 30, p["eo:cloud_cover"]) if temperate else (p["eo:cloud_cover"], 0)

    items = sorted(r.json().get("features", []), key=order)[:24]
    if not items:
        return Response('{"error": "no Sentinel-2 scene in that year"}', status_code=404, media_type="application/json")

    def check(item):
        try:
            scl = _warp_window(item["assets"]["SCL"]["href"], crs, b, 64, Resampling.nearest)[0]
            return float(np.isin(scl, _CLOUDY_SCL).mean() + (scl == 0).mean())
        except Exception as ex:
            print(f"[s2-window] SCL read failed for {item.get('id')}: {ex}")
            return 1.0

    try:
        _pc_token()  # once, before the parallel checks share it
    except Exception as ex:
        return Response(json.dumps({"error": f"Planetary Computer token unavailable: {ex}"}),
                        status_code=503, media_type="application/json")

    # Check in parallel, take the first clear scene in preference order.
    with _Pool(max_workers=8) as pool:
        bad = list(pool.map(check, items))
    best = next((i for i, f in enumerate(bad) if f == 0), int(np.argmin(bad)))
    item = items[best]
    rgb = _warp_window(item["assets"]["visual"]["href"], crs, b, size, Resampling.bilinear)[:3].astype("float32")
    rgb = _display_stretch(rgb)
    buf = _io.BytesIO()
    Image.fromarray(rgb.transpose(1, 2, 0).astype("uint8")).save(buf, format="JPEG", quality=88)
    out = {
        "image": "data:image/jpeg;base64," + _b64.b64encode(buf.getvalue()).decode(),
        "date": item["properties"]["datetime"][:10],
        "scene": item["id"],
        "cloud_fraction": round(bad[best], 4),
        "stretch": "gain x3 for all bands (less where the 99th percentile would pass 200)",
    }
    with _window_lock:
        _window_cache[key] = out
        while len(_window_cache) > 32:
            _window_cache.popitem(last=False)
    return out
