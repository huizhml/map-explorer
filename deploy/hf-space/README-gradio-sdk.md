# Hosting the backend on a **Gradio-SDK** Space

Use this if a Gradio Space is available to your account but a Docker Space is
not. Gradio is a FastAPI application under the hood, so the real backend runs
unchanged — [`gradio_app.py`](gradio_app.py) just does in Python what
`deploy/docker/entrypoint.sh` does in bash.

## Space repo layout

```
README.md                       <- frontmatter below
app.py                          <- copy of gradio_app.py
requirements.txt                <- deploy/docker/requirements.txt + gradio
backend/                        <- rsync of the repo's backend/
deploy/data/                    <- saved_features.db + saved_feature_images (git-lfs)
```

## README.md frontmatter

```yaml
---
title: GVSM Map Explorer API
emoji: 🌳
colorFrom: green
colorTo: blue
sdk: gradio
sdk_version: 5.49.1
python_version: "3.12.12"
app_file: app.py
pinned: false
---
```

`python_version` must be **3.12.12 or 3.10.13** — ZeroGPU supports only those
two. (Not 3.11, which is what the Docker path uses.)

Pin `sdk_version` and `python_version`. A review cycle runs for months, and an
unpinned Space that silently rebuilds on a newer Gradio is exactly the kind of
thing that breaks the week a reviewer opens it.

## Variables and secrets

Identical to the Docker path — see [../docker/env-vars.md](../docker/env-vars.md).
The GDAL tuning vars are set by `gradio_app.py` via `setdefault`, so setting them
in the Space UI also works and takes precedence.

## Known risks specific to this path

1. **Dependency conflict.** Gradio pins its own `fastapi`, `starlette`, `pydantic`
   and `httpx` ranges, and TiTiler pins others. If the build resolver picks a
   FastAPI that TiTiler rejects (or vice versa), you get an import error at
   startup rather than a build failure. Check the build log, then pin the
   offending package explicitly in `requirements.txt`.
2. **No `apt` layer control.** Fine here — the whole stack installs from wheels
   (verified: the `rasterio==1.4.3` wheel's bundled GDAL 3.9.3 decodes the
   LERC_ZSTD COGs on source.coop). If you later need a system library, you must
   move to a Docker Space.
3. **GDAL env timing.** `gradio_app.py` sets the `GDAL_*` vars before importing
   the backend, which is the earliest point available in this SDK. If tile
   latency looks wrong, set them as Space *variables* instead so they are in the
   environment before the process starts.
4. **ZeroGPU is the only free hardware for a Gradio Space** (CPU Basic is greyed
   out for free accounts; Docker is marked Paid). Consequences:
   - The **daily GPU quota is irrelevant here** — 5 min/day for a free account
     applies to time spent inside `@spaces.GPU` functions, and this app has
     none. It would run purely on the CPU side and never request a GPU.
   - But that is exactly what makes it off-label: ZeroGPU is GPU-sharing
     infrastructure, and a tile server that never touches the GPU is not what
     it is for. HF documents ZeroGPU as "may have limited compatibility …
     unexpected issues may arise". Fine to trial; risky as the thing reviewers
     depend on for months.
   - Free accounts must be in good standing: verified email, older than 30 days,
     max 2 ZeroGPU Spaces.

## Sync

`sync.sh` targets the Docker layout. For this path, copy `gradio_app.py` to the
Space as `app.py`, append `gradio` to `requirements.txt`, and drop the
`Dockerfile`.
