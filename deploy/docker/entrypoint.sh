#!/usr/bin/env bash
# Space container entrypoint: materialise secrets, then serve.
set -euo pipefail

APP_DIR=/home/user/app

# The EE service-account key arrives as a Space secret holding the raw JSON.
# ee.ServiceAccountCredentials wants a file path, so write it out.
if [ -n "${EE_SERVICE_ACCOUNT_JSON:-}" ]; then
  printf '%s' "$EE_SERVICE_ACCOUNT_JSON" > "$HOME/ee-key.json"
  chmod 600 "$HOME/ee-key.json"
  export GOOGLE_APPLICATION_CREDENTIALS="$HOME/ee-key.json"
  echo "[entrypoint] EE credentials written to \$HOME/ee-key.json"
else
  echo "[entrypoint] EE_SERVICE_ACCOUNT_JSON not set — Earth Engine layers will 503"
fi

# Baked-in read-only state, staged into a writable location.
#
# `init_saved_features_db()` runs at import time and does mkdir() + a SQLite
# connect, which creates the file if absent. The image layer is not reliably
# writable (and is read-only outright in some runtimes), so both would fail and
# the container would never bind its port. /tmp is always writable.
#
# Losing this on restart is fine: the deployment is read-only, so nothing here
# is ever modified after startup.
STATE_DIR="${STATE_DIR:-/tmp/state}"
mkdir -p "$STATE_DIR/saved_feature_images"
if [ -f "$APP_DIR/data/saved_features.db" ]; then
  cp "$APP_DIR/data/saved_features.db" "$STATE_DIR/saved_features.db"
  echo "[entrypoint] staged saved_features.db into $STATE_DIR"
else
  echo "[entrypoint] no baked-in saved_features.db — starting with an empty one"
fi
if [ -d "$APP_DIR/data/saved_feature_images" ]; then
  cp -R "$APP_DIR/data/saved_feature_images/." "$STATE_DIR/saved_feature_images/" 2>/dev/null || true
fi

export SAVED_FEATURES_DB_PATH="${SAVED_FEATURES_DB_PATH:-$STATE_DIR/saved_features.db}"
export SAVED_FEATURE_IMAGES_ROOT="${SAVED_FEATURE_IMAGES_ROOT:-$STATE_DIR/saved_feature_images}"

# The Sentinel-2 / deploy-status grid. Read-only, so it is served straight out
# of the image rather than staged into $STATE_DIR.
#
# This is not just another optional layer: useAutoLoadVSM derives the set of
# visible MGRS tiles from this grid's `Name` attribute, and bails out when the
# set is empty. Without it, *no* prediction tile is ever requested and the map
# stays blank at every zoom level.
if [ -f "$APP_DIR/data/s2_grid.fgb" ]; then
  export S2_GRID_LOCAL_PATH="${S2_GRID_LOCAL_PATH:-$APP_DIR/data/s2_grid.fgb}"
  echo "[entrypoint] S2 grid: $S2_GRID_LOCAL_PATH"
else
  echo "[entrypoint] WARNING: no data/s2_grid.fgb — VSM tiles will never load"
fi

cd "$APP_DIR/backend"

# --workers 1 is deliberate: RENDER_LOCK (backend/routes/saved_features/render_lock.py)
# serialises matplotlib per process, and the app assumes a single writer.
exec uvicorn app:app \
  --host 0.0.0.0 \
  --port "${PORT:-7860}" \
  --workers 1 \
  --timeout-keep-alive 75
