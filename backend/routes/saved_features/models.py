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
    # Allow overriding year / q_index / source too, so the user can ask for a
    # different visualization than the one stored at save time (e.g., switch
    # to Q0 after the fact). Defaults come from the saved metadata.
    year: Optional[int] = None
    q_index: Optional[int] = None
    source: Optional[str] = None


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
    url: str
    rgb_bands: Optional[List[int]] = None
    colormap: Optional[str] = None
    rescale_min: Optional[float] = None
    rescale_max: Optional[float] = None
    bands: Optional[List[FigureBandSpec]] = None


class SaveAreaImagesRequest(BaseModel):
    extent_3857: List[float]
    format: Literal["jpg", "png"] = "png"
    layers: List[FigureLayerSpec]
    name: Optional[str] = Field(default=None, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    category: Optional[str] = Field(default=None, max_length=120)
    # Optional Google Satellite snapshot of the drawing area.
    # Uses the same `_stitch_bbox_satellite` retina-tile fetcher (scale=2)
    # as the transect figure, so the output is high-resolution. 8192 px ≈ one
    # extra zoom level vs. the transect default — saved exports are typically
    # used at full resolution, so we trade some bandwidth for sharper detail.
    include_google_satellite: bool = False
    google_satellite_max_width_px: int = 4096  # 8192


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
    include_enl_fhd: bool = True
    include_cr: bool = True
    # Optional: JRC TMF AnnualChanges (Dec 2020) for the same buffered bbox as
    # the satellite snapshot.  Renders as an additional sharex panel right
    # below the satellite map.  Shares `satellite_buffer_m`.
    include_ee_annualchanges: bool = False
    figure_width_px: int = 1200
    map_height_px: int = 220
    heatmap_height_px: int = 240
    enl_fhd_height_px: int = 300
    cr_height_px: int = 140
    ee_annualchanges_height_px: int = 220
    font_size: int = 11
    dpi: int = 150
    fmt: Literal["png", "jpg", "pdf"] = "png"
    satellite_buffer_m: float = 200.0
    # Higher resolution = sharper satellite imagery.  4096 px ≈ zoom level 17–18
    # for typical 200 m-buffered transects, which is near Google's max detail.
    satellite_max_width_px: int = 4096
