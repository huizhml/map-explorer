#!/bin/bash
 
gate_num=${3:-01}
GATE_HOST="hendrixgate${gate_num}fl"
 
case $1 in
1)
  port=${2:-8006}
  echo "Forwarding port $port for backend via $GATE_HOST"
  ssh -N -L $port:localhost:$port "$GATE_HOST"
  ;;
2)
  port=${2:-9030}
  echo "Forwarding port $port for frontend via $GATE_HOST"
  ssh -N -L $port:localhost:$port "$GATE_HOST"
  ;;
*)
  echo "Usage: $0 {1|2} [port] [gate_num]"
  exit 1
  ;;
esac