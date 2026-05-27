#!/usr/bin/env bash
# Wrapper that loads ~/.litestream.env and execs litestream with your args.
# Use for any ad-hoc litestream command:
#   bash lsctl.sh snapshots /home/ksb781/map-explorer/backend/data/saved_features.db
#   bash lsctl.sh generations /home/ksb781/map-explorer/backend/data/saved_features.db
#   bash lsctl.sh wal /home/ksb781/map-explorer/backend/data/saved_features.db

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${HERE}/litestream.yml"
ENV_FILE="${HOME}/.litestream.env"
LITESTREAM_BIN="${HOME}/bin/litestream"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Copy litestream.env.example and fill in R2 creds." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

exec "$LITESTREAM_BIN" "$1" -config "$CONFIG" "${@:2}"
