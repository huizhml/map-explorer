#!/bin/bash

case $1 in
1)
port=${2:-8006}
echo "Forwarding port $port for backend"
ssh -N -f -R $port:localhost:$port hendrixgate01fl
;;
2)
port=${2:-9030}
echo "Forwarding port $port for frontend"
ssh -N -f -R $port:localhost:$port hendrixgate01fl
;;
*)
echo "Usage: $0 {1|2}"
exit 1
;;
esac