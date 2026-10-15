"""
Compute per-pixel Foliage Height Diversity (Shannon entropy of RH profile)
from 101-band GEDI-like rasters.

Fully vectorized — no for loops, no JAX, no numba.
Uses VRT + rasterio windowed reads for fast I/O and
ProcessPoolExecutor for true parallel CPU compute.

Dependencies: numpy, rasterio, gdal, scipy, psutil
Optional: stackstac, pystac, xarray, rioxarray (for STAC-based workflow)
"""

import glob
import rasterio
from rasterio.windows import Window
import numpy as np
from pathlib import Path
from scipy.interpolate import interp1d
from scipy.signal import savgol_filter
from scipy.ndimage import uniform_filter1d
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
import threading
import psutil
import os
import time
import pandas as pd

MAX_HEIGHT_METERS = 150 # 100.0
# Diversity indices (FHD / ENL / CR) — one rule set for every code path (map
# tiles, point click, transect, GEDI): RH0..RH100 indexed by RH number, RH >= 0
# counted, RH > MAX_HEIGHT_METERS clipped to it, CR from RH25 and RH98.
N_RH = 101
RH25_INDEX = 25
RH98_INDEX = 98
# RH0 is always negative (below ground), so it never enters the diversity
# indices; the VRT and the transect skip reading it. VRT band i (0-based) is
# RH(VRT_FIRST_RH + i).
VRT_FIRST_RH = 1
VRT_N_BANDS = N_RH - VRT_FIRST_RH
# Meters: y-axis extent for transect RH heatmap only (diversity indices use MAX_HEIGHT).
HEATMAP_MAX_HEIGHT = 50.0
# Meters: bounds for the point vertical-profile curve so it also shows the
# below-0 (ground / near-ground return) tail. Diversity indices still ignore
# RH <= 0 — these constants only affect the displayed profile curve.
PROFILE_MIN_HEIGHT = -10.0
PROFILE_MAX_HEIGHT = 50.0
# Meters: height-bin spacing for the profile curve (vertical_profile bin_size).
PROFILE_BIN_SIZE = 0.4
# Savitzky-Golay window (odd sample count) for smoothing the point-click curve;
# larger = smoother.
PROFILE_SMOOTH_WINDOW = 5
N_BINS = 20
BIN_WIDTH = MAX_HEIGHT_METERS / N_BINS
VSM_NODATA = 32767
NODATA_OUT = -9999.0
stac_collection_dir = '~/data/gvs/products/gvsm_stac_catalog/vsm_local'

def pixel_hist(rhs: np.ndarray, interval: int = 5, max_height: float = None, min_height: float = 0.0):
    """
    Compute per-pixel histogram of RH values over [min_height, max_height].

    Used for the displayed profile / heatmap only (diversity indices bin in
    `pixel_diversity_indices`). min_height defaults to 0 and RH <= min_height
    is dropped, so the ground return doesn't dominate the heatmap. The point
    curve passes a negative min_height to also show the below-0 tail.
    """
    n_bins = int((max_height - min_height) / interval)
    rhs_arr = np.asarray(rhs, dtype=np.float32)
    valid = np.isfinite(rhs_arr) & (rhs_arr > min_height) # NOTE: Ignore NaN/Inf and values at/below min_height
    rhs_valid = rhs_arr[valid]
    if rhs_valid.size == 0:
        return np.nan, np.nan, np.nan, np.nan
    rhs_valid = np.clip(rhs_valid, min_height, max_height) # NOTE: count very tall trees
    hist, bins = np.histogram(rhs_valid, bins=n_bins, range=(min_height, max_height))
    return hist, bins


def pixel_vertical_profile(rhs, interval=1, max_height=50, min_height=0.0):
    """
    Compute per-pixel vertical profile over [min_height, max_height].

    min_height defaults to 0 to preserve the transect-heatmap shape; the
    point-click curve passes PROFILE_MIN_HEIGHT to include the below-0 tail.
    Bin i spans [min_height + i*interval, ...]; callers map index -> height.
    """
    if isinstance(rhs, pd.Series):
        rhs = rhs.values
    hist, bins = pixel_hist(rhs, interval, max_height, min_height=min_height)
    return hist


def pixel_diversity_indices(rhs, bin_width=5, max_height=MAX_HEIGHT_METERS):
    """
    Per-pixel FHD / 1D ENL / 2D ENL / CR — same rules as `_chunk_diversity`.

    rhs: RH0..RH100 in METRES, indexed by RH number (rhs[i] is RH i); missing
    values are None/NaN and keep their slot, so CR always reads RH25/RH98.
    RH >= 0 are binned over [0, max_height]; RH > max_height is clipped to it.
    """
    rhs = np.array([np.nan if v is None else v for v in rhs], dtype=np.float64)
    rhs = np.minimum(rhs, max_height)  # NaN stays NaN
    above = rhs[np.isfinite(rhs) & (rhs >= 0)]
    if above.size == 0:
        fhd = enl1d = enl2d = np.nan
    else:
        hist, _ = np.histogram(
            above, bins=int(max_height / bin_width), range=(0.0, max_height),
        )
        p = hist / hist.sum()
        p = p[p > 0]
        fhd = float(-np.sum(p * np.log(p)))
        enl1d = float(np.exp(fhd))
        enl2d = float(1.0 / np.sum(p ** 2))

    rh25 = rhs[RH25_INDEX] if rhs.size > RH25_INDEX else np.nan
    rh98 = rhs[RH98_INDEX] if rhs.size > RH98_INDEX else np.nan
    if np.isfinite(rh25) and np.isfinite(rh98) and rh98 > 0:
        cr = float((rh98 - max(rh25, 0.0)) / rh98)
    else:
        cr = np.nan

    return fhd, enl1d, enl2d, cr

def prepare_rh_profile(rh_datacube):
    """
    Prepare the RH datacube for binning. This includes:
    - Converting nodata values to NaN
    - Converting from decimeters to meters
    - Masking out invalid profiles (all nodata, infinite, negative, or unrealistic values)
    NOTE: rh_datacube should have 4 dimensions (n, rows, cols, bands)
    """
    n_batch, n_bands, n_rows, n_cols = rh_datacube.shape
    dtype = rh_datacube.dtype
    # reshape
    rh_datacube = rh_datacube.transpose(0, 2, 3, 1).astype(np.float32)
    rh_datacube[rh_datacube == VSM_NODATA] = np.nan
    if dtype == np.int16: # rh_datacube is in decimeters, convert to meters
        rh_datacube = rh_datacube/10
    return rh_datacube, n_batch, n_bands, n_rows, n_cols

def mask_rh_profile(rh_datacube):
    """
    This masking is for calculating diversity indices, which only count RH >= 0
    in range [0, max_height].
    A pixel whose RH metrics are all nodata / infinite / negative is masked out as nodata.
    Negative values won't be counted later.
    Values above max_height are clipped to max_height by the caller (not masked).
    NOTE: rh_datacube should be in meters, nodata should be nan!!! rh_datacube should have 4 dimensions (n, rows, cols, bands)
    """
    valid = np.isfinite(rh_datacube) & (rh_datacube >= 0) # all 101 RH metrics <0 should be invalid
    nodata_mask = valid.sum(axis=-1) == 0 # (n, rows, cols) True for nodata pixels, False for valid pixels
    n, rows, cols, bands = rh_datacube.shape
    n_pixels = n * rows * cols
    pixel_valid = nodata_mask.reshape(n_pixels, 1) == False
    tile_flat = rh_datacube.reshape(n_pixels, bands) # (n_pixels, n_bands)
    tile_clean = np.where(pixel_valid, tile_flat, -1.0)
    band_valid_flat = valid.reshape(n_pixels, bands) & pixel_valid     # per-band AND per-pixel
    return tile_clean, nodata_mask, band_valid_flat, n_pixels


def batch_binning(tile, bin_width=5, max_height=MAX_HEIGHT_METERS):
    """
    Vectorized binning for a batch of spatial chunks using searchsorted.
    tile: (n, rows, cols, bands) in meters, nodata as NaN, already clipped to max_height.
    """
    n_batch, n_rows, n_cols, n_bands = tile.shape
    tile_clean, nodata_mask, _, n_pixels = mask_rh_profile(tile) # (n_pixels, n_bands), nodata pixels as -1.0, which is smaller than 0 and won't be counted in the histogram later.
    
    # Sort along axis=1 (bands)
    profiles = np.sort(tile_clean, axis=1)
    profiles = np.ascontiguousarray(profiles)

    lower_edges = np.arange(0, max_height, bin_width)
    upper_edges = np.arange(bin_width, max_height + bin_width, bin_width)

    idx_low = np.stack(
        [np.searchsorted(profiles[i, :], lower_edges, side='left') for i in range(n_pixels)]
    ) # (n_pixels, n_bins)
    idx_high = np.stack(
        [np.searchsorted(profiles[i, :], upper_edges, side='left') for i in range(n_pixels)]
    )
    idx_high[:, -1] = np.array(
        [np.searchsorted(profiles[i, :], upper_edges[-1:], side='right')[0] for i in range(n_pixels)]
    )
    hist = (idx_high - idx_low).astype(np.float32) # (n_pixels, n_bins)
    n_bins = int(max_height / bin_width)
    hist = hist.reshape(n_batch, n_rows, n_cols, n_bins)

    return hist, nodata_mask


def _chunk_diversity(data, bin_width=5, max_height=MAX_HEIGHT_METERS):
    """
    Vectorized Shannon entropy for a single spatial chunk. data is in decimeters.

    Parameters
    ----------
    tile : ndarray, shape (101, rows, cols)

    Returns
    -------
    out : ndarray, shape (rows, cols), float32
    """
    if len(data.shape) == 3:
        data = data[None, ...]  # add band dimension for consistency

    n_batch, n_bands, n_rows, n_cols = data.shape
    if n_bands != VRT_N_BANDS:
        raise ValueError(f"Expected {VRT_N_BANDS} bands (RH{VRT_FIRST_RH}..RH100), got {n_bands}")
    rh_m, *_ = prepare_rh_profile(data)  # (n, rows, cols, bands) in meters, nodata as NaN
    rh_m = np.minimum(rh_m, max_height)  # clip tall values (NaN stays NaN)
    hist, nodata_mask = batch_binning(rh_m, bin_width=bin_width, max_height=max_height)

    # Normalize
    total = hist.sum(axis=-1, keepdims=True)
    total = np.where(total > 0, total, 1.0)
    p = hist / total

    # FHD
    log_p = np.where(p > 0, np.log(p), 0.0)
    fhd = -np.sum(p * log_p, axis=-1).astype(np.float32)

    # ENL1D
    enl1d = np.exp(fhd).astype(np.float32)

    # ENL2D
    sum_p2 = np.sum(np.where(p > 0, p ** 2, 0.0), axis=-1)
    enl2d = np.where(sum_p2 > 0, 1.0 / sum_p2, np.nan).astype(np.float32)

    # CR — band i is RH(VRT_FIRST_RH + i) (see create_vrt).
    rh25 = np.maximum(rh_m[..., RH25_INDEX - VRT_FIRST_RH], 0)
    rh98 = rh_m[..., RH98_INDEX - VRT_FIRST_RH]
    with np.errstate(invalid="ignore", divide="ignore"):
        cr = np.where(rh98 > 0, (rh98 - rh25) / rh98, np.nan).astype(np.float32)

    fhd = fhd.reshape(n_batch, n_rows, n_cols)
    enl1d = enl1d.reshape(n_batch, n_rows, n_cols)
    enl2d = enl2d.reshape(n_batch, n_rows, n_cols)
    cr = cr.reshape(n_batch, n_rows, n_cols)
    # Apply nodata
    fhd[nodata_mask] = np.nan
    enl1d[nodata_mask] = np.nan
    enl2d[nodata_mask] = np.nan
    cr[nodata_mask] = np.nan
    return fhd[0], enl1d[0], enl2d[0], cr[0]


def _process_tile(args):
    """
    Worker function for ProcessPoolExecutor.
    Each worker opens its own file handle (required for multiprocessing).
    Reads all 101 bands for one window in a single call, computes entropy.
    """
    vrt_path, col_off, row_off, w, h, bin_width = args
    with rasterio.open(vrt_path, "r") as src:
        window = Window(col_off, row_off, w, h)
        tile = src.read(window=window)#.astype(np.float32)  # (101, h, w)
    ent, enl1d, enl2d, cr = _chunk_diversity(tile, bin_width=bin_width)
    return ent, enl1d, enl2d, cr, col_off, row_off, w, h


def compute_entropy(output_path: Path=None, tile_id:str=None, year:int=None, vrt_path=None,
                         chunk_size=512, max_workers=8, bin_width=5, **kwargs):
    """
    Compute per-pixel FHD entropy — fast version.

    Two key speedups over the stackstac version:
    1. VRT + rasterio windowed read: single I/O call reads all 101 bands
       for a spatial window (vs stackstac opening 101 separate COGs)
    2. ProcessPoolExecutor: true CPU parallelism for entropy computation
       (vs ThreadPoolExecutor which is GIL-limited for numpy)

    Parameters
    ----------
    output_path : str
        Output single-band GeoTIFF path.
    tile_id : str
        Tile identifier (e.g. '36NTF').
    year : int
        Year for file lookup.
    vrt_path : str, optional
        Path to 101-band VRT. If None, auto-creates from tile directory.
    chunk_size : int
        Spatial chunk size in pixels.
    max_workers : int
        Number of parallel processes.
    """
    output_path = Path(output_path).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        return

    # Create VRT if not provided
    if vrt_path is None:
        tile_dir = f"~/data/gvs/products/vsm/{year}/original/tiles/cog/{tile_id}" # TODO
        vrt_path = f"~/data/gvs/products/vsm/{year}/original/vrt/{tile_id}_Q1.vrt"
        create_vrt(tile_dir, vrt_path)

    vrt_path = str(Path(vrt_path).expanduser())

    # Get metadata from VRT
    with rasterio.open(vrt_path, "r") as src:
        ny = src.height
        nx = src.width
        crs = src.crs
        transform = src.transform
        n_bands = src.count
        print(f"VRT: {nx}x{ny}, {n_bands} bands, dtype={src.dtypes[0]}")

    assert vrt_is_current(vrt_path), (
        f"{vrt_path} is not an RH{VRT_FIRST_RH}..RH100 VRT (old VRTs were "
        f"RH0..RH99) — delete it and rebuild with create_vrt"
    )

    out_profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "height": ny,
        "width": nx,
        "count": 4,
        "crs": crs,
        "transform": transform,
        "nodata": NODATA_OUT,
        "compress": None,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
    }

    # Build work items
    work_items = []
    for row_off in range(0, ny, chunk_size):
        for col_off in range(0, nx, chunk_size):
            h = min(chunk_size, ny - row_off)
            w = min(chunk_size, nx - col_off)
            # ent, enl1d, enl2d = _process_tile((vrt_path, col_off, row_off, w, h, bin_width))
            work_items.append((vrt_path, col_off, row_off, w, h, bin_width))

    print(f"Processing {len(work_items)} tiles with {max_workers} processes")
    print(f"Estimated peak RAM: ~{max_workers * 100 * chunk_size**2 * 4 / 1e9:.1f} GB")

    monitor = ProgressMonitor(total_tiles=len(work_items), interval=5.0)

    with (rasterio.open(output_path, "w", **out_profile) as dst):
        monitor.start()
        try:
            with ProcessPoolExecutor(max_workers=max_workers) as pool:
                futures = {
                    pool.submit(_process_tile, item): i
                    for i, item in enumerate(work_items)
                }
                for fut in as_completed(futures):
                    ent, enl1d, enl2d, cr, col_off, row_off, w, h = fut.result()
                    win = Window(col_off, row_off, w, h)
                    # _chunk_diversity uses NaN as the in-memory nodata sentinel;
                    # swap to NODATA_OUT at the I/O boundary so the pixels on
                    # disk match the file's declared `nodata` tag (otherwise
                    # tilers see "nodata=-9999" but find NaN pixels and render
                    # them as the bottom of the color ramp).
                    stack = np.stack([ent, enl1d, enl2d, cr], axis=0)
                    stack = np.where(np.isfinite(stack), stack, NODATA_OUT).astype(np.float32)
                    dst.write(stack, window=win)
                    monitor.tick()
        finally:
            dst.set_band_description(1, "fhd")
            dst.set_band_description(2, "enl1d")
            dst.set_band_description(3, "enl2d")
            dst.set_band_description(4, "cr")
            monitor.stop()

    print(f"Done: {output_path}")
    return output_path



class ProgressMonitor:
    """Background thread that prints speed and RAM stats."""

    def __init__(self, total_tiles, interval=5.0):
        self.total = total_tiles
        self.done = 0
        self.interval = interval
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._start_time = time.time()
        self._process = psutil.Process(os.getpid())
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def tick(self):
        with self._lock:
            self.done += 1

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2)

    def _run(self):
        while not self._stop.wait(self.interval):
            self._print_status()
        self._print_status()

    def _print_status(self):
        with self._lock:
            done = self.done
        elapsed = time.time() - self._start_time
        mem = self._process.memory_info()
        rss_gb = mem.rss / (1024 ** 3)
        try:
            for child in self._process.children(recursive=True):
                rss_gb += child.memory_info().rss / (1024 ** 3)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        rate = done / elapsed if elapsed > 0 else 0
        eta = (self.total - done) / rate if rate > 0 else float('inf')
        pct = 100 * done / self.total if self.total > 0 else 0
        print(
            f"  [{done}/{self.total}] {pct:5.1f}% | "
            f"{rate:.2f} tiles/s | "
            f"elapsed {elapsed:.0f}s | "
            f"ETA {eta:.0f}s | "
            f"RAM {rss_gb:.2f} GB (total)"
        )




def vrt_is_current(vrt_path) -> bool:
    """True if the VRT holds RH1..RH100 in order (create_vrt labels each band)."""
    with rasterio.open(Path(vrt_path).expanduser()) as src:
        return src.descriptions == tuple(f"RH{rh}" for rh in range(VRT_FIRST_RH, N_RH))


def create_vrt(tile_dir, vrt_path, q_idx="1"):
    # Imported lazily: the osgeo bindings need a system GDAL, which the slim
    # deployment image doesn't ship. This is the only function that needs them.
    from osgeo import gdal

    tile_dir = Path(tile_dir).expanduser()
    vrt_path = Path(vrt_path).expanduser()
    vrt_path.parent.mkdir(parents=True, exist_ok=True)

    tile_id = tile_dir.stem
    def _rh_num(path):
        return int(Path(path).name.split("RH")[-1].split("_")[0])

    # Skip RH0 (always below ground). Band i must be RH(VRT_FIRST_RH + i) —
    # `_chunk_diversity` reads RH25/RH98 by band index.
    files = sorted(
        (f for f in glob.glob(f"{tile_dir}/RH*_Q{q_idx}.tif") if _rh_num(f) >= VRT_FIRST_RH),
        key=_rh_num,
    )
    print(f"Creating VRT for {tile_id} with {len(files)} files")
    rh_nums = [_rh_num(f) for f in files]
    assert rh_nums == list(range(VRT_FIRST_RH, N_RH)), (
        f"Expected RH{VRT_FIRST_RH}..RH100 ({VRT_N_BANDS} files) in {tile_dir}, found {rh_nums}"
    )

    vrt_options = gdal.BuildVRTOptions(separate=True)
    vrt = gdal.BuildVRT(str(vrt_path), files, options=vrt_options)

    for i, rh in enumerate(rh_nums, start=1):
        band = vrt.GetRasterBand(i)
        band.SetDescription(f"RH{rh}")

    vrt.FlushCache()
    vrt = None
    return vrt_path


# def vertical_profile(rhs, min_rh=-20, max_rh=50, step=1, window=3):
#     """Convert RH values → vertical energy density profile.

#     Parameters
#     ----------
#     rhs : array-like
#         RH height values (RH0–RH100), length typically 101.
#     min_rh, max_rh : float
#         Height range for output grid.
#     step : float
#         Height bin spacing (metres).
#     window : int
#         Savitzky-Golay smoothing window (odd integer).

#     Returns
#     -------
#     x : ndarray
#         Height grid.
#     smoothed_grad : ndarray
#         Smoothed energy density at each height.
#     """
#     rhs_arr = np.asarray(rhs, dtype=np.float32)
#     rhs_arr = rhs_arr[np.isfinite(rhs_arr)]
#     x = np.arange(min_rh, max_rh + step, step, dtype=np.float32)

#     if rhs_arr.size < 3:
#         return x, np.zeros_like(x, dtype=np.float32)

#     # Unique heights with counts to preserve energy from duplicate RH values
#     rhs_unique, counts = np.unique(np.sort(rhs_arr), return_counts=True)
#     if rhs_unique.size < 3:
#         return x, np.zeros_like(x, dtype=np.float32)

#     # Cumulative percentile (accounts for duplicates correctly)
#     cumulative = np.cumsum(counts).astype(np.float32)

#     # Energy density = d(cumulative) / d(height)
#     grad = np.gradient(cumulative, rhs_unique)
#     grad = np.nan_to_num(grad, nan=0.0, posinf=0.0, neginf=0.0)

#     # Resample onto uniform height grid
#     grad_inter = interp1d(rhs_unique, grad, kind='linear',
#                           fill_value=0, bounds_error=False)
#     grad_resampled = grad_inter(x)

#     # Savitzky-Golay smoothing with safe window size
#     max_window = (int(grad_resampled.size)
#                   if grad_resampled.size % 2 == 1
#                   else int(grad_resampled.size) - 1)
#     safe_window = min(window if window % 2 == 1 else window + 1, max_window)
#     if safe_window < 3:
#         smoothed_grad = grad_resampled
#     else:
#         smoothed_grad = savgol_filter(grad_resampled, safe_window, 1)

#     return x, smoothed_grad.astype(np.float32)

def vertical_profile(rh, bin_size=0.4, min_rh=-8, max_rh=32,
                            savgol_window=5, savgol_poly=1):
    """Convert RH percentiles → binned energy density + smoothed envelope.

    Returns bin_centers, bin_amp_pct, smoothed_pct.
    """
    bin_centers = np.arange(min_rh + bin_size / 2, max_rh, bin_size)
    bin_amp = np.zeros(len(bin_centers))

    for b, hc in enumerate(bin_centers):
        for i in range(len(rh) - 1):
            if hc >= rh[i] and hc < rh[i + 1]:
                dh = rh[i + 1] - rh[i]
                bin_amp[b] = 1.0 / dh if dh > 0.01 else 0
                break

    bin_amp_pct = bin_amp / bin_amp.sum() * 100
    smoothed_pct = savgol_filter(bin_amp_pct, window_length=savgol_window,
                                 polyorder=savgol_poly)
    return bin_centers, bin_amp_pct, smoothed_pct


def profile_curve_points(rhs):
    """Build the displayed vertical-profile curve for a single RH profile.

    Returns a list of ``{"z", "value", "binned"}`` dicts where ``value`` is
    the Savitzky-Golay smoothed energy %, ``binned`` the raw per-bin energy %.

    The y-axis is fixed to [PROFILE_MIN_HEIGHT, PROFILE_MAX_HEIGHT] by the
    caller, but points outside the actual data extent ([min, max] of the RH
    values) carry no real signal — `vertical_profile` leaves those bins at 0
    and the smoothing makes them flat-line — so they're dropped here. The
    curve therefore spans only the real data; the fixed axis just adds
    head/foot room (see profile_y_bounds()).

    NaN/Inf from the bin-sum normalisation (degenerate / unfilled profile)
    are scrubbed to 0.0. Returns [] if there are < 3 finite RH samples.
    """
    rh = np.asarray(
        [v for v in rhs if v is not None and np.isfinite(v)],
        dtype=np.float64,
    )
    if rh.size < 3:
        return []
    bin_centers, bin_amp_pct, smoothed_pct = vertical_profile(
        rh,
        bin_size=PROFILE_BIN_SIZE,
        min_rh=PROFILE_MIN_HEIGHT,
        max_rh=PROFILE_MAX_HEIGHT,
        savgol_window=PROFILE_SMOOTH_WINDOW,
    )
    bin_amp_pct = np.nan_to_num(bin_amp_pct, nan=0.0, posinf=0.0, neginf=0.0)
    smoothed_pct = np.nan_to_num(smoothed_pct, nan=0.0, posinf=0.0, neginf=0.0)
    z_lo, z_hi = float(rh.min()), float(rh.max())
    out = []
    for z, sm, bn in zip(
        bin_centers.tolist(), smoothed_pct.tolist(), bin_amp_pct.tolist()
    ):
        if z < z_lo or z > z_hi:
            continue
        out.append({"z": float(z), "value": float(sm), "binned": float(bn)})
    return out


def profile_y_bounds():
    """Fixed (min, max) height bounds for the vertical-profile y-axis.

    The plotted curve is trimmed to the data extent, but the axis stays
    fixed to these so different points are visually comparable."""
    return float(PROFILE_MIN_HEIGHT), float(PROFILE_MAX_HEIGHT)


if __name__ == "__main__":
    tile_id = '34NEJ'
    year = 2020
    vrt_path = f"~/data/gvs/products/vsm/{year}/original/vrt/{tile_id}_Q1.vrt"
    output_path = f"~/data/gvs/products/diversity_indices/{year}/original/tiles/geotiff/{tile_id}.tif"

    # Create VRT if needed
    tile_dir = f"~/data/gvs/products/vsm/{year}/original/tiles/cog/{tile_id}"
    vrt_resolved = Path(vrt_path).expanduser()
    if not vrt_resolved.exists():
        create_vrt(tile_dir, vrt_path)

    start = time.time()
    compute_entropy(
        output_path=output_path,
        tile_id=tile_id,
        year=year,
        vrt_path=vrt_path,
        chunk_size=512,
        max_workers=8,
    )
    elapsed = time.time() - start
    print(f"Time taken: {elapsed:.2f} seconds")