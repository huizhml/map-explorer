#!/usr/bin/env bash
# Deploy the read-only backend to Google Cloud Run.
#
#   PROJECT=my-gcp-project bash deploy/docker/deploy-cloudrun.sh
#
# Run from the repo root — the Dockerfile's COPY paths are repo-root-relative.
# Idempotent: re-running deploys a new revision.
set -euo pipefail

: "${PROJECT:?Set PROJECT=<gcp-project-id>}"
SERVICE="${SERVICE:-map-explorer-api}"
# source.coop is fronted by Cloudflare, so any European region is close enough;
# europe-north1 is among the cheapest and is near Copenhagen.
REGION="${REGION:-europe-north1}"
DATA_URL_PREFIX="${DATA_URL_PREFIX:-https://data.source.coop/geoai-ucph/gvsm/}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f deploy/data/saved_features.db ]; then
  echo "WARNING: deploy/data/saved_features.db is missing — the saved-features" >&2
  echo "         list will be empty. See deploy/docker/README.md." >&2
fi

SECRET_ARGS=()
if gcloud secrets describe ee-key --project "$PROJECT" >/dev/null 2>&1; then
  SECRET_ARGS+=(--set-secrets "EE_SERVICE_ACCOUNT_JSON=ee-key:latest")
else
  echo "NOTE: secret 'ee-key' not found — Earth Engine layers will return 503." >&2
  echo "      Create it with:" >&2
  echo "      gcloud secrets create ee-key --data-file=/path/to/sa.json --project $PROJECT" >&2
fi

# --concurrency 8: figure rendering is CPU-bound and serialised by RENDER_LOCK,
#   so a high per-instance concurrency just builds a queue inside one container.
# --timeout 300: a cold 3D transect render can take tens of seconds.
# --memory 2Gi: matplotlib 3D + a few concurrent /vsicurl readers exceed 1 GiB.
# Build explicitly rather than with `run deploy --source`: that command only
# finds a Dockerfile at the source root, and ours is in deploy/docker/, so it
# would silently fall back to Buildpacks and try to build the repo as a Node app.
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${SERVICE}:latest"

echo "==> building $IMAGE"
gcloud builds submit \
  --config deploy/docker/cloudbuild.yaml \
  --substitutions "_IMAGE=${IMAGE}" \
  --project "$PROJECT" \
  --region "$REGION" \
  .

echo "==> deploying"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --concurrency 8 \
  --timeout 300 \
  --min-instances 0 \
  --max-instances 4 \
  --set-env-vars "^|^PUBLIC_READONLY=1|ALLOWED_DATA_URL_PREFIXES=${DATA_URL_PREFIX}|PREDICTIONS_BASE_URL=https://data.source.coop/geoai-ucph/gvsm|PREDICTIONS_REMOTE_PATH_TEMPLATE={year}/{tile}/RH{rh}_Q{q}.tif|PREDICTIONS_MOSAIC_REMOTE_URL=https://data.source.coop/geoai-ucph/gvsm/mosaics/{year}/RH{rh}_Q{q}.tif|VERTICAL_PROFILE_WORKERS=48" \
  "${SECRET_ARGS[@]}"

# ^ One flag, not five: repeated --set-env-vars replace rather than accumulate.
#   The leading ^|^ switches the pair delimiter from ',' to '|' so a value
#   containing commas (e.g. several ALLOWED_DATA_URL_PREFIXES) survives intact.
#
#   --set-env-vars REPLACES the whole environment, so every variable the service
#   needs has to be listed here. Anything added out-of-band with
#   `gcloud run services update --update-env-vars` is silently wiped by the next
#   deploy — which is exactly how PREDICTIONS_MOSAIC_REMOTE_URL went missing.

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
echo "Deployed: $URL"
echo "Next:"
echo "  1. bash deploy/docker/smoke-test.sh $URL"
echo "  2. set the GitHub Actions variable VITE_API_BASE_URL to $URL"
