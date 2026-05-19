"""Pydantic request/response schemas for the saved-features endpoints."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class GeometryPayload(BaseModel):
    type: Literal["Point", "LineString", "Polygon"]
    coordinates: Any


class SavedFeatureCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    category: Optional[str] = Field(default=None, max_length=120)
    geometry: GeometryPayload
    metadata: Optional[Dict[str, Any]] = None
    plot_data: Optional[Dict[str, Any]] = None
    # Free-form labels merged into `metadata.tags`. Casing is preserved
    # (first-seen wins across the table); dedupe is case-insensitive on save.
    tags: Optional[List[str]] = None


class GeometryLookupRequest(BaseModel):
    """Lookup payload used by the save dialog to prefill from an existing save
    of the same geometry."""

    geometry: GeometryPayload


class SavedFeatureUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    tags: Optional[List[str]] = None


class RefreshPredictionSnapshotRequest(BaseModel):
    """Optional caller overrides for re-rendering a saved point's prediction
    snapshot. When fields are omitted the saved feature's existing metadata is
    used; the snapshot function itself falls back to the live-map defaults
    (0..500, inferno) when neither caller nor metadata supplies them."""

    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None
    colormap: Optional[str] = None
    # Allow overriding year / q_index / version too, so the user can ask for a
    # different visualization than the one stored at save time (e.g., switch
    # to Q0 after the fact, or re-render under a different pipeline version).
    # Defaults come from the saved metadata.
    year: Optional[int] = None
    q_index: Optional[int] = None
    version: Optional[str] = None


class FigureBandSpec(BaseModel):
    band_index: int
    band_name: Optional[str] = None
    colormap: Optional[str] = None
    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None


class FigureLayerSpec(BaseModel):
    layer_id: str
    name: str
    layer_type: Optional[str] = None
    # Fine-grained subtype used to route non-COG layers (e.g. WMTS tile
    # services like EOX s2cloudless) through a tile-stitcher instead of
    # `rasterio.open(url)`. Examples: 's2cloudless_mosaic', 'diversity_indices'.
    layer_subtype: Optional[str] = None
    url: str
    rgb_bands: Optional[List[int]] = None
    colormap: Optional[str] = None
    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None
    bands: Optional[List[FigureBandSpec]] = None
    # Vintage of the layer when applicable (e.g. EOX `s2cloudless-<year>`).
    year: Optional[int] = None


class SaveAreaImagesRequest(BaseModel):
    extent_3857: List[float]
    format: Literal["jpg", "png", "pdf"] = "png"
    layers: List[FigureLayerSpec]
    name: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    category: Optional[str] = Field(default=None, max_length=120)
    tags: Optional[List[str]] = None
    # Optional Google Satellite snapshot of the drawing area.
    # Uses the same `_stitch_bbox_satellite` retina-tile fetcher (scale=2)
    # as the transect figure, so the output is high-resolution. 8192 px ≈ one
    # extra zoom level vs. the transect default — saved exports are typically
    # used at full resolution, so we trade some bandwidth for sharper detail.
    include_google_satellite: bool = False
    google_satellite_max_width_px: int = 4096  # 8192


class RefreshAreaImagesRequest(BaseModel):
    """Re-render every image attached to a saved area_images feature.

    By default the endpoint reproduces the *original* export: it reads the
    layer list, render format, and extent that were persisted in the feature's
    plot_data at save time. Every field here is an optional override for that
    stored state (rarely needed); when omitted the stored value is used.
    """

    layers: Optional[List[FigureLayerSpec]] = None
    format: Optional[Literal["jpg", "png", "pdf"]] = None
    include_google_satellite: Optional[bool] = None
    google_satellite_max_width_px: Optional[int] = None
    extent_3857: Optional[List[float]] = None
    # When true, crop the (Web-Mercator) extent to a square on its shortest
    # side, centred on the original extent, and rewrite the feature's polygon
    # geometry to match before re-rendering.
    square: Optional[bool] = None


class TransectSatelliteRequest(BaseModel):
    min_lon: float
    max_lon: float
    min_lat: float
    max_lat: float
    buffer_m: float = 200.0
    max_width_px: int = 2048


class TransectProfilePoint(BaseModel):
    rh: int
    value: Optional[float] = None
    missing: Optional[bool] = None


class TransectFigureSample(BaseModel):
    lon: float
    lat: float
    distance_m: Optional[float] = None
    profile: List[TransectProfilePoint] = Field(default_factory=list)
    fhd: Optional[float] = None
    enl1d: Optional[float] = None
    enl2d: Optional[float] = None
    cr: Optional[float] = None


class TransectFigureRequest(BaseModel):
    samples: List[TransectFigureSample]
    x_axis: Literal["lon", "lat"] = "lon"
    height_bin_m: float = 5.0
    heatmap_max_height_m: float = 50.0
    heatmap_colormap_max: float = 10.0
    include_map: bool = True
    include_heatmap: bool = True
    # Per-line toggles for the merged metrics panel (FHD / 1D ENL / 2D ENL / CR).
    # The panel is rendered iff at least one of these is True.  By default all
    # four lines share the (left) y-axis with integer ticks; flip
    # `cr_own_yaxis` to put CR back on its own twin right y-axis (0..1.1)
    # when it's selected alongside any of the other three.
    show_fhd: bool = True
    show_enl1d: bool = True
    show_enl2d: bool = True
    show_cr: bool = True
    # When True AND CR is plotted alongside another metric, CR moves to a
    # `twinx()` right y-axis with its own 0..1.1 scale (matches the previous
    # behaviour); when False, CR shares the left axis with FHD/ENL.  Ignored
    # when CR is the only selected metric (it gets the primary axis either way).
    cr_own_yaxis: bool = False
    # Optional: JRC TMF AnnualChanges (Dec 2020) for the same buffered bbox as
    # the satellite snapshot.  Renders as an additional sharex panel right
    # below the satellite map.  Shares `satellite_buffer_m`.
    include_ee_annualchanges: bool = False
    figure_width_px: int = 1200
    map_height_px: int = 220
    heatmap_height_px: int = 240
    # Height of the merged metrics panel (was previously split across
    # `enl_fhd_height_px` + `cr_height_px`; kept the same name to minimise
    # frontend churn — the CR-only panel is gone).
    enl_fhd_height_px: int = 300
    ee_annualchanges_height_px: int = 220
    font_size: int = 11
    dpi: int = 150
    fmt: Literal["png", "jpg", "pdf"] = "png"
    satellite_buffer_m: float = 200.0
    # Higher resolution = sharper satellite imagery.  4096 px ≈ zoom level 17–18
    # for typical 200 m-buffered transects, which is near Google's max detail.
    satellite_max_width_px: int = 4096
    # Which basemap to fetch for the "Map snapshot" panel.
    #   - "google"        → Google Satellite HD tiles (default; pre-EOX behaviour).
    #   - "eox_s2cloudless" → EOX `s2cloudless-<eox_year>_3857` mosaic (cloud-free Sentinel-2).
    basemap_source: Literal["google", "eox_s2cloudless"] = "google"
    # Year for the EOX `s2cloudless-<year>` layer; ignored unless
    # `basemap_source == "eox_s2cloudless"`. EOX publishes 2016, 2018–2024.
    eox_year: int = 2020
    # Brightness factor for the EOX mosaic (gamma applied to the stitched RGB,
    # via `out = in ** (1/eox_brightness)`). `1.0` = source pixels untouched,
    # values > 1 lift midtones without clipping highlights, < 1 darkens.
    # Default tuned for the typical forest-canopy under-exposure of s2cloudless.
    # Ignored when `basemap_source != "eox_s2cloudless"`.
    eox_brightness: float = 1.3


class VerticalProfileCurvePoint(BaseModel):
    z: float
    value: float


class VerticalProfileFigureRequest(BaseModel):
    """Single-panel matplotlib export of the derived vertical-profile curve.

    Mirrors the TransectFigureRequest size/font/format/dpi knobs so the
    frontend dialog can reuse the same preview(dpi=90) / export(dpi=150) split.
    """
    curve: List[VerticalProfileCurvePoint]
    title: Optional[str] = None
    x_label: str = "Energy (%)"
    y_label: str = "Height (m)"
    line_color: str = "#2e7d32"
    figure_width_px: int = 900
    figure_height_px: int = 700
    font_size: int = 12
    dpi: int = 150
    fmt: Literal["png", "jpg", "pdf"] = "png"
