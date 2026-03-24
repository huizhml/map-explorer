"""
Compute per-pixel Foliage Height Diversity (Shannon entropy of RH profile)
from 101-band GEDI-like rasters.

Fully vectorized — no for loops, no JAX, no numba.
Uses ThreadPoolExecutor for controlled parallel tile processing
instead of dask's distributed scheduler (which eagerly prefetches
all chunks and blows up memory).

Dependencies: numpy, rasterio, gdal, stackstac, pystac, xarray, rioxarray
"""

from osgeo import gdal
import glob
import rasterio
from rasterio.windows import Window
import numpy as np
from pathlib import Path
import xarray as xr
import rioxarray
import pystac
import stackstac
from scipy.interpolate import interp1d
from scipy.signal import savgol_filter
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import psutil
import os
import subprocess
from time import time


MAX_HEIGHT = 1000.0
N_BINS = 20
BIN_WIDTH = MAX_HEIGHT / N_BINS
NODATA_IN = 32767
NODATA_OUT = -9999.0
stac_collection_dir = '~/data/gvs/products/gvsm_stac_catalog/vsm_local'


def pixel_fhd(rhs, interval=50):
    """
    Compute per-pixel FHD using a simple histogram approach.
    interval: height interval in meters
    Returns:
        fhd: per-pixel FHD
    """
    rhs_arr = np.asarray(rhs, dtype=np.float32)
    rhs_arr = rhs_arr[np.isfinite(rhs_arr)]
    n_bins = int(MAX_HEIGHT / interval)
    hist, bins = np.histogram(rhs_arr, bins=n_bins, range=(0, MAX_HEIGHT))
    p = hist / hist.sum()
    fhd = -np.sum(p * np.log(p), axis=-1).astype(np.float32)
    return fhd


def _entropy_chunk(tile):
    n_bands, n_rows, n_cols = tile.shape
    n_pixels = n_rows * n_cols

    valid = np.isfinite(tile) & (tile != NODATA_IN)
    n_valid = valid.sum(axis=0)
    nodata_mask = n_valid == 0

    tile_clean = np.where(valid, tile, 0.0)
    bin_idx = np.clip((tile_clean / BIN_WIDTH).astype(np.int32), 0, N_BINS - 1)
    bin_idx = np.where(valid, bin_idx, 0)
    valid_f = valid.astype(np.float32)

    # Vectorized histogram via one-hot — much faster than np.add.at
    flat_bins = bin_idx.reshape(n_bands, n_pixels)        # (101, P)
    flat_valid = valid_f.reshape(n_bands, n_pixels)       # (101, P)
    one_hot = (flat_bins[..., np.newaxis] == np.arange(N_BINS)[np.newaxis, np.newaxis, :])  # (101, P, 20)
    hist = (one_hot * flat_valid[..., np.newaxis]).sum(axis=0)  # (P, 20)

    total = hist.sum(axis=-1, keepdims=True)
    total = np.where(total == 0, 1.0, total)
    p = hist / total

    log_p = np.where(p > 0, np.log(p), 0.0)
    entropy = -np.sum(p * log_p, axis=-1).astype(np.float32)

    entropy = entropy.reshape(n_rows, n_cols)
    entropy[nodata_mask] = NODATA_OUT
    return entropy

# def _entropy_chunk(tile):
#     """
#     Vectorized Shannon entropy for a single spatial chunk.

#     Parameters
#     ----------
#     tile : ndarray, shape (101, rows, cols)

#     Returns
#     -------
#     out : ndarray, shape (rows, cols), float32
#     """
#     n_bands, n_rows, n_cols = tile.shape
#     n_pixels = n_rows * n_cols

#     # Mask valid data
#     valid = np.isfinite(tile) & (tile != NODATA_IN)
#     n_valid = valid.sum(axis=0)
#     nodata_mask = n_valid == 0

#     # Clean nodata for safe binning
#     tile_clean = np.where(valid, tile, 0.0)

#     bin_idx = np.clip((tile_clean / BIN_WIDTH).astype(np.int32), 0, N_BINS - 1)
#     bin_idx = np.where(valid, bin_idx, -1)

#     # Flatten spatial dims
#     bin_flat = bin_idx.reshape(n_bands, n_pixels)
#     pixel_indices = np.broadcast_to(
#         np.arange(n_pixels)[np.newaxis, :], (n_bands, n_pixels)
#     )

#     # Scatter into histogram
#     hist = np.zeros((n_pixels, N_BINS), dtype=np.float32)
#     flat_valid = bin_flat != -1
#     np.add.at(hist, (pixel_indices[flat_valid], bin_flat[flat_valid]), 1.0)

#     # Normalize
#     total = hist.sum(axis=-1, keepdims=True)
#     total = np.where(total == 0, 1.0, total)
#     p = hist / total

#     # Shannon entropy
#     log_p = np.zeros_like(p)
#     nonzero = p > 0
#     log_p[nonzero] = np.log(p[nonzero])
#     entropy = -np.sum(p * log_p, axis=-1).astype(np.float32)

#     # Reshape and apply nodata
#     entropy = entropy.reshape(n_rows, n_cols)
#     entropy[nodata_mask] = NODATA_OUT

#     return entropy


class ProgressMonitor:
    """
    Background thread that prints speed and RAM stats every `interval` seconds.
    """

    def __init__(self, total_tiles, interval=5.0):
        self.total = total_tiles
        self.done = 0
        self.interval = interval
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._start_time = time()
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
        # Final print
        self._print_status()

    def _print_status(self):
        with self._lock:
            done = self.done
        elapsed = time() - self._start_time
        mem = self._process.memory_info()
        rss_gb = mem.rss / (1024 ** 3)
        rate = done / elapsed if elapsed > 0 else 0
        eta = (self.total - done) / rate if rate > 0 else float('inf')
        pct = 100 * done / self.total if self.total > 0 else 0
        print(
            f"  [{done}/{self.total}] {pct:5.1f}% | "
            f"{rate:.2f} tiles/s | "
            f"elapsed {elapsed:.0f}s | "
            f"ETA {eta:.0f}s | "
            f"RAM {rss_gb:.2f} GB"
        )


def compute_entropy_dask(output_path, year, tile_id, chunk_size=512, max_workers=4):
    """
    Compute per-pixel FHD entropy with controlled parallel tile processing.

    Uses ThreadPoolExecutor to process spatial windows in parallel.
    At most `max_workers` tiles are in memory at once, avoiding the
    memory explosion caused by dask's breadth-first scheduler.

    Memory usage: ~max_workers × 101 × chunk_size² × 4 bytes
    e.g. 4 workers × 101 × 512² × 4 ≈ 400 MB

    Parameters
    ----------
    output_path : str
        Output single-band GeoTIFF path.
    year : int
        Year for STAC catalog lookup.
    tile_id : str
        Tile identifier (e.g. '36NTF').
    chunk_size : int
        Spatial chunk size in pixels (rows and cols).
    max_workers : int
        Number of parallel threads for fetch+compute.
    """
    output_path = Path(output_path).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Load STAC item and create lazy stackstac DataArray
    stac_file = f'{stac_collection_dir}/{tile_id}_{year}/{tile_id}_{year}.json'
    stac_file = Path(stac_file).expanduser()
    item = pystac.Item.from_file(stac_file)

    data = stackstac.stack(
        item,
        chunksize=chunk_size,
        assets=[f'RH{i}_Q1' for i in range(101)],
        resolution=10,
        rescale=False,
        dtype='float32',
        fill_value=np.float32(np.nan),
    ).squeeze()

    ny, nx = data.sizes["y"], data.sizes["x"]

    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "height": ny,
        "width": nx,
        "count": 1,
        "crs": data.rio.crs,
        "transform": data.rio.transform(),
        "nodata": NODATA_OUT,
        "compress": None,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
    }

    # Build list of spatial windows
    windows = []
    for row_off in range(0, ny, chunk_size):
        for col_off in range(0, nx, chunk_size):
            h = min(chunk_size, ny - row_off)
            w = min(chunk_size, nx - col_off)
            windows.append((row_off, col_off, h, w))

    print(f"Processing {len(windows)} spatial tiles with {max_workers} workers")
    print(f"Estimated peak RAM: ~{max_workers * 101 * chunk_size**2 * 4 / 1e9:.1f} GB")

    def fetch_and_compute(row_off, col_off, h, w):
        """Fetch 101 bands for one spatial tile, compute entropy, return result."""
        tile = data[:, row_off:row_off + h, col_off:col_off + w].values
        ent = _entropy_chunk(tile)
        return ent, Window(col_off, row_off, w, h)

    # rasterio write lock — GeoTIFF writes are not thread-safe
    write_lock = threading.Lock()
    monitor = ProgressMonitor(total_tiles=len(windows), interval=5.0)

    with rasterio.open(output_path, "w", **profile) as dst:
        monitor.start()
        try:
            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                futures = {
                    pool.submit(fetch_and_compute, *w): i
                    for i, w in enumerate(windows)
                }
                for fut in as_completed(futures):
                    ent, win = fut.result()
                    with write_lock:
                        dst.write(ent[np.newaxis, :, :], window=win)
                    monitor.tick()
        finally:
            monitor.stop()

    print(f"Done: {output_path}")


def create_vrt(tile_dir, vrt_path, q_idx="1"):
    tile_dir = Path(tile_dir).expanduser()
    vrt_path = Path(vrt_path).expanduser()
    vrt_path.parent.mkdir(parents=True, exist_ok=True)

    tile_id = tile_dir.stem
    files = sorted(
        glob.glob(f"{tile_dir}/RH*_Q{q_idx}.tif"),
        key=lambda x: int(x.split("RH")[-1].split("_")[0]),
    )
    print(f"Creating VRT for {tile_id} with {len(files)} files")
    assert len(files) == 101, f"Expected 101 files, found {len(files)}"

    vrt_options = gdal.BuildVRTOptions(separate=True)
    vrt = gdal.BuildVRT(str(vrt_path), files, options=vrt_options)

    for i in range(1, 102):
        band = vrt.GetRasterBand(i)
        band.SetDescription(f"RH{i - 1}")

    vrt.FlushCache()
    vrt = None

    return vrt_path


def vertical_profile(rhs, min_rh=-200, max_rh=500, step=1, window=31):
    rhs_arr = np.asarray(rhs, dtype=np.float32)
    rhs_arr = rhs_arr[np.isfinite(rhs_arr)]
    x = np.arange(min_rh, max_rh + step, step, dtype=np.float32)

    if rhs_arr.size < 3:
        return x, np.zeros_like(x, dtype=np.float32)

    rhs_unique = np.unique(np.sort(rhs_arr))
    if rhs_unique.size < 3:
        return x, np.zeros_like(x, dtype=np.float32)

    ones = np.arange(rhs_unique.size, dtype=np.float32)
    grad = np.gradient(ones, rhs_unique)
    grad = np.nan_to_num(grad, nan=0.0, posinf=0.0, neginf=0.0)
    grad_inter = interp1d(rhs_unique, grad, kind='linear', fill_value=0, bounds_error=False)
    grad_resampled = grad_inter(x)

    max_window = int(grad_resampled.size) if grad_resampled.size % 2 == 1 else int(grad_resampled.size) - 1
    safe_window = min(window if window % 2 == 1 else window + 1, max_window)
    if safe_window < 3:
        smoothed_grad = grad_resampled
    else:
        smoothed_grad = savgol_filter(grad_resampled, safe_window, 1)
    return x, smoothed_grad.astype(np.float32)


def translate_to_cog(input_path, output_path, compress="ZSTD"):
    translate_cmd = [
        "gdal_translate",
        str(input_path),
        str(output_path),
        "-of", "COG",
        "-co", f"COMPRESS={compress}",
        "-co", "OVERVIEW_RESAMPLING=AVERAGE",
    ]
    gdal.Translate(str(output_path), str(input_path), format="COG", creationOptions=[f"COMPRESS={compress}", "OVERVIEW_RESAMPLING=AVERAGE"])


if __name__ == "__main__":

    tile_id = '36NTF'
    output_path = f"~/data/gvs/products/profile_entropy/{tile_id}.tif"

    start = time()
    compute_entropy_parallel(
        output_path=output_path,
        year=2020,
        tile_id=tile_id,
        chunk_size=512,
        max_workers=8,
    )
    cog_output_path = output_path.replace(".tif", "_cog.tif")
    translate_to_cog(output_path, cog_output_path)
    end = time()
    print(f"Time taken: {end - start:.2f} seconds")