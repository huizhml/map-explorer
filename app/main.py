from pathlib import Path
import os
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

try:
    # Optional dependency: titiler mosaic factory
    from titiler.mosaic import factory as mosaic_factory  # type: ignore
except Exception:  # pragma: no cover - allow running without titiler installed yet
    mosaic_factory = None  # type: ignore

try:
    # Optional dependency: titiler-xarray
    from titiler.xarray import factory as xarray_factory  # type: ignore
except Exception:  # pragma: no cover
    xarray_factory = None  # type: ignore


API_PREFIX = "/api/v1"


def get_mosaic_dir() -> Path:
    # Directory containing rh1.mosaic.json ... rh100.mosaic.json
    default_dir = Path(os.environ.get("MOSAIC_DIR", "~/data/GVS/Deploy/mosaic_2020")).expanduser()
    return default_dir


def rh_to_mosaic_path(rh_value: int) -> Path:
    mosaic_dir = get_mosaic_dir()
    return mosaic_dir / f"rh{rh_value}.mosaic.json"


app = FastAPI(title="Map Explorer Backend")

# CORS for local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Optionally mount Titiler MosaicJSON endpoints if available
if mosaic_factory is not None:
    mosaic = mosaic_factory.MosaicTilerFactory()
    app.include_router(mosaic.router, prefix="/mosaicjson", tags=["MosaicJSON"])  # type: ignore

if xarray_factory is not None:
    xarray = xarray_factory.XarrayTilerFactory()  # type: ignore
    app.include_router(xarray.router, prefix="/xarray", tags=["Xarray"])  # type: ignore


@app.get(f"{API_PREFIX}/rh/{{rh}}/tile-url")
def get_rh_tile_url(rh: int):
    if rh < 0 or rh > 100:
        raise HTTPException(status_code=400, detail="rh must be between 0 and 100")

    mosaic_path = rh_to_mosaic_path(rh)
    if not mosaic_path.exists():
        raise HTTPException(status_code=404, detail=f"Mosaic not found for rh{rh}: {mosaic_path}")

    # Build a titiler XYZ URL template. Frontend will fetch only tiles in view.
    # We URL-encode the file:// path to be safe in query string.
    encoded = quote(f"file://{mosaic_path}", safe="")
    # Note: Adjust rescale/colormap as needed.
    tile_url = (
        f"http://localhost:8006/mosaicjson/tiles/{{z}}/{{x}}/{{y}}@1x?url={encoded}"
    )

    return {"tile_url": tile_url}


@app.get(f"{API_PREFIX}/rh/available")
def list_available_rh():
    mosaic_dir = get_mosaic_dir()
    available = []
    for i in range(0, 101):
        if (mosaic_dir / f"rh{i}.mosaic.json").exists():
            available.append(i)
    return {"available": available}


@app.get(f"{API_PREFIX}/xarray/tile-url")
def get_xarray_tile_url(
    url: str,
    variable: str,
    lon: str = "lon",
    lat: str = "lat",
    rescale: str | None = None,
    colormap_name: str | None = None,
):
    """Return XYZ URL template for an xarray-readable dataset.

    Parameters
    - url: path or URL to dataset (local file path allowed)
    - variable: data variable to render
    - lon/lat: coordinate variable names
    - rescale: e.g. "0,60"
    - colormap_name: e.g. "viridis"
    """
    ds_url = url
    if not (ds_url.startswith("http://") or ds_url.startswith("https://") or ds_url.startswith("s3://") or ds_url.startswith("file://")):
        ds_url = f"file://{os.path.abspath(ds_url)}"

    encoded = quote(ds_url, safe="")
    base = f"http://localhost:8006/xarray/tiles/{{z}}/{{x}}/{{y}}?url={encoded}&variable={quote(variable)}&lon={quote(lon)}&lat={quote(lat)}"

    params = []
    if rescale:
        params.append(f"rescale={quote(rescale)}")
    if colormap_name:
        params.append(f"colormap_name={quote(colormap_name)}")
    if params:
        base = base + "&" + "&".join(params)

    return {"tile_url": base}


