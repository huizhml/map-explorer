#!/usr/bin/env bash
# Write a forwarding page: write-redirect.sh <file> <target-url>
#
# For URLs already handed out that the site has since moved away from. Carries
# any query string and hash across, so a shared map view survives the hop.
set -euo pipefail
file="${1:?file}"
target="${2:?target url}"
mkdir -p "$(dirname "$file")"
cat > "$file" <<HTML
<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=$target">
<link rel="canonical" href="$target">
<title>Moved</title>
<script>location.replace(new URL('$target', location.href) + location.search + location.hash)</script>
<p>This page has moved to <a href="$target">$target</a>.</p>
HTML
