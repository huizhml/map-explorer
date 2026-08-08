# Environment for running the backend on a laptop, against the published data.
#
#   source scripts/env.local.sh
#   cd backend && uvicorn app:app --reload --port 8006
#
# The counterpart to scripts/env.sh, which points at hendrix's local disks.
# Everything here reads from source.coop instead, so no cluster access and no
# local copy of the rasters is needed — at the cost of ~2-4 s per COG open.
#
# Deliberately NOT set: PUBLIC_READONLY. This is the authoring environment;
# saving features has to work.

# Resolve the repo root without $BASH_SOURCE: zsh does not set it, and this
# file is sourced, so $0 is the shell. Getting this wrong is quiet and nasty —
# the paths below end up one directory too high, SQLite happily creates an
# empty database at the bad path, and the app reports no saved features and a
# blank map with no error anywhere.
_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# --- Predictions: all years from source.coop -------------------------------
# PREDICTIONS_LOCAL_YEARS is left unset, so every year resolves remotely.
# Set it to "2020" only if you also point PREDICTIONS_LOCAL_PATH at a local copy.
export PREDICTIONS_BASE_URL="https://data.source.coop/geoai-ucph/gvsm"
export PREDICTIONS_REMOTE_PATH_TEMPLATE="{year}/{tile}/RH{rh}_Q{q}.tif"
export PREDICTIONS_MOSAIC_REMOTE_URL="https://data.source.coop/geoai-ucph/gvsm/mosaics/{year}/RH{rh}_Q{q}.tif"

# --- The MGRS grid ---------------------------------------------------------
# Not optional: useAutoLoadVSM derives the visible tile names from this layer
# and requests nothing when it is missing, so the map stays blank without it.
# The copy committed for the deployment doubles as the local one.
export S2_GRID_LOCAL_PATH="$_REPO_ROOT/deploy/data/s2_grid.fgb"

# --- Saved features --------------------------------------------------------
# Defaults already resolve to backend/data/, but set them explicitly so it is
# obvious which database is being written to.
export SAVED_FEATURES_DB_PATH="$_REPO_ROOT/backend/data/saved_features.db"
export SAVED_FEATURE_IMAGES_ROOT="$_REPO_ROOT/backend/data/saved_feature_images"

# --- Performance -----------------------------------------------------------
# A point profile opens 101 COGs; the cost is HTTP latency, not CPU, so a wide
# batch is what matters. 48 is the backend's cap.
export VERTICAL_PROFILE_WORKERS=48

# Without DISABLE_READDIR_ON_OPEN, GDAL issues a bucket listing on every COG
# open, which dominates latency against source.coop.
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
export GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES
export GDAL_INGESTED_BYTES_AT_OPEN=32768
export GDAL_CACHEMAX=256
export VSI_CACHE=TRUE
export VSI_CACHE_SIZE=536870912

# Headless matplotlib; without it figure rendering tries to open a window.
export MPLBACKEND=Agg

# --- Optional --------------------------------------------------------------
# Earth Engine layers return 503 unless this points at a service-account key.
# export GOOGLE_APPLICATION_CREDENTIALS="$HOME/keys/ee-service-account.json"

# Google basemap in transect figures falls back through providers without a
# key, so this is only needed if those fallbacks start failing.
# export GOOGLE_STATIC_MAPS_API_KEY="..."

# Fail loudly rather than exporting paths that do not exist.
_bad=0
for _p in "$_REPO_ROOT/backend/app.py" "$S2_GRID_LOCAL_PATH"; do
  [ -e "$_p" ] || { echo "  MISSING: $_p" >&2; _bad=1; }
done
if [ "$_bad" = "1" ]; then
  echo "env.local.sh: repo root resolved to '$_REPO_ROOT' — run this from inside the repo." >&2
  echo "Nothing was exported." >&2
  unset _REPO_ROOT _bad _p
  return 1 2>/dev/null || exit 1
fi
unset _bad _p

echo "env.local.sh loaded"
echo "  predictions : $PREDICTIONS_BASE_URL (remote)"
echo "  MGRS grid   : $S2_GRID_LOCAL_PATH"
echo "  database    : $SAVED_FEATURES_DB_PATH"
unset _REPO_ROOT
