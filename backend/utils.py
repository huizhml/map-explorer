from rio_tiler.io import Reader
import morecantile
from pathlib import Path

# Web Mercator is the default tiling scheme for most web map clients
WEB_MERCATOR_TMS = morecantile.tms.get("WebMercatorQuad")
year = 2020
tile_id = '32MQE'
rh_idx = 98
q_idx = 1
# tif_path = Path(f'~/data/GVS/Deploy/predictions_{year}/{tile_id}_cog/RH{rh_idx}_Q{q_idx}.cog.tif').expanduser()
tile_id = '48NTJ_cog'
rh_idx = 98
q_idx = 1 # median prediction
erda_link=f'https://sid.erda.dk/cgi-sid/ls.py?share_id=evze6lxv0t&current_dir={tile_id}&flags=f'
file_url = f'https://sid.erda.dk/share_redirect/evze6lxv0t/{tile_id}/RH{rh_idx}_Q{q_idx}.cog.tif'

with Reader(str(file_url), tms=WEB_MERCATOR_TMS) as src:
    bbox = src.get_geographic_bounds("epsg:4326")
    zoom = 14
    # Find all tiles covering the bounding box
    tiles = list(src.tms.tiles(bbox[0], bbox[1], bbox[2], bbox[3], zoom))
    for t in tiles:
        print("Tile coordinate (x, y, z):", t.x, t.y, t.z)