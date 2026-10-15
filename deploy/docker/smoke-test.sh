#!/usr/bin/env bash
# Post-deploy checks against a public backend URL.
#
#   bash deploy/docker/smoke-test.sh https://map-explorer-api-xxxx.run.app
#
# Verifies that the app is up, that a real tile renders from source.coop, and
# — most importantly — that the read-only guard is actually engaged. A backend
# that serves tiles but leaves `url=` open is worse than one that is down.
set -uo pipefail

BASE="${1:?Usage: smoke-test.sh <backend-url>}"
BASE="${BASE%/}"
COG="https://data.source.coop/geoai-ucph/gvsm/2020/01GEL/RH98_Q1.tif"

pass=0
fail=0

check() {  # check <name> <expected-code> <curl-args...>
  local name="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$@")
  if [ "$got" = "$want" ]; then
    printf '  \033[32mok\033[0m   %-46s %s\n' "$name" "$got"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m %-46s got %s, want %s\n' "$name" "$got" "$want"
    fail=$((fail + 1))
  fi
}

echo "== liveness =="
check "GET /deploy/status" 200 "$BASE/deploy/status"
echo "     read_only: $(curl -s --max-time 60 "$BASE/deploy/status" | tr -d ' ')"

echo "== data path (source.coop) =="
check "GET /cog/info" 200 "$BASE/cog/info?url=$COG"
check "GET /cog/tiles z12" 200 \
  "$BASE/cog/tiles/WebMercatorQuad/12/42/2618.png?url=$COG&rescale=0,500&colormap_name=inferno"
check "GET /cog/point" 200 "$BASE/cog/point/-176.3067,-44.7450?url=$COG"

echo "== guard: url allowlist =="
check "url=/etc/passwd" 403 "$BASE/cog/info?url=/etc/passwd"
check "url=cloud metadata" 403 "$BASE/cog/info?url=http://169.254.169.254/"
check "url=arbitrary host" 403 "$BASE/cog/info?url=https://example.com/x.tif"
check "url_high=/etc/passwd" 403 \
  "$BASE/predictions/interval-tile/WebMercatorQuad/12/42/2618?url_high=/etc/passwd&url_low=/etc/passwd"

echo "== guard: filesystem endpoints =="
check "GET /auxiliary/list-dirs" 403 "$BASE/auxiliary/list-dirs?path=/"
check "GET /fgb/path" 403 "$BASE/fgb/path?path=/etc/passwd"

echo "== guard: writes =="
check "POST /saved-features" 403 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/saved-features"
check "DELETE /saved-features/1" 403 -X DELETE "$BASE/saved-features/1"
check "PATCH /saved-features/1" 403 -X PATCH -H 'Content-Type: application/json' -d '{}' "$BASE/saved-features/1"
check "POST refresh-area-images" 403 -X POST "$BASE/saved-features/1/refresh-area-images"
check "POST /auxiliary/save-figures" 403 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/auxiliary/save-figures"

echo "== reads that must survive read-only =="
check "GET /saved-features" 200 "$BASE/saved-features"

echo "== tile caching =="
# Without Cache-Control the browser re-fetches every tile on every pan, and each
# miss costs a 2-4 s round trip to source.coop.
cc=$(curl -s --max-time 120 -D - -o /dev/null \
  "$BASE/cog/tiles/WebMercatorQuad/11/687/1110.png?url=https://data.source.coop/geoai-ucph/gvsm/2020/21LTD/RH98_Q1.tif&rescale=0,500&colormap_name=inferno" \
  | tr -d '\r' | awk 'tolower($1)=="cache-control:"{$1="";sub(/^ /,"");print}')
if [ -n "$cc" ]; then
  printf '  \033[32mok\033[0m   %-46s %s\n' "tile Cache-Control" "$cc"
  pass=$((pass + 1))
else
  printf '  \033[31mFAIL\033[0m %-46s %s\n' "tile Cache-Control" "absent"
  fail=$((fail + 1))
fi

report() {  # report <ok?> <name> <detail>
  if [ "$1" = 1 ]; then
    printf '  \033[32mok\033[0m   %-46s %s\n' "$2" "$3"; pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m %-46s %s\n' "$2" "$3"; fail=$((fail + 1))
  fi
}

# The frontend asks for 512 px tiles (src/map/tiles.ts). A PNG's width is the
# 4 bytes at offset 16, in the IHDR chunk.
TILE512="$BASE/cog/tiles/WebMercatorQuad/11/687/1110.png?url=https://data.source.coop/geoai-ucph/gvsm/2020/21LTD/RH98_Q1.tif&rescale=0,500&colormap_name=inferno&tilesize=512"
width=$(curl -s --max-time 120 "$TILE512" | head -c 24 | tail -c 4 | od -An -tu1 | awk 'NF{print $1*16777216+$2*65536+$3*256+$4}')
[ "$width" = 512 ] && ok=1 || ok=0
report $ok "tilesize=512 tile width" "${width:-none}"

# Same URL again: the server cache (tile_cache.py) should answer it. A MISS can
# also mean the request landed on a second instance — rerun before worrying.
hit=$(curl -s --max-time 120 -D - -o /dev/null "$TILE512" \
  | tr -d '\r' | awk 'tolower($1)=="x-tile-cache:"{print $2}')
[ "$hit" = HIT ] && ok=1 || ok=0
report $ok "server tile cache, repeat request" "${hit:-header absent}"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ] || exit 1
