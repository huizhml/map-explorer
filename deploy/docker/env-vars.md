# Environment variables for the public read-only deployment

The same set on every host; only how you set them differs:

- **Cloud Run** — `--set-env-vars` / `--set-secrets` (see [README.md](README.md))
- **HF Space** — Settings → Variables and secrets
- **VM** — an `--env-file` kept outside the repo

## Variables

| Name | Value | Why |
|---|---|---|
| `PUBLIC_READONLY` | `1` | Installs the guard in `backend/deploy_guard.py`: blocks writes, `/auxiliary/list-dirs`, `/auxiliary/save-figures`, `/fgb/path`, and restricts `url=`. |
| `ALLOWED_DATA_URL_PREFIXES` | `https://data.source.coop/geoai-ucph/gvsm/` | Whitelist for `url` / `url_high` / `url_low`. Without it TiTiler will happily open `/etc/passwd` or an internal address. Comma-separate to add more. |
| `PREDICTIONS_BASE_URL` | `https://data.source.coop/geoai-ucph/gvsm` | Base for remote COGs. |
| `PREDICTIONS_REMOTE_PATH_TEMPLATE` | `{year}/{tile}/RH{rh}_Q{q}.tif` | Matches the actual layout on source.coop (the default in `predictions.py` has a `{zone}-{year}` prefix, which is the internal layout — it does **not** match). |
| `PREDICTIONS_MOSAIC_REMOTE_URL` | `https://data.source.coop/geoai-ucph/gvsm/mosaics/{year}/RH{rh}_Q{q}.tif` | Global ~1 km overview (0.01°, EPSG:4326, COG/ZSTD), shown below the per-tile zoom threshold. 101 RH levels, **Q1 only** — Q0/Q2 and interval halves 404, and `/predictions/mosaic-url` now reports that instead of returning a URL that renders as blank tiles. |
| `VERTICAL_PROFILE_WORKERS` | `12` | Default is 28. Each worker opens a separate COG over HTTP; 28 concurrent /vsicurl readers on 2 vCPU is counterproductive. |
| `PREDICTIONS_LOCAL_YEARS` | *(leave unset)* | Years served from local disk. Unset → every year comes from `PREDICTIONS_BASE_URL`, which is what a public deployment wants. |

> ### ⚠️ This one also affects the internal deployment
>
> `PREDICTIONS_LOCAL_YEARS` replaces the hardcoded `year == 2020` branches that
> used to decide local-vs-remote. **Add `PREDICTIONS_LOCAL_YEARS=2020` to the
> hendrix/lumi environment** — without it, that host will start fetching 2020
> from the network instead of its local disk.
>
> Affected call sites: `/predictions/load`, `/predictions/mosaic-url`,
> `/predictions/vertical-profile{,-line}`, and the saved-feature point snapshots.

## Secrets

| Name | Value |
|---|---|
| `EE_SERVICE_ACCOUNT_JSON` | The full service-account JSON, pasted as one line. `entrypoint.sh` writes it to a file and points `GOOGLE_APPLICATION_CREDENTIALS` at it. |
| `GOOGLE_STATIC_MAPS_API_KEY` | Only if you want the Google satellite basemap in transect figures. Restrict the key to this Space's referrer/IP first. |

## Deliberately not set

`PREDICTIONS_LOCAL_PATH`, `PREDICTIONS_MOSAIC_LOCAL_PATH`, `GEDI_LOCAL_BASE_PATH`,
`ALS_LOCAL_PATH`, `LVIS_LOCAL_PATH`, `DISTANCE_MAPS_LOCAL_BASE_PATH`,
`CR_LOCAL_BASE_PATH`, `DIVERSITY_INDICES_LOCAL_PATH`, `NATURALNESS_MAP_PATH`,
`NATURALNESS_REF_DATA_PATH`, `NATURALNESS_REF_DATA_VAL_PATH`, `S2_GRID_LOCAL_PATH`.

These point at HPC-local files. Unset, the corresponding endpoints return a clear
"env var is not set" error rather than crashing — so those sidebar layers are
simply dead on the public deployment until the data is uploaded somewhere public.

## Still open

**The global mosaic.** For a local year, `/predictions/mosaic-url` reads a single
pre-built mosaic file (`PREDICTIONS_MOSAIC_LOCAL_PATH`). No such file exists on
source.coop and `PREDICTIONS_MOSAIC_REMOTE_URL` has nothing to point at, so the
low-zoom overview is unavailable publicly until you publish either a global
overview COG or a MosaicJSON index alongside the tiles.

**Vertical profiles sample RH0–RH100** — 101 COG opens per point. source.coop
currently carries 35 RH levels per tile; the rest resolve to 404s that are
swallowed as gaps. Harmless but wasteful; re-check once the upload finishes.
