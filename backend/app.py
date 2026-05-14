"""Canopy-height Map Explorer — FastAPI application.

Slim entrypoint: TiTiler COG/Mosaic factories, CORS middleware,
exception handler, and router includes for all API endpoints.
"""

from fastapi import FastAPI
from titiler.core.factory import TilerFactory
from titiler.mosaic.factory import MosaicTilerFactory
from titiler.extensions import cogViewerExtension
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from fastapi.responses import Response
from rio_tiler.errors import TileOutsideBounds
import io
import os
from PIL import Image

from routes.sentinel2 import router as sentinel2_router
from routes.predictions import router as predictions_router
from routes.auxiliary import router as auxiliary_router
from routes.geo import router as geo_router
from routes.saved_features import router as saved_features_router, init_saved_features_db
from routes.earthengine import router as earthengine_router

# ---------------------------------------------------------------------------
# Startup env-var logging
# ---------------------------------------------------------------------------

_ENV_KEYS = [
    "PREDICTIONS_LOCAL_PATH", "PREDICTIONS_MOSAIC_LOCAL_PATH",
    "PREDICTIONS_BASE_URL", "PREDICTIONS_REMOTE_PATH_TEMPLATE",
    "PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE",
    "DISTANCE_MAPS_LOCAL_BASE_PATH", "S2_GRID_LOCAL_PATH",
    "CR_LOCAL_BASE_PATH",
    "DIVERSITY_INDICES_LOCAL_PATH", "ALS_LOCAL_PATH",
    "GEDI_LOCAL_BASE_PATH",
    "SAVED_FEATURE_IMAGES_ROOT",
    "NATURALNESS_REF_DATA_PATH",
    "NATURALNESS_REF_DATA_VAL_PATH",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "EE_CREDENTIALS_PATH",
]
print("=== Env vars ===")
for k in _ENV_KEYS:
    print(f"  {k} = {os.environ.get(k, '')}")
print("================")

# ---------------------------------------------------------------------------
# CORS middleware
# ---------------------------------------------------------------------------

class CustomCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS":
            return Response(
                status_code=200,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Expose-Headers": "*",
                    "Access-Control-Max-Age": "3600",
                },
            )
        try:
            response = await call_next(request)
        except Exception as exc:
            # Without this, Starlette's outer ServerErrorMiddleware synthesizes a
            # 500 that lacks our CORS headers, so the browser surfaces a useless
            # "Failed to fetch" instead of the real status. Re-raise after logging
            # so the traceback still hits the console.
            import traceback
            print(f"[CORS middleware] unhandled exception on {request.method} {request.url.path}: {exc}")
            traceback.print_exc()
            response = Response(
                content=f"Internal Server Error: {exc}",
                status_code=500,
                media_type="text/plain",
            )
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"
        response.headers["Access-Control-Expose-Headers"] = "*"
        return response

# ---------------------------------------------------------------------------
# App + middleware + TiTiler factories
# ---------------------------------------------------------------------------

app = FastAPI(title="Canopy Height – TiTiler with Mosaic + Viewer")
app.add_middleware(CustomCORSMiddleware)
init_saved_features_db()

cog = TilerFactory(extensions=[cogViewerExtension()])
app.include_router(cog.router, prefix="/cog", tags=["cog"])

mosaic = MosaicTilerFactory()
app.include_router(mosaic.router, tags=["mosaicjson"])

# ---------------------------------------------------------------------------
# Exception handler — transparent tile for out-of-bounds
# ---------------------------------------------------------------------------

@app.exception_handler(TileOutsideBounds)
async def tile_outside_bounds_handler(request: Request, exc: TileOutsideBounds):
    img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600"},
    )

# ---------------------------------------------------------------------------
# Health / deploy status
# ---------------------------------------------------------------------------

@app.get("/deploy/status")
async def get_deploy_status():
    return {"message": "Hello World"}

# ---------------------------------------------------------------------------
# Route modules
# ---------------------------------------------------------------------------

app.include_router(sentinel2_router)
app.include_router(predictions_router)
app.include_router(auxiliary_router)
app.include_router(geo_router)
app.include_router(saved_features_router)
app.include_router(earthengine_router, prefix="/api/v1")
