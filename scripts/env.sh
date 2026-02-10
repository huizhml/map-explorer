
# --- Local predictions (2020 data on disk) ---
# Files at: /projects/dereeco/data/gvs/predictions/2020/blended/tiles/cog/{tile}/RH{rh}_Q{q}.tif
export PREDICTIONS_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/predictions/2020/blended/tiles/cog/"
export PREDICTIONS_LOCAL_PATH_TEMPLATE="{tile}/RH{rh}_Q{q}.tif"

# --- Mosaic (low-res overview) ---
# Path template for local mosaic JSON files. Placeholders: {year}, {rh}, {q}
export PREDICTIONS_MOSAIC_LOCAL_PATH="/projects/dereeco/data/gvs/predictions/2020/blended/mosaic/global_mosaic_2020_RH{rh}_Q{q}.cog.tif"

# --- Remote predictions (2024 data on cloud) ---
export PREDICTIONS_BASE_URL="https://465001846.lumidata.eu/"
export PREDICTIONS_REMOTE_PATH_TEMPLATE="{zone}-{year}/{tile}/RH{rh}_Q{q}.tif"
