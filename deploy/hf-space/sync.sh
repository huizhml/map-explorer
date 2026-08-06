#!/usr/bin/env bash
# Push the current backend/ + deployment scaffolding to a Hugging Face Space.
#
#   Usage:  SPACE=your-user/gvsm-map-explorer-api bash deploy/hf-space/sync.sh
#
# NOTE: Docker Spaces require a PRO account — they are no longer on the free
# tier. See deploy/docker/README.md for hosts that are.
#
# Mirrors the repo layout into the Space (Dockerfile at the root, sources under
# backend/ and deploy/docker/) so the exact same Dockerfile builds here and on
# Cloud Run / a VM.
set -euo pipefail

: "${SPACE:?Set SPACE=<hf-user>/<space-name>}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO_ROOT/deploy/hf-space"
CLONE="$HERE/.space-repo"

if [ ! -d "$CLONE/.git" ]; then
  echo "==> cloning https://huggingface.co/spaces/$SPACE"
  git clone "https://huggingface.co/spaces/$SPACE" "$CLONE"
  git -C "$CLONE" lfs install --local
fi

git -C "$CLONE" pull --rebase --autostash || true

echo "==> syncing sources"
mkdir -p "$CLONE/deploy/docker" "$CLONE/deploy/data"
rsync -a --delete \
  --exclude '__pycache__' --exclude '*.pyc' \
  --exclude 'data/' --exclude 'ops/' \
  "$REPO_ROOT/backend/" "$CLONE/backend/"
cp "$REPO_ROOT/deploy/docker/requirements.txt" \
   "$REPO_ROOT/deploy/docker/entrypoint.sh" "$CLONE/deploy/docker/"
# HF builds from the Space repo root, so the Dockerfile lives there — its COPY
# paths are repo-root-relative either way.
cp "$REPO_ROOT/deploy/docker/Dockerfile" "$CLONE/Dockerfile"
cp "$HERE/README.md" "$CLONE/README.md"

echo "==> syncing baked-in read-only state"
rsync -a "$REPO_ROOT/deploy/data/" "$CLONE/deploy/data/"
touch "$CLONE/deploy/data/.gitkeep"

# Baked-in state is binary and can be large — always via LFS.
if ! grep -qs "saved_features.db" "$CLONE/.gitattributes"; then
  {
    echo "deploy/data/saved_features.db filter=lfs diff=lfs merge=lfs -text"
    echo "deploy/data/saved_feature_images/** filter=lfs diff=lfs merge=lfs -text"
  } >> "$CLONE/.gitattributes"
fi

git -C "$CLONE" add -A
if git -C "$CLONE" diff --cached --quiet; then
  echo "==> nothing to push"
  exit 0
fi
git -C "$CLONE" commit -m "sync from map-explorer@$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
git -C "$CLONE" push

echo "==> pushed. Build log: https://huggingface.co/spaces/$SPACE/logs/build"
