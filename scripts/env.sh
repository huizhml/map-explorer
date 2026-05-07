
# --- Local predictions (2020 data on disk) ---
# Files at: /projects/dereeco/data/gvs/predictions/2020/blended/tiles/cog/{tile}/RH{rh}_Q{q}.tif
export PREDICTIONS_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/predictions/2020/blended/tiles/cog/"
export PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH="/projects/dereeco/data/gvs/predictions/2020/original/tiles/cog/"
export PREDICTIONS_LOCAL_PATH_TEMPLATE="{tile}/RH{rh}_Q{q}.tif"
export PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE="/projects/dereeco/data/gvs/predictions/2020/original/vrt/{tile}_Q{q}.vrt"
export DISTANCE_MAPS_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/assets/blending/distance_maps/"
export CR_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/products/canopy_ratio/"
export S2_GRID_LOCAL_PATH="/projects/dereeco/data/gvs/state/deploy_status.fgb"
export DIVERSITY_INDICES_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/products/diversity_indices/"
export ALS_LOCAL_TEMPLATE="/projects/dereeco/data/gvs/evaluation/with_airborne_lidar/ALS_MaxGEDIFootprint_GSD10m/{tile}.cog.tif"
export GEDI_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/gedi/veg_sensitivity_gt0p95/all_valid"
# --- Mosaic (low-res overview) ---
# Path template for local mosaic JSON files. Placeholders: {year}, {rh}, {q}
export PREDICTIONS_MOSAIC_LOCAL_PATH="/projects/dereeco/data/gvs/predictions/2020/blended/mosaic/global_mosaic_2020_RH{rh}_Q{q}.cog.tif"

# --- Remote predictions (2024 data on cloud) ---
export PREDICTIONS_BASE_URL="https://465001846.lumidata.eu/"
export PREDICTIONS_REMOTE_PATH_TEMPLATE="{zone}-{year}/{tile}/RH{rh}_Q{q}.tif"
export VERTICAL_PROFILE_WORKERS=16

export SAVED_FEATURE_IMAGES_ROOT="/projects/dereeco/data/gvs/results/app_saved_images"
export NATURALNESS_REF_DATA_PATH="/projects/dereeco/data/gvs/downstream_tasks/naturalness/reference_data_set_updated.fgb"

