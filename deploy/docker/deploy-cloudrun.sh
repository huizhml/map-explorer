#!/usr/bin/env bash
# Deploy the read-only backend to Google Cloud Run.
#
#   PROJECT=my-gcp-project bash deploy/docker/deploy-cloudrun.sh
#   PROJECT=my-gcp-project STAGING=1 bash deploy/docker/deploy-cloudrun.sh
#
# STAGING=1 deploys the new revision with no traffic, reachable only at its own
# tagged URL (https://staging---<service>…run.app). The live URL — the one the
# review site uses — keeps serving the old revision until you promote it with
# the command printed at the end, so a bad build never reaches a reviewer.
#
# Run from the repo root — the Dockerfile's COPY paths are repo-root-relative.
# Idempotent: re-running deploys a new revision.
set -euo pipefail

: "${PROJECT:?Set PROJECT=<gcp-project-id>}"
SERVICE="${SERVICE:-map-explorer-api}"
# us-west1 (Oregon): the data lives in AWS us-west-2 (Oregon) behind
# data.source.coop, which caches nothing (every response is cf-cache-status:
# DYNAMIC), so the backend must sit next to the bucket. A point profile makes
# ~300 range requests; measured 2026-10-28 from europe-north1 it took 6–160 s,
# from us-west1 4–14 s. Users are one round trip away from the backend, the
# backend is hundreds of round trips away from the data.
REGION="${REGION:-us-west1}"
DATA_URL_PREFIX="${DATA_URL_PREFIX:-https://data.source.coop/geoai-ucph/gvsm/}"
STAGING="${STAGING:-}"

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

# What is live now, so the rollback command below can name it.
PREVIOUS="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(status.traffic[0].revisionName)' 2>/dev/null || true)"

TRAFFIC_ARGS=()
[ -n "$STAGING" ] && TRAFFIC_ARGS+=(--no-traffic --tag staging)

echo "==> deploying${STAGING:+ (staging, no traffic)}"
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
  --set-env-vars "^|^PUBLIC_READONLY=1|ALLOWED_DATA_URL_PREFIXES=${DATA_URL_PREFIX}|PREDICTIONS_BASE_URL=https://data.source.coop/geoai-ucph/gvsm|PREDICTIONS_REMOTE_PATH_TEMPLATE={year}/{tile}/RH{rh}_Q{q}.tif|PREDICTIONS_MOSAIC_REMOTE_URL=https://data.source.coop/geoai-ucph/gvsm/mosaics/{year}/RH{rh}_Q{q}.tif|VERTICAL_PROFILE_WORKERS=48|GDAL_HTTP_RETRY_CODES=ALL|GDAL_HTTP_MAX_RETRY=4|GDAL_HTTP_RETRY_DELAY=1|GDAL_HTTP_TIMEOUT=15" \
  ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} ${TRAFFIC_ARGS[@]+"${TRAFFIC_ARGS[@]}"}

# ^ One flag, not five: repeated --set-env-vars replace rather than accumulate.
#   The leading ^|^ switches the pair delimiter from ',' to '|' so a value
#   containing commas (e.g. several ALLOWED_DATA_URL_PREFIXES) survives intact.
#
#   GDAL_HTTP_RETRY_*: the source.coop proxy answers a few requests per thousand
#   with HTTP 520. GDAL's default retry list (429/502/503/504) does not include
#   it, so without RETRY_CODES=ALL one 520 among the ~300 reads of a point
#   profile drops that RH level from the response, silently (seen in the
#   us-west1 logs, 2026-10-28). Retries cost nothing when requests succeed.
#   GDAL_HTTP_TIMEOUT=15: a few requests in a hundred stall for ~2 min
#   (2026-10-29: 4 of 101 levels of one cube), and a cube or profile waits for
#   its slowest level. Typical requests take 1-6 s; cut off + retry instead.
#   backend/cube_window.py retries under a fresh URL, as GDAL caches the
#   partial tile of a failed read for the rest of the process.
#
#   --set-env-vars REPLACES the whole environment, so every variable the service
#   needs has to be listed here. Anything added out-of-band with
#   `gcloud run services update --update-env-vars` is silently wiped by the next
#   deploy — which is exactly how PREDICTIONS_MOSAIC_REMOTE_URL went missing.

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
if [ -n "$STAGING" ]; then
  TAG_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --format='value(status.traffic.filter(tag:staging).url)' 2>/dev/null || true)"
  # The tagged URL is always https://<tag>---<service url host>.
  [ -n "$TAG_URL" ] || TAG_URL="${URL/https:\/\//https://staging---}"
  echo "Staged: $TAG_URL  (live traffic still on ${PREVIOUS:-the previous revision})"
  echo "Next:"
  echo "  1. bash deploy/docker/smoke-test.sh $TAG_URL"
  echo "  2. build the frontend with VITE_API_BASE_URL=$TAG_URL and try it"
  echo "  3. promote:  gcloud run services update-traffic $SERVICE --to-latest --region $REGION --project $PROJECT"
else
  echo "Deployed: $URL"
  echo "Next:"
  echo "  1. bash deploy/docker/smoke-test.sh $URL"
  echo "  2. set the GitHub Actions variable VITE_API_BASE_URL to $URL"
fi
if [ -n "$PREVIOUS" ]; then
  echo "Roll back: gcloud run services update-traffic $SERVICE --to-revisions $PREVIOUS=100 --region $REGION --project $PROJECT"
fi
