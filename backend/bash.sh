# cogeo-mosaic create \
#     ~/data/GVS/Deploy/mosaic_2020/RHs_cog_list.txt \
#   --minzoom 6 --maxzoom 14 \
#   -o ~/data/GVS/Deploy/mosaic_2020/mosaic_2020.mosaic.json


#   ssh -L 9010:localhost:9010 ksb781@hendrixgate01fl
#   export MOSAIC_DIR='~/data/GVS/Deploy/mosaic_2020'

year=2020
remote_files=$(sftp -q ucph-erda <<EOF | grep -v '^sftp>'
cd GVS/predictions_${year}
ls -1
EOF
)

echo "$remote_files" > tiles_${year}.txt
