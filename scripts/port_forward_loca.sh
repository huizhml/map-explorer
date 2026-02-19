#!/bin/bash

gate_num=${3:-01}
case $1 in
1)
port=${2:-8000}
echo "Forwarding port $port for backend"
ssh -L $port:localhost:$port ksb781@hendrixgate${gate_num}fl
;;
2)
port=${2:-9030}
echo "Forwarding port $port for frontend"
ssh -L $port:localhost:$port ksb781@hendrixgate${gate_num}fl
;;
*)
echo "Usage: $0 {1|2}"
exit 1
;;
esac