"""
Compute per-pixel Foliage Height Diversity (Shannon entropy of RH profile)
from 101-band GEDI-like rasters.

Fully vectorized — no for loops, no JAX, no numba.
Dependencies: numpy, rasterio, gdal
"""

from osgeo import gdal
import glob
import rasterio
from rasterio.windows import Window
import numpy as np
from pathlib import Path
import dask.array as da
import xarray as xr
import rioxarray
import pystac
import stackstac
from scipy.interpolate import interp1d
from scipy.signal import savgol_filter

MAX_HEIGHT = 1000.0
N_BINS = 20
BIN_WIDTH = MAX_HEIGHT / N_BINS
NODATA_IN = 32767
NODATA_OUT = -9999.0
stac_collection_dir = '~/data/gvs/products/gvsm_stac_catalog/vsm_local'


def _entropy_chunk(tile):
    """
    Vectorized Shannon entropy for a single dask chunk.
 
    Parameters
    ----------
    tile : ndarray, shape (101, rows, cols)
 
    Returns
    -------
    out : ndarray, shape (1, rows, cols), float32
    """
    n_bands, n_rows, n_cols = tile.shape
    n_pixels = n_rows * n_cols
 
    # Mask valid data
    valid = tile != NODATA_IN
    n_valid = valid.sum(axis=0)
    nodata_mask = n_valid == 0
 
    # Clean nodata for safe binning
    tile_clean = np.where(valid, tile, 0.0)
 
    bin_idx = np.clip((tile_clean / BIN_WIDTH).astype(np.int32), 0, N_BINS - 1)
    bin_idx = np.where(valid, bin_idx, -1)
 
    # Flatten spatial dims
    bin_flat = bin_idx.reshape(n_bands, n_pixels)
    pixel_indices = np.broadcast_to(
        np.arange(n_pixels)[np.newaxis, :], (n_bands, n_pixels)
    )
 
    # Scatter into histogram
    hist = np.zeros((n_pixels, N_BINS), dtype=np.float32)
    flat_valid = bin_flat != -1
    np.add.at(hist, (pixel_indices[flat_valid], bin_flat[flat_valid]), 1.0)
 
    # Normalize
    total = hist.sum(axis=-1, keepdims=True)
    total = np.where(total == 0, 1.0, total)
    p = hist / total
 
    # Shannon entropy — compute log only on nonzero entries to avoid log(0)
    log_p = np.zeros_like(p)
    nonzero = p > 0
    log_p[nonzero] = np.log(p[nonzero])
    entropy = -np.sum(p * log_p, axis=-1).astype(np.float32)
 
    # Reshape and apply nodata
    entropy = entropy.reshape(n_rows, n_cols)
    entropy[nodata_mask] = NODATA_OUT
 
    return entropy[np.newaxis, :, :]
 
def _stack_and_entropy(*bands):
    """
    Receives 101 individual (1, rows, cols) arrays from blockwise,
    stacks them, and computes entropy in one shot.
 
    This function IS the fused fetch→compute step. Dask calls it as
    soon as all 101 bands for a single spatial tile are ready —
    no rechunk barrier needed.
    """
    tile = np.concatenate(bands, axis=0)  # (101, rows, cols)
    return _entropy_chunk(tile)
 
def compute_entropy_dask(input_path, output_path, year,chunk_size=512):
    """
    Compute per-pixel FHD entropy using dask for parallel chunk processing.
 
    Parameters
    ----------
    input_path : str
        Path to 101-band VRT or multi-band GeoTIFF.
    output_path : str
        Output single-band GeoTIFF path.
    chunk_size : int
        Spatial chunk size for dask (rows and cols).
    """
    # Lazy load — keep all 101 bands together per spatial chunk
    input_path = Path(input_path).expanduser()
    output_path = Path(output_path).expanduser()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    stac_file =  f'{stac_collection_dir}/{tile_id}_{year}/{tile_id}_{year}.json'
    stac_file = Path(stac_file).expanduser()
    item = pystac.Item.from_file(stac_file)
    data = stackstac.stack(item, chunksize=chunk_size,
                assets=[f'RH{i}_Q1' for i in range(101)],
                resolution=10, rescale=False, dtype='float32', fill_value=np.float32(np.nan))
    data = data.squeeze()

    # data = rioxarray.open_rasterio(
    #     input_path,
    #     chunks={"band": 101, "y": chunk_size, "x": chunk_size},
    # )
    # data.data shape: (101, rows, cols)
    bands = [data.data[i:i+1, :, :] for i in range(101)]
    in_chunks = data.data.chunks  # ((101,), (512,...,rem), (512,...,rem))

 
    # map_blocks: input (101, cy, cx) -> output (1, cy, cx)
    # drop_axis=0 removes the band axis, new_axis=0 re-inserts it as size 1
    entropy_dask = da.map_blocks(
        _entropy_chunk,
        data.data,
        dtype=np.float32,
        drop_axis=0,
        new_axis=0,
        chunks=(1, *in_chunks[1:]),
    )
    # entropy_dask shape: (1, rows, cols) with correct chunk sizes
 
    # Wrap back into a DataArray with original spatial coords
    entropy_da = xr.DataArray(
        entropy_dask,
        dims=("band", "y", "x"),
        coords={"y": data.y, "x": data.x, "band": [1]},
    )
    
    entropy_da = entropy_da.compute()
    entropy_da = entropy_da.rio.write_crs(data.rio.crs)
    entropy_da = entropy_da.rio.write_transform(data.rio.transform())
    entropy_da = entropy_da.rio.write_nodata(NODATA_OUT)
 
    # Compute and write — dask parallelizes across chunks
    
    entropy_da.rio.to_raster(
        output_path,
        driver="GTiff",
        dtype="float32",
        tiled=True,
        windowed=True,
        compress="deflate",
        lock=True,
    )
    # print(f"Done: {output_path}")


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

    # Savitzky-Golay requires odd window length and window <= len(signal).
    max_window = int(grad_resampled.size) if grad_resampled.size % 2 == 1 else int(grad_resampled.size) - 1
    safe_window = min(window if window % 2 == 1 else window + 1, max_window)
    if safe_window < 3:
        smoothed_grad = grad_resampled
    else:
        smoothed_grad = savgol_filter(grad_resampled, safe_window, 1)
    return x, smoothed_grad.astype(np.float32)

if __name__ == "__main__":
    from time import time
    import os
    from dask.distributed import LocalCluster, Client
    cluster = LocalCluster(n_workers=4, dashboard_address=":8000")
    client = Client(cluster)
    print(f"Client connected to cluster with {client.dashboard_link}")
    tile_id = '36NTF'
    vrt_path = f"~/data/gvs/predictions/2020/original/vrt/{tile_id}_Q1.vrt"
    output_path = f"~/data/gvs/products/profile_entropy/{tile_id}.tif"
    
    start = time()
    if not os.path.exists(output_path):
        tile_dir = f"~/data/gvs/predictions/2020/original/tiles/cog/{tile_id}"
        create_vrt(tile_dir, vrt_path)
    compute_entropy_dask(
        input_path=vrt_path,
        output_path=output_path,
        year=2020,
    )
    end = time()
    print(f"Time taken: {end - start:.2f} seconds")