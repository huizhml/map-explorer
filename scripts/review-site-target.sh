#!/usr/bin/env bash
# Where the review site is published when it lives outside this repository.
#
# Reads REVIEW_SITE_REPO (owner/name) and REVIEW_SITE_PATH (optional subfolder)
# and prints two KEY=value lines, for appending to $GITHUB_ENV:
#
#   REVIEW_SITE_BASE  the Vite --base, e.g. /vsm/
#   REVIEW_SITE_URL   the public URL,  e.g. https://huizhml.github.io/vsm/
#
# Pages serves a repository named <owner>.github.io at the domain root and any
# other at /<name>/, so the subfolder goes after whichever of those applies:
#
#   huizhml/huizhml.github.io  + vsm  →  /vsm/
#   huizhml/vsm                + —    →  /vsm/
#   huizhml/x                  + vsm  →  /x/vsm/
set -euo pipefail

repo="${REVIEW_SITE_REPO:?REVIEW_SITE_REPO is not set}"
path="${REVIEW_SITE_PATH:-}"
owner="${repo%%/*}"
name="${repo#*/}"

# The push step deletes and rewrites this folder in someone's homepage repo, so
# anything that could escape it, or name the whole repo, is refused outright.
if [ -n "$path" ] && ! [[ "$path" =~ ^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$ ]]; then
  echo "REVIEW_SITE_PATH='$path' must be a plain relative folder, e.g. vsm" >&2
  exit 1
fi

# Pages lowercases the owner in the hostname, and so must the comparison.
owner_lc="$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')"
name_lc="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
if [ "$name_lc" = "$owner_lc.github.io" ]; then
  # Without a subfolder the push step force-pushes the build over the whole
  # repository — which here is the homepage.
  if [ -z "$path" ]; then
    echo "$repo is a user site; set REVIEW_SITE_PATH (e.g. vsm) so the" >&2
    echo "review site goes into a folder of it instead of replacing it." >&2
    exit 1
  fi
  base="/"
else
  base="/$name/"
fi
[ -n "$path" ] && base="$base$path/"

echo "REVIEW_SITE_BASE=$base"
echo "REVIEW_SITE_URL=https://$owner_lc.github.io$base"
