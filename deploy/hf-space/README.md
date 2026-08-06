---
title: GVSM Map Explorer API
emoji: 🌳
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# GVSM Map Explorer — backend API

Read-only backend for the Global Vegetation Structure Map explorer. Serves
canopy-height tiles rendered from the public COGs at
`https://data.source.coop/geoai-ucph/gvsm/`, plus on-the-fly transect and
vertical-profile figures.

Frontend: <https://YOUR-GITHUB-USER.github.io/map-explorer/>

`PUBLIC_READONLY=1` is set, so all write endpoints and the filesystem-browsing
endpoints are disabled, and `url=` is confined to the source.coop prefix.
