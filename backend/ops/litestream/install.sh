#!/usr/bin/env bash
# Install the Litestream binary into ~/bin (no root required).
#
# Run on hendrix:
#   cd ~/map-explorer/backend/ops/litestream && bash install.sh
#
# Override version: LITESTREAM_VERSION=0.3.13 bash install.sh

set -euo pipefail

VERSION="${LITESTREAM_VERSION:-0.3.13}"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)        ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

BIN_DIR="${HOME}/bin"
mkdir -p "$BIN_DIR"

TARBALL="litestream-v${VERSION}-linux-${ARCH}.tar.gz"
URL="https://github.com/benbjohnson/litestream/releases/download/v${VERSION}/${TARBALL}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP/$TARBALL"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
install -m 0755 "$TMP/litestream" "$BIN_DIR/litestream"

echo
echo "Installed: $("$BIN_DIR/litestream" version)"
echo "Binary:    $BIN_DIR/litestream"
echo
echo "Next steps:"
echo "  1) cp litestream.env.example ~/.litestream.env  (then fill in R2 creds, chmod 600)"
echo "  2) bash supervise.sh   # one-shot start; ctrl-c to stop"
echo "  3) Or add to crontab:  * * * * * $PWD/supervise.sh"
