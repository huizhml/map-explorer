import os, json
from datetime import datetime
import pystac
import rasterio
from shapely.geometry import box
from pathlib import Path
import pandas as pd


# ================================
# Create STAC collection for predictions on Erda
# ================================
import subprocess

def get_tiles_list(year):
    output_file = Path(f"backend/tiles_on_erda_{year}.txt").expanduser()
    if output_file.exists():
        print(f"File {output_file} already exists")
        return

    # Build the SFTP batch commands
    sftp_cmd = f"""
    cd GVS/predictions_{year}
    ls -1
    """

    # Run sftp
    result = subprocess.run(
        ["sftp", "-q", "ucph-erda"],
        input=sftp_cmd,
        text=True,
        capture_output=True
    )

    # Filter out sftp prompts
    files = [
        line for line in result.stdout.splitlines()
        if not line.startswith("sftp>")
    ]

    # Write to file
    with open(output_file, "w") as f:
        f.write("\n".join(files))

    print(f"Wrote {len(files)} entries to {output_file}")
    

def check_file_exists(file_url):
    response = subprocess.run(
        ["curl", "-I", file_url],
        capture_output=True,
        text=True
    )
    return "200 OK" in response.stdout


def create_stac_collection(year, out_dir, q_idx):
    erda_endpoint = f'https://sid.erda.dk/share_redirect/evze6lxv0t'
    tiles = pd.read_csv(f"backend/tiles_on_erda_{year}.txt", header=None)[0].tolist()
    out_dir = Path(out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    collection = pystac.Collection(
        id=f"VSM_{year}",
        description=f"Vertical Vegetation Structure Model - {year}",
        extent=pystac.Extent(
            spatial=pystac.SpatialExtent([[-180, -90, 180, 90]]),  # updated below
            temporal=pystac.TemporalExtent([[datetime(2020,1,1), None]])
        ),
        license="proprietary"
    )
    minx=miny=1e9; maxx=maxy=-1e9
    for tile in tiles:
        prediction_tiles = [f'{erda_endpoint}/{tile}/RH{rh_idx}_Q{q_idx}.cog.tif' for rh_idx in range(1, 101)]
        with rasterio.open(prediction_tiles[0]) as src:
            b = src.bounds
        minx, miny = min(minx, b.left),  min(miny, b.bottom)
        maxx, maxy = max(maxx, b.right), max(maxy, b.top)
        geom = box(b.left, b.bottom, b.right, b.top).__geo_interface__
        item = pystac.Item(
            id=f"{tile.split('_')[0]}_{year}",
            geometry=geom,
            bbox=[b.left, b.bottom, b.right, b.top],
            datetime=datetime(year,1,1),
            properties={}
        )
        for url in prediction_tiles:
            response = check_file_exists(url)
            if response:
                print(f"File exists and is downloadable: {url}")
            else:
                print(f"File does not exist: {url}")
                continue
            item.add_asset(
                key=url.split('/')[-1],
                asset=pystac.Asset(
                    href=url,
                    media_type=pystac.MediaType.COG,
                    roles=["data"]
                )
            )
            
        collection.add_item(item)

    # tighten spatial extent
    collection.extent.spatial.bboxes = [[minx, miny, maxx, maxy]]

    # write out
    collection.normalize_hrefs(str(out_dir))
    collection.make_all_asset_hrefs_absolute()
    collection.save(catalog_type=pystac.CatalogType.SELF_CONTAINED)
    import ipdb; ipdb.set_trace()
    print(f"Wrote STAC collection at {out_dir}/collection.json with {len(collection.get_items())} items")



# ================================
# Create STAC collection for predictions on Hendrix
# ================================

# year = 2020
# ROOT = Path(f"~/data/GVS/Deploy/predictions_{year}").expanduser()             # folder containing *_rh98.tif
# OUT  = Path(f"~/data/GVS/Deploy/stac_{year}").expanduser()          # output STAC folder
# OUT.mkdir(parents=True, exist_ok=True)

# collection = pystac.Collection(
#     id=f"VSM_{year}",
#     description=f"Vertical Vegetation Structure Model - {year}",
#     extent=pystac.Extent(
#         spatial=pystac.SpatialExtent([[-180, -90, 180, 90]]),  # updated below
#         temporal=pystac.TemporalExtent([[datetime(2020,1,1), None]])
#     ),
#     license="proprietary"
# )


# # Track overall bounds
# minx=miny=1e9; maxx=maxy=-1e9

# for tile in ROOT.glob('*_cog'):
#     prediction_files = list(tile.glob('RH*_Q1.cog.tif'))
#     if len(prediction_files) < 101:
#         print(f"Tile {tile} has {len(prediction_files)} prediction files")
#         continue
    
    
#     with rasterio.open(prediction_files[0]) as src:
#         b = src.bounds
#     minx, miny = min(minx, b.left),  min(miny, b.bottom)
#     maxx, maxy = max(maxx, b.right), max(maxy, b.top)
#     geom = box(b.left, b.bottom, b.right, b.top).__geo_interface__
#     item = pystac.Item(
#         id=f"{tile.name.split('_')[0]}_{year}",
#         geometry=geom,
#         bbox=[b.left, b.bottom, b.right, b.top],
#         datetime=datetime(year,1,1),
#         properties={}
#     )

#     for path in prediction_files:
#         item.add_asset(
#             key=path.name.split('_')[0],
#             asset=pystac.Asset(
#                 href=f"file://{os.path.abspath(path)}",
#                 media_type=pystac.MediaType.COG,
#                 roles=["data"]
#             )
#         )
        
#     collection.add_item(item)

# # tighten spatial extent
# collection.extent.spatial.bboxes = [[minx, miny, maxx, maxy]]

# # write out
# collection.normalize_hrefs(str(OUT))
# collection.make_all_asset_hrefs_absolute()
# collection.save(catalog_type=pystac.CatalogType.SELF_CONTAINED)

# print(f"Wrote STAC collection at {OUT}/collection.json with {len(collection.get_items())} items")

if __name__ == "__main__":
    year = 2020
    get_tiles_list(year)
    create_stac_collection(year, "backend/stac_2020", 1)