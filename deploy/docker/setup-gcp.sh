#!/usr/bin/env bash
# One-time GCP project setup for the public backend. Safe to re-run.
#
#   PROJECT=my-project bash deploy/docker/setup-gcp.sh
#   PROJECT=my-project EE_KEY=/path/to/sa.json BILLING_ACCOUNT=0X0X0X-... bash …
#
# Does the things that are easy to forget and expensive to forget:
#   * enables the four APIs the deploy needs
#   * stores the EE service-account key in Secret Manager
#   * sets an Artifact Registry cleanup policy (the free tier is only 0.5 GB,
#     and every revision leaves another ~2 GB image behind)
#   * optionally creates a budget alert
set -euo pipefail

: "${PROJECT:?Set PROJECT=<gcp-project-id>}"
REGION="${REGION:-europe-north1}"

echo "==> enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT"

# `services enable` returns before the enablement has propagated, so the very
# next call fails with SERVICE_DISABLED. Poll instead of sleeping blindly.
echo "==> waiting for API enablement to propagate"
for attempt in $(seq 1 30); do
  enabled="$(gcloud services list --enabled --project "$PROJECT" \
    --format='value(config.name)' 2>/dev/null || true)"
  missing=""
  for api in run cloudbuild artifactregistry secretmanager; do
    case "$enabled" in
      *"${api}.googleapis.com"*) ;;
      *) missing="$missing $api" ;;
    esac
  done
  if [ -z "$missing" ]; then
    echo "    all four APIs live (after ${attempt} check(s))"
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "    still missing:$missing — continuing anyway, later steps may fail" >&2
    break
  fi
  sleep 10
done

echo "==> Earth Engine key"
if [ -n "${EE_KEY:-}" ]; then
  if [ ! -f "$EE_KEY" ]; then
    echo "    EE_KEY=$EE_KEY does not exist" >&2; exit 1
  fi
  if gcloud secrets describe ee-key --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions add ee-key --data-file="$EE_KEY" --project "$PROJECT"
    echo "    added a new version of secret 'ee-key'"
  else
    gcloud secrets create ee-key --data-file="$EE_KEY" --project "$PROJECT"
    echo "    created secret 'ee-key'"
  fi
  # The Cloud Run runtime service account must be able to read it.
  PROJNUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  gcloud secrets add-iam-policy-binding ee-key \
    --member "serviceAccount:${PROJNUM}-compute@developer.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor \
    --project "$PROJECT" >/dev/null
  echo "    granted secretAccessor to the runtime service account"
else
  echo "    EE_KEY not set — skipping (Earth Engine layers will return 503)"
fi

echo "==> Artifact Registry cleanup policy"
# `gcloud run deploy --source` pushes to this repo. Without a policy, old
# revision images accumulate at ~2 GB each against a 0.5 GB free tier.
#
# Cost hygiene, not a prerequisite — a failure here must not abort the setup,
# so the whole block runs with `set -e` suspended and reports instead.
set +e
(
  if ! gcloud artifacts repositories describe cloud-run-source-deploy \
        --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud artifacts repositories create cloud-run-source-deploy \
      --repository-format=docker --location "$REGION" --project "$PROJECT" --quiet || exit 1
  fi
POLICY_FILE="$(mktemp)"
cat > "$POLICY_FILE" <<'EOF'
[
  {
    "name": "keep-recent",
    "action": {"type": "Keep"},
    "mostRecentVersions": {"keepCount": 3}
  },
  {
    "name": "delete-old",
    "action": {"type": "Delete"},
    "condition": {"olderThan": "30d"}
  }
]
EOF
  gcloud artifacts repositories set-cleanup-policies cloud-run-source-deploy \
    --location "$REGION" --project "$PROJECT" --policy="$POLICY_FILE" --quiet
  rc=$?
  rm -f "$POLICY_FILE"
  exit $rc
)
if [ $? -eq 0 ]; then
  echo "    keeping the 3 most recent images, deleting anything older than 30d"
else
  echo "    could not set the cleanup policy — set it later, or old images will" >&2
  echo "    accumulate at ~2 GB per revision against a 0.5 GB free tier" >&2
fi
set -e

echo "==> budget alert"
if [ -n "${BILLING_ACCOUNT:-}" ]; then
  # The amount must be denominated in the billing account's own currency —
  # passing EUR to a DKK account fails with a bare INVALID_ARGUMENT.
  CURRENCY="$(gcloud billing accounts describe "$BILLING_ACCOUNT" \
    --format='value(currencyCode)' 2>/dev/null || true)"
  CURRENCY="${CURRENCY:-USD}"
  case "$CURRENCY" in
    DKK) AMOUNT="75DKK" ;;   # ≈ €10
    SEK|NOK) AMOUNT="110${CURRENCY}" ;;
    EUR) AMOUNT="10EUR" ;;
    *) AMOUNT="10${CURRENCY}" ;;
  esac
  echo "    billing currency: $CURRENCY → budget $AMOUNT"
  # Also needs billingbudgets.googleapis.com, and a valid core/project (the
  # quota project), or it fails with USER_PROJECT_DENIED.
  gcloud services enable billingbudgets.googleapis.com --project "$PROJECT" >/dev/null 2>&1 || true
  gcloud billing budgets create \
    --billing-account "$BILLING_ACCOUNT" \
    --display-name "map-explorer-api" \
    --budget-amount "$AMOUNT" \
    --threshold-rule percent=0.5 \
    --threshold-rule percent=0.9 \
    --threshold-rule percent=1.0 \
    --filter-projects "projects/$PROJECT" 2>/dev/null \
    && echo "    $AMOUNT budget with alerts at 50/90/100%" \
    || echo "    could not create the budget (needs the Billing Budgets API and billing.budgets.create); set one in the console instead" >&2
else
  echo "    BILLING_ACCOUNT not set — create a budget alert manually:"
  echo "    https://console.cloud.google.com/billing → Budgets & alerts"
  echo "    (find your account id with: gcloud billing accounts list)"
fi

echo
echo "Setup done. Next: PROJECT=$PROJECT bash deploy/docker/deploy-cloudrun.sh"
