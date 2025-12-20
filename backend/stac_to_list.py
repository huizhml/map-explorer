import json, sys, os
import pystac
from dataclasses import dataclass
import hydra
from pathlib import Path
from hydra.core.config_store import ConfigStore
from cogeo_mosaic.mosaic import MosaicJSON
from cogeo_mosaic.backends import MosaicBackend

MINZ, MAXZ = 6, 14  

def stac_to_list(collection_json: str, out_mosaic_json_dir: str):
    import ipdb; ipdb.set_trace()
    collection_json = Path(collection_json).expanduser()
    out_mosaic_json_dir = Path(out_mosaic_json_dir).expanduser()
    coll = pystac.read_file(collection_json)
    
    for i in range(1, 101):
        urls = []
        for item in coll.get_items():
            asset = item.assets.get(f"RH{i}_Q1.cog.tif")
            if asset:
                # ensure absolute file:// for local COGs
                href = asset.href
                # if not href.startswith("file://"):
                #     href = "file://" + os.path.abspath(href)
                urls.append(href)
        mosaic = MosaicJSON.from_urls(urls, minzoom=MINZ, maxzoom=MAXZ)
        # write to disk
        dst = str(out_mosaic_json_dir / f"rh{i}.mosaic.json")
        with MosaicBackend(dst, mosaic_def=mosaic) as m:
            m.write()
        print(f"Wrote {dst} with {len(mosaic.tiles)} tiles, zoom {MINZ}-{MAXZ}")

@dataclass
class StacToList:
    collection_json: str = '~/data/GVS/Deploy/stac_2020/collection.json'
    output_txt_file: str = '~/data/GVS/Deploy/mosaic_2020'
    
cs = ConfigStore.instance()
cs.store(name="config", node=StacToList)


@hydra.main(config_name="config", version_base='1.2')
def main(cfg):
    stac_to_list(cfg.collection_json, cfg.output_txt_file)


if __name__ == "__main__":
    main()