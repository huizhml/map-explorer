#!/usr/bin/env bash
# Cron-friendly supervisor for litestream replicate.
#
# Usage:
#   Manual:  bash supervise.sh
#   Cron:    * * * * * /home/ksb781/map-explorer/backend/ops/litestream/supervise.sh
#
# flock ensures only one replicate process runs. If litestream dies the lock
# releases and the next cron tick (<=60s) launches a fresh one. Logs to
# ~/litestream.log.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOCK="${HOME}/.litestream.lock"
LOG="${HOME}/litestream.log"
CONFIG="${HERE}/litestream.yml"
ENV_FILE="${HOME}/.litestream.env"
LITESTREAM_BIN="${HOME}/bin/litestream"

if [ ! -x "$LITESTREAM_BIN" ]; then
  echo "litestream not found at $LITESTREAM_BIN. Run install.sh first." >&2
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "Missing $ENV_FILE. Copy litestream.env.example and fill in R2 creds." >&2
  exit 1
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  # Another instance already replicating; nothing to do.
  exit 0
fi

echo "[$(date -Is)] starting litestream replicate" >> "$LOG"
exec "$LITESTREAM_BIN" replicate -config "$CONFIG" >> "$LOG" 2>&1
