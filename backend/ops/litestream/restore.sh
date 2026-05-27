#!/usr/bin/env bash
# Restore the latest replica from R2 to a local file.
#
# Defaults to a SIDE FILE so you don't accidentally overwrite the live DB.
# Inspect it first; if it looks right, stop the API, swap files, restart.
#
# Usage:
#   bash restore.sh                     # → ~/saved_features.restored.db
#   bash restore.sh /tmp/out.db
#   bash restore.sh /tmp/out.db -timestamp 2026-05-26T12:00:00Z

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${HERE}/litestream.yml"
ENV_FILE="${HOME}/.litestream.env"
LITESTREAM_BIN="${HOME}/bin/litestream"
LIVE_DB="/home/ksb781/map-explorer/backend/data/saved_features.db"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

OUT="${1:-${HOME}/saved_features.restored.db}"
shift || true

if [ "$OUT" = "$LIVE_DB" ]; then
  echo "Refusing to restore directly over the live DB. Pick a side path." >&2
  exit 1
fi

"$LITESTREAM_BIN" restore -config "$CONFIG" -o "$OUT" "$@" "$LIVE_DB"

echo
echo "Restored to: $OUT"
echo "Row count: $(sqlite3 "$OUT" 'SELECT COUNT(*) FROM saved_features;' 2>/dev/null || echo '(sqlite3 not on PATH; skip)')"
