# Backend image for the public (read-only) deployment.
#
# Host-agnostic: works on Cloud Run, Fly.io, a plain VM, or a Hugging Face
# Docker Space. `entrypoint.sh` honours $PORT, which is all any of them need.
#
# BUILD CONTEXT IS THE REPO ROOT:
#   docker build -f deploy/docker/Dockerfile -t map-explorer-api .
#
# python:3.11-slim is enough: the rasterio wheel bundles its own GDAL 3.9, and
# that build decodes the LERC_ZSTD COGs on source.coop (verified). No
# osgeo/gdal base image needed — backend/utils.py imports osgeo lazily.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg \
    # /vsicurl tuning — without DISABLE_READDIR_ON_OPEN, GDAL issues a bucket
    # LIST on every COG open, which dominates tile latency against source.coop.
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES \
    GDAL_INGESTED_BYTES_AT_OPEN=32768 \
    GDAL_CACHEMAX=256 \
    VSI_CACHE=TRUE \
    VSI_CACHE_SIZE=536870912

# libexpat1: the GDAL bundled inside the rasterio wheel dynamically links
#   libexpat, which python:*-slim strips out. Without it, `import rasterio`
#   dies with "libexpat.so.1: cannot open shared object file".
# libgomp1: OpenMP runtime, pulled in by some numpy/scipy wheel builds.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl libexpat1 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Non-root by default; also what HF Spaces requires (it runs containers as uid 1000).
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH
WORKDIR /home/user/app

COPY --chown=user deploy/docker/requirements.txt /tmp/requirements.txt
RUN pip install --user --no-cache-dir -r /tmp/requirements.txt

COPY --chown=user backend/ ./backend/
COPY --chown=user deploy/docker/entrypoint.sh .
# Baked-in read-only state: saved_features.db + pre-rendered images, pulled
# from the internal deployment. Empty except for .gitkeep until you populate it.
COPY --chown=user deploy/data/ ./data/

# HF Spaces expects 7860; Cloud Run injects PORT=8080; entrypoint.sh reads $PORT.
ENV PORT=7860
EXPOSE 7860
ENTRYPOINT ["bash", "entrypoint.sh"]
