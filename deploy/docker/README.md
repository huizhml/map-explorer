# Public read-only backend — deployment

One image, several possible hosts. Build context is always the **repo root**.

```bash
docker build -f deploy/docker/Dockerfile -t map-explorer-api .
```

Environment variables and secrets: see [env-vars.md](env-vars.md). They are the
same everywhere; only the way you set them differs.

## Before you deploy

Populate `deploy/data/` from the internal deployment — this is the read-only
state baked into the image:

```bash
scp hendrix:~/map-explorer/backend/data/saved_features.db deploy/data/
rsync -a hendrix:~/…/saved_feature_images/ deploy/data/saved_feature_images/
```

`deploy/data/` is gitignored apart from `.gitkeep`; the DB and images never
belong in the source repo.

## Local smoke test

```bash
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e PUBLIC_READONLY=1 \
  -e ALLOWED_DATA_URL_PREFIXES=https://data.source.coop/geoai-ucph/gvsm/ \
  -e PREDICTIONS_BASE_URL=https://data.source.coop/geoai-ucph/gvsm \
  -e PREDICTIONS_REMOTE_PATH_TEMPLATE='{year}/{tile}/RH{rh}_Q{q}.tif' \
  map-explorer-api

curl 'http://localhost:8080/deploy/status'
curl -o /tmp/t.png 'http://localhost:8080/cog/tiles/WebMercatorQuad/12/42/2618.png?url=https://data.source.coop/geoai-ucph/gvsm/2020/01GEL/RH98_Q1.tif&rescale=0,500&colormap_name=inferno'
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8080/cog/info?url=/etc/passwd'   # expect 403
```

## Google Cloud Run

### What it actually costs

Google's perpetual free tier (not the $300 trial credit) gives you, per month:

| | Free allowance | What it means here |
|---|---|---|
| Cloud Run requests | 2,000,000 | Not reachable at review traffic |
| Cloud Run vCPU | 180,000 vCPU-s | At `--cpu 2`, **25 h/month of request-handling time**. CPU is only billed while a request is in flight. |
| Cloud Run memory | 360,000 GiB-s | At `--memory 2Gi`, 50 h — so vCPU binds first |
| Cloud Run egress | 1 GB **from North America** | Does **not** cover europe-north1 |
| Artifact Registry | 0.5 GB | The image is ~1.5–2.5 GB, so this is exceeded |
| Cloud Build | 2,500 build-min | A build takes ~5–10 min |

So it is *nearly* free, not literally free. Expect roughly **€1/month**:
Artifact Registry overage (~$0.10/GB) plus European egress (~$0.12/GB; tiles are
a few KB each, figures 1–3 MB). A billing account with a card is required either
way — the free tier is granted per billing account.

`setup-gcp.sh` sets an Artifact Registry cleanup policy and a budget alert,
which is what keeps that €1 from quietly becoming €20.

### One-time setup

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT

PROJECT=YOUR_PROJECT EE_KEY=/path/to/ee-service-account.json \
  bash deploy/docker/setup-gcp.sh
```

### Deploy

```bash
PROJECT=YOUR_PROJECT bash deploy/docker/deploy-cloudrun.sh
bash deploy/docker/smoke-test.sh https://map-explorer-api-xxxx.run.app
```

Why the flags in that script are what they are:

- `--memory 2Gi` — `VSI_CACHE_SIZE` (512 MB) + `GDAL_CACHEMAX` (256 MB) alone
  claim 0.75 GB, before matplotlib 3D transects and the concurrent /vsicurl
  readers in the vertical-profile path. Tune down from real metrics, not guesses.
- `--cpu 2` — halves render latency versus 1 vCPU, but also halves the free
  allowance from 50 h/month to 25 h. Drop to `--cpu 1` if you would rather have
  the headroom than the speed.
- `--concurrency 8` — figure rendering is CPU-bound and serialised by
  `RENDER_LOCK`, so a high per-instance concurrency only builds an internal queue.
- `--timeout 300` — a cold 3D transect render takes tens of seconds.
- `--max-instances 4` — a cap, so a crawler cannot fan out into a real bill.

## The three pages

The frontend is a Vite multi-page build, not a single app with routes, so each
page ships only what it uses:

| Entry | Page | Weight (gzip) |
|---|---|---|
| `index.html` | Story — narrative intro | ~64 KB |
| `explore.html` | Simple map — what reviewers get | ~137 KB |
| `dev.html` | Full app — the working tool | ~746 KB |

`dev.html` is built and deployed but **deliberately not linked from anywhere**.
On the public backend most of what it offers (upload, saving, auxiliary layers,
directory browsing) is blocked or unconfigured, so a reviewer who wandered into
it would meet a wall of 403s and 503s. Reaching it requires knowing the URL.

Keep it that way: adding a link is the easy mistake, and nothing in the reviewer
flow needs it.

## Earth Engine

`backend/routes/earthengine.py` only accepts a **service-account** key — it never
falls back to the user credentials that `earthengine authenticate` writes to
`~/.config/earthengine/credentials`. Without one, every EE layer returns 503.

The service account must belong to a Cloud project that is **registered with
Earth Engine**; a plain project is not enough (`ee.Initialize` fails with
"project is not registered to use Earth Engine"). Register at
<https://console.cloud.google.com/earth-engine?project=YOUR_PROJECT> — for
noncommercial/academic use access is granted immediately, no approval wait.

```bash
P=YOUR_PROJECT
SA_EMAIL="map-explorer-ee@${P}.iam.gserviceaccount.com"

gcloud services enable earthengine.googleapis.com --project "$P"

gcloud iam service-accounts create map-explorer-ee \
  --display-name "map-explorer Earth Engine" --project "$P"

for ROLE in roles/earthengine.viewer roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$P" \
    --member "serviceAccount:${SA_EMAIL}" --role "$ROLE" --condition=None
done

KEY="$(mktemp -t ee-key).json"
gcloud iam service-accounts keys create "$KEY" --iam-account "$SA_EMAIL" --project "$P"
PROJECT="$P" EE_KEY="$KEY" bash deploy/docker/setup-gcp.sh   # → Secret Manager
rm -f "$KEY"                                                 # never leave it on disk
```

Attaching the secret does not need a rebuild — the image is unchanged:

```bash
gcloud run services update map-explorer-api --region "$REGION" --project "$P" \
  --set-secrets EE_SERVICE_ACCOUNT_JSON=ee-key:latest
```

Verify:

```bash
curl "$URL/api/v1/earthengine/status"
# {"ee_import_ok":true,"credentials_path_set":true,"credentials_file_exists":true}
```

## Hugging Face Docker Space

Requires a PRO account ($9/month) — Docker Spaces are no longer on the free
tier. If you have one, see [../hf-space/](../hf-space/); `sync.sh` lays out a
Space repo with this Dockerfile at its root.

## Plain VM (Hetzner / Oracle Always Free / university VM)

```bash
docker build -f deploy/docker/Dockerfile -t map-explorer-api .
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e PORT=8080 --env-file deploy/docker/public.env \
  --name map-explorer-api map-explorer-api
```

Put Caddy in front for automatic HTTPS:

```
api.your-domain.example {
    reverse_proxy 127.0.0.1:8080
}
```

On Oracle's Always Free ARM instances, build with `--platform linux/arm64`;
rasterio and the rest publish `aarch64` wheels, so nothing else changes.
