"""Entry point for a **Gradio-SDK** Space (copy to the Space root as `app.py`).

A Gradio Space has no Dockerfile and no entrypoint script: HF installs
`requirements.txt` and runs `app.py`. Everything `deploy/docker/entrypoint.sh`
does — materialise the EE secret, point at the baked-in read-only state, set the
GDAL/matplotlib env — therefore has to happen here, in Python, *before* the
backend is imported (several route modules read `os.environ` at import time).

Gradio is itself a FastAPI application, so the real backend is served as-is and a
one-page Gradio landing block is mounted at `/` purely so the Space embed shows
something instead of a 404.
"""

from __future__ import annotations

import os
import pathlib
import sys

APP_DIR = pathlib.Path(__file__).resolve().parent

# --- env, before any backend import ----------------------------------------

# Matplotlib picks its backend at import; Agg is the only headless-safe choice.
os.environ.setdefault("MPLBACKEND", "Agg")

# /vsicurl tuning, mirroring the ENV block in deploy/docker/Dockerfile. Without
# DISABLE_READDIR_ON_OPEN, GDAL issues a bucket LIST on every COG open, which
# dominates tile latency against source.coop.
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("GDAL_INGESTED_BYTES_AT_OPEN", "32768")
os.environ.setdefault("GDAL_CACHEMAX", "256")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", "536870912")

# Baked-in read-only state.
os.environ.setdefault("SAVED_FEATURES_DB_PATH", str(APP_DIR / "deploy/data/saved_features.db"))
os.environ.setdefault("SAVED_FEATURE_IMAGES_ROOT", str(APP_DIR / "deploy/data/saved_feature_images"))

# ee.ServiceAccountCredentials wants a file path, but the Space secret is raw JSON.
_ee_json = os.environ.get("EE_SERVICE_ACCOUNT_JSON")
if _ee_json:
    _key_path = APP_DIR / "ee-key.json"
    _key_path.write_text(_ee_json, encoding="utf-8")
    _key_path.chmod(0o600)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(_key_path)
    print("[gradio_app] EE credentials written")
else:
    print("[gradio_app] EE_SERVICE_ACCOUNT_JSON not set — Earth Engine layers will 503")

# --- backend ----------------------------------------------------------------

sys.path.insert(0, str(APP_DIR / "backend"))
os.chdir(APP_DIR / "backend")

import gradio as gr  # noqa: E402
from app import app as fastapi_app  # noqa: E402  (backend/app.py)

with gr.Blocks(title="GVSM Map Explorer API") as landing:
    gr.Markdown(
        """
        # GVSM Map Explorer — backend API

        Read-only backend for the Global Vegetation Structure Map explorer.
        This page is only a placeholder; the app itself lives at the frontend URL.

        - Health: [`/deploy/status`](/deploy/status)
        - API docs: [`/docs`](/docs)
        """
    )

# Mounted last, so every backend route registered at import time still wins the
# match; the Gradio mount only catches what is left over at `/`.
app = gr.mount_gradio_app(fastapi_app, landing, path="/")

if __name__ == "__main__":
    import uvicorn

    # --workers is not a thing here; one process is what we want anyway, since
    # RENDER_LOCK serialises matplotlib per process.
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
