#!/usr/bin/env bash
# Create the conda environment the backend needs, on a laptop.
#
#   bash scripts/setup-local-backend.sh
#
# Mirrors the `gis_app` env used on the cluster. Conda supplies Python; the
# packages come from pip, because the geospatial wheels (rasterio in
# particular) ship their own GDAL and are what the deployment is verified
# against — mixing in conda-forge's GDAL invites two GDALs in one process.
set -euo pipefail

ENV_NAME="${ENV_NAME:-gis_app}"
PYTHON_VERSION="${PYTHON_VERSION:-3.11}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v conda >/dev/null 2>&1; then
  echo "conda not found. Install miniforge first: https://conda-forge.org/download/" >&2
  exit 1
fi

CONDA_EXE_BIN="$(command -v mamba || command -v conda)"
echo "==> creating env '$ENV_NAME' (python $PYTHON_VERSION) with $(basename "$CONDA_EXE_BIN")"

if conda env list | awk '{print $1}' | grep -qx "$ENV_NAME"; then
  echo "    already exists — reusing"
else
  "$CONDA_EXE_BIN" create -y -n "$ENV_NAME" "python=$PYTHON_VERSION"
fi

echo "==> installing backend requirements"
# The deployment's list, which is narrower than backend/requirements.txt: it
# drops pystac / hydra / cogeo-mosaic / ipdb, which only the standalone scripts
# use, and needs no system GDAL because utils.py imports osgeo lazily.
conda run -n "$ENV_NAME" python -m pip install --upgrade pip
conda run -n "$ENV_NAME" python -m pip install -r "$REPO_ROOT/deploy/docker/requirements.txt"

echo "==> verifying"
conda run -n "$ENV_NAME" python - <<'PY'
import sys
mods = ["fastapi", "uvicorn", "rasterio", "matplotlib", "geopandas", "titiler.core", "mgrs", "duckdb"]
missing = []
for m in mods:
    try:
        __import__(m)
    except Exception as e:
        missing.append(f"{m}: {e}")
print("python", sys.version.split()[0])
if missing:
    print("MISSING:"); [print(" ", m) for m in missing]; raise SystemExit(1)
import rasterio
print("rasterio", rasterio.__version__, "| bundled GDAL", rasterio.__gdal_version__)
PY

cat <<EOF

Done. To run the backend:

    conda activate $ENV_NAME
    source scripts/env.local.sh
    cd backend && uvicorn app:app --reload --port 8006

And the frontend, in another terminal:

    npm run dev     # http://localhost:9030/dev.html

EOF
