
# --- Local predictions (2020 data on disk) ---
export PREDICTIONS_MOSAIC_LOCAL_PATH="/projects/dereeco/data/gvs/products/vsm/2020/{version}/mosaic/global_mosaic_2020_RH{rh}_Q{q}.cog.tif"
export PREDICTIONS_LOCAL_PATH="/projects/dereeco/data/gvs/products/vsm/2020/{version}/tiles/cog/{tile}/RH{rh}_Q{q}.tif"
export DIVERSITY_INDICES_LOCAL_PATH="/projects/dereeco/data/gvs/products/diversity_indices/{year}/{version}/tiles/"
export ALS_LOCAL_PATH="/projects/dereeco/data/gvs/evaluation/with_airborne_lidar/ALS_MaxGEDIFootprint_GSD10m/{tile}.cog.tif"
# export ALS_LOCAL_TEMPLATE="/projects/dereeco/data/gvs/evaluation/with_airborne_lidar/ALS_MaxGEDIFootprint_GSD10m/{tile}.cog.tif"

# export PREDICTIONS_LOCAL_ORIGINAL_BASE_PATH="/projects/dereeco/data/gvs/products/vsm/2020/original/tiles/cog/"
# export PREDICTIONS_LOCAL_PATH_TEMPLATE="{tile}/RH{rh}_Q{q}.tif"
export PREDICTIONS_LOCAL_VRT_PATH_TEMPLATE="/projects/dereeco/data/gvs/products/vsm/2020/{version}/vrt/{tile}_Q{q}.vrt"
export DISTANCE_MAPS_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/assets/blending/distance_maps/"
# export CR_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/products/canopy_ratio/"
export S2_GRID_LOCAL_PATH="/projects/dereeco/data/gvs/state/deploy_status.fgb"


export GEDI_LOCAL_BASE_PATH="/projects/dereeco/data/gvs/gedi/veg_sensitivity_gt0p95/all_valid"
# --- Mosaic (low-res overview) ---
# Path template for local mosaic JSON files. Placeholders: {year}, {rh}, {q}


# --- Remote predictions (2024 data on cloud) ---
export PREDICTIONS_BASE_URL="https://465001846.lumidata.eu/"
export PREDICTIONS_REMOTE_PATH_TEMPLATE="{zone}-{year}/{tile}/RH{rh}_Q{q}.tif"
export VERTICAL_PROFILE_WORKERS=16

export SAVED_FEATURE_IMAGES_ROOT="/projects/dereeco/data/gvs/results/app_saved_images"
export NATURALNESS_REF_DATA_PATH="/projects/dereeco/data/gvs/evaluation/downstream_tasks/naturalness/reference_data_set_updated.fgb"
export NATURALNESS_REF_DATA_VAL_PATH="/projects/dereeco/data/gvs/evaluation/downstream_tasks/naturalness/results_from_vsm_2017/naturalness_classification_ps15/logistic_regression_predictions.fgb"
# Optional: enable Google Satellite static snapshots for saved points (75m buffer)
export GOOGLE_STATIC_MAPS_API_KEY="AIzaSyAavNP19BB1UjqX1OYaXRRxcbdfaMZC9UE"

# Earth Engine (backend): path to Google Cloud service account JSON with EE access
# export GOOGLE_APPLICATION_CREDENTIALS="/path/to/ee-service-account.json"
export EE_CREDENTIALS_PATH="${HOME}/map-explorer/keys/private-key.json"

