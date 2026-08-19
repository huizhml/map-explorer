# Running this project

Three environments, one codebase. What differs is only where the raster data
comes from and whether writes are allowed.

| | Data source | Writes | Frontend |
|---|---|---|---|
| **Local** | source.coop (HTTP) | ✅ | `npm run dev` |
| **hendrix** | `/projects` (disk) | ✅ | `npm run dev` on the node |
| **Cloud Run** | source.coop (HTTP) | ❌ read-only | GitHub Pages |

The frontend builds three pages from the same `src/`:

| URL | Page | Weight (gzip) |
|---|---|---|
| `/` (`index.html`) | Story | ~64 KB |
| `/explore.html` | Simple map — what reviewers use | ~174 KB |
| `/dev.html` | Full app — the working tool | ~746 KB |

> ⚠️ The full app moved to **`/dev.html`**. `/` is now the story page.

Plus a fourth URL, `/review/`, built separately by `vite.config.review.ts`: the
same explore map, alone. No story chapters, no `dev.html`, no `public/story/`
artwork in the output — a reviewer lands on the map instead of navigating to it.
Same code as `/explore.html`, so the same ~175 KB.

```bash
npm run build:web                        # dist/         — the three pages above
npm run build:review                     # dist/review/  — must run second
```

The order matters: `build:web` empties `dist/`. CI runs both in
[.github/workflows/pages.yml](.github/workflows/pages.yml) and ships one
artifact, so `/review/` deploys with everything else.

---

## Local

One-time:

```bash
bash scripts/setup-local-backend.sh      # conda env `gis_app`, python 3.11
```

Every time:

```bash
# terminal 1 — backend
conda activate gis_app
source scripts/env.local.sh
cd backend && uvicorn app:app --reload --port 8006

# terminal 2 — frontend
npm run dev                              # http://localhost:9030/dev.html
```

All rasters come over HTTP from source.coop, so no cluster access and no local
copy is needed. The cost is latency: ~2–4 s per COG open, ~14 s for a point
profile (it opens 101 of them).

To speed up a region you work in often, download those tiles and set
`PREDICTIONS_LOCAL_PATH` + `PREDICTIONS_LOCAL_YEARS=2020` in
`scripts/env.local.sh`.

The saved-features database lives at `backend/data/saved_features.db` and is
gitignored. **It is not backed up** — `backend/ops/litestream/` has a
replicate-to-R2 setup if you want that; it needs its path repointed.

---

## hendrix

```bash
bash scripts/launch.sh                   # SLURM jobs + SSH forwards
```

Under the hood: `conda activate gis_app`, `source scripts/env.sh`, then uvicorn
on a compute node, with local port forwards.

`scripts/env.sh` points at `/projects/dereeco/...` for predictions, GEDI, ALS,
LVIS, naturalness and the MGRS grid — the layers the public deployment does not
have.

---

## Deploy (Cloud Run + GitHub Pages)

### Backend

```bash
PROJECT=gvsm-481414 bash deploy/docker/deploy-cloudrun.sh
bash deploy/docker/smoke-test.sh https://map-explorer-api-871539203434.europe-north1.run.app
```

Builds with `deploy/docker/Dockerfile` via `deploy/docker/cloudbuild.yaml` and
deploys. ~4 minutes. Full detail and the one-time project setup are in
[deploy/docker/README.md](deploy/docker/README.md); the environment is
documented in [deploy/docker/env-vars.md](deploy/docker/env-vars.md).

Two things that bite:

- `--set-env-vars` **replaces** the whole environment. Anything set out-of-band
  with `gcloud run services update --update-env-vars` is wiped by the next
  deploy, so every variable must live in the deploy script.
- The image bakes in `deploy/data/` — the MGRS grid, and the saved-features
  database and images if present. Refresh those before deploying if the
  showcase changed.

### Frontend

Pushing to `main` builds and publishes all three pages. The backend URL comes
from the repo variable `VITE_API_BASE_URL`.

The Pages workflow runs `build:web`, which skips `tsc -b`: the repo has 17
pre-existing type errors and Vite strips types without checking them anyway.
Run `npm run build` locally to see them.

### Showcase sites

Tag saved features in the app (📤 button, bottom-left), then:

```bash
npm run sites:publish -- --tags showcase
```

Fetches the bundle from whichever backend you are pointed at, writes
`public/sites/`, commits and pushes. Those files are committed because the
Pages workflow has no database and cannot regenerate them — the same reason
`deploy/data/s2_grid.fgb` and `public/examples/` are tracked.

---

## Things that are easy to get wrong

**The MGRS grid gates the whole map.** `useAutoLoadVSM` derives the visible tile
names from it and requests nothing when the set is empty, so a missing
`S2_GRID_LOCAL_PATH` produces a blank map with no error anywhere. It has caused
three separate "why is nothing rendering" hunts.

**`PREDICTIONS_LOCAL_YEARS` decides local vs remote.** It replaced the hardcoded
`year == 2020` branches. hendrix sets `2020`; local and Cloud Run leave it unset
so everything resolves over HTTP.

**Only Q1 is published.** source.coop carries the median quantile only, so 5% /
95% and the three interval layers have no data — at any zoom. The mosaic
endpoint HEADs the object and reports the gap rather than handing back a URL
that renders as blank tiles.

**source.coop is the latency floor.** ~2–4 s per request, measured identically
from a laptop, from Cloud Run, and from the public titiler.xyz. Tuning GDAL or
adding workers does not move it; only fewer requests do.
