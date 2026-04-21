#!/usr/bin/env bash

# ============================================================================
#  Map Explorer — One-command cluster launcher
# ============================================================================
#
#  Architecture:
#    - SLURM jobs hold compute node allocations (sbatch sleep infinity)
#    - srun --overlap runs servers in foreground (kept alive as bg processes)
#    - Local SSH forwards go directly through hendrix1 to compute nodes
#    - No gate tunnels needed — hendrix1 can reach compute nodes by hostname
#
#  One-time setup:
#    1. Add to ~/.ssh/config:
#
#         Host hendrix1
#           HostName hendrixgate01fl
#           User <your-cluster-username>
#           ControlMaster auto
#           ControlPath ~/.ssh/sockets/%r@%h-%p
#           ControlPersist 10h
#           ServerAliveInterval 30
#           ServerAliveCountMax 10
#
#    2. mkdir -p ~/.ssh/sockets
#
#  Usage:
#    ./launch.sh              # launch everything (type password once)
#    ./launch.sh backend      # backend only
#    ./launch.sh frontend     # frontend only
#    ./launch.sh stop         # tear everything down
#    ./launch.sh status       # check running jobs
#    ./launch.sh logs         # tail remote logs
#
# ============================================================================

set -uo pipefail

PROJECT_DIR="map-explorer"
BACKEND_PORT=8006
FRONTEND_PORT=9036
PARTITION="ml4good"
SSH_HOST="hendrix3"

STATE_DIR="$HOME/.map-explorer-cluster"
LOG_DIR="$STATE_DIR/logs"
mkdir -p "$STATE_DIR" "$LOG_DIR"

# --- Colors ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; DIM='\033[2m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[cluster]${RESET} $1"; }
ok()   { echo -e "${GREEN}  ✓${RESET} $1"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $1"; }
die()  { echo -e "${RED}  ✗${RESET} $1"; exit 1; }
fail() { echo -e "${RED}  ✗${RESET} $1"; }
step() { echo -e "\n${BOLD}${CYAN}── $1 ──${RESET}"; }

# ======================== SSH MULTIPLEXING ========================

check_master() { ssh -O check "$1" 2>/dev/null; }

open_master() {
  local host=$1
  if check_master "$host"; then
    ok "Master connection to $host already open"
  else
    log "Opening master connection to ${BOLD}$host${RESET} — enter your password:"
    ssh -fNM "$host"
    if check_master "$host"; then
      ok "Master connection to $host established"
    else
      die "Failed to connect to $host"
    fi
  fi
}

close_master() {
  local host=$1
  if check_master "$host" 2>/dev/null; then
    ssh -O exit "$host" 2>/dev/null || true
    ok "Closed master to $host"
  fi
}

# ======================== PREFLIGHT ========================

preflight() {
  step "Pre-flight checks"

  if ! grep -q "ControlMaster" ~/.ssh/config 2>/dev/null; then
    echo ""
    echo -e "  ${YELLOW}SSH multiplexing not configured. Add to ~/.ssh/config:${RESET}"
    echo ""
    echo "    Host $SSH_HOST"
    echo "      HostName hendrixgate01fl"
    echo "      User <your-cluster-username>"
    echo "      ControlMaster auto"
    echo "      ControlPath ~/.ssh/sockets/%r@%h-%p"
    echo "      ControlPersist 10h"
    echo ""
    echo "  Then: mkdir -p ~/.ssh/sockets"
    die "Please configure SSH multiplexing first"
  fi

  mkdir -p ~/.ssh/sockets
  ok "SSH config has ControlMaster"

  step "Authenticating"
  open_master "$SSH_HOST"

  if ssh "$SSH_HOST" "test -d ~/$PROJECT_DIR"; then
    ok "Found ~/$PROJECT_DIR on $SSH_HOST"
  else
    die "~/$PROJECT_DIR not found on $SSH_HOST"
  fi
}

# ======================== SLURM ========================

submit_slurm_job() {
  local name=$1 mem=$2 cpus=$3
  local jobid_file="$STATE_DIR/${name}_jobid"
  local node_file="$STATE_DIR/${name}_node"

  # Reuse existing allocation if still running
  if [[ -f "$jobid_file" ]]; then
    local existing_id=$(cat "$jobid_file")
    local state=$(ssh "$SSH_HOST" "squeue -j $existing_id -h -o '%T'" 2>/dev/null || echo "")
    if [[ "$state" == "RUNNING" ]]; then
      local node=$(ssh "$SSH_HOST" "squeue -j $existing_id -h -o '%N'" 2>/dev/null)
      echo "$node" > "$node_file"
      ok "Reusing SLURM job $existing_id on $node"
      return 0
    fi
    rm -f "$jobid_file" "$node_file"
  fi

  log "Submitting SLURM job: $name (mem=$mem, cpus=$cpus)..."
  local jobid
  jobid=$(ssh "$SSH_HOST" "sbatch --parsable \
    --job-name=$name \
    -p $PARTITION \
    --mem=$mem \
    --cpus-per-task=$cpus \
    --time=8:00:00 \
    --wrap='sleep infinity'")

  if [[ -z "$jobid" ]]; then
    fail "Failed to submit SLURM job $name"
    return 1
  fi

  echo "$jobid" > "$jobid_file"
  ok "Submitted job $jobid"

  local node="" attempts=0
  while [[ -z "$node" || "$node" == "(None)" ]] && (( attempts < 120 )); do
    sleep 5
    node=$(ssh "$SSH_HOST" "squeue -j $jobid -h -o '%N'" 2>/dev/null || echo "")
    attempts=$((attempts + 1))
    printf "\r${DIM}  ⏳ Waiting for node... (%ds)${RESET}   " "$((attempts * 5))"
  done
  echo ""

  if [[ -z "$node" || "$node" == "(None)" ]]; then
    ssh "$SSH_HOST" "scancel $jobid" 2>/dev/null || true
    fail "Timed out waiting for SLURM allocation"
    return 1
  fi

  echo "$node" > "$node_file"
  ok "Allocated ${BOLD}$node${RESET} (job $jobid)"
}

# ======================== PROCESS MANAGEMENT ========================
#
# Key insight: processes CANNOT be backgrounded inside srun — they die
# when the srun step exits. Instead, we keep srun itself running as a
# foreground process in a backgrounded SSH session on the local machine.
#
# A named pipe (fifo) is used for stdin to keep the SSH session alive.
# Using /dev/null causes immediate EOF which can kill the session.

start_persistent_srun() {
  local label=$1 jobid=$2
  shift 2
  local pid_file="$STATE_DIR/proc_${label}_pid"

  # Kill existing
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
    sleep 1
  fi

  # Create/truncate the log file
  > "$LOG_DIR/${label}.log"

  # Run srun in foreground inside a backgrounded SSH session
  # -T disables pseudo-terminal to avoid issues with background execution
  ssh -T "$SSH_HOST" "srun --jobid=$jobid --overlap $*" \
    </dev/null >>"$LOG_DIR/${label}.log" 2>&1 &
  echo $! > "$pid_file"

  sleep 3

  if kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    ok "$label running (local PID $(cat "$pid_file"))"
    return 0
  else
    fail "$label failed to start — check $LOG_DIR/${label}.log"
    cat "$LOG_DIR/${label}.log" 2>/dev/null | tail -5 | while read -r line; do
      echo -e "    ${DIM}$line${RESET}"
    done
    return 1
  fi
}

setup_local_forward() {
  local label=$1 node=$2 port=$3

  # Cancel any existing forward on this port through the master
  ssh -O cancel -L "$port:localhost:$port" "$SSH_HOST" 2>/dev/null || true
  ssh -O cancel -L "$port:$node:$port" "$SSH_HOST" 2>/dev/null || true

  log "Local forward: localhost:$port → $node:$port"

  # Add the forward directly to the existing master connection
  # This does NOT open a new SSH session — it piggybacks on the master
  if ssh -O forward -L "$port:$node:$port" "$SSH_HOST" 2>/dev/null; then
    ok "Local forward ($label): localhost:$port"
  else
    warn "Local forward ($label) failed"
  fi
}

# ======================== SERVICES ========================

launch_backend() {
  step "Backend"

  if ! submit_slurm_job "dex-backend" "32G" "16"; then
    fail "Backend allocation failed"
    return 1
  fi

  local jobid=$(cat "$STATE_DIR/dex-backend_jobid")
  local node=$(cat "$STATE_DIR/dex-backend_node")

  # Clean up stale processes on the compute node holding the port
  log "Cleaning up port $BACKEND_PORT on $node..."
  ssh "$SSH_HOST" "srun --jobid=$jobid --overlap bash -c '/usr/sbin/fuser -k $BACKEND_PORT/tcp 2>/dev/null; true'" 2>/dev/null || true
  sleep 1

  # Start backend via persistent srun
  log "Starting backend on $node..."
  start_persistent_srun "backend" "$jobid" \
    bash -c "'source ~/.bashrc && conda activate gis_app && cd ~/$PROJECT_DIR && source scripts/env.sh && cd backend && uvicorn app:app --reload --host 0.0.0.0 --port $BACKEND_PORT'"

  # Direct local forward: localhost → hendrix1 → compute node
  setup_local_forward "backend" "$node" "$BACKEND_PORT"

  # Verify end-to-end
  sleep 1
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$BACKEND_PORT" 2>/dev/null | grep -q "[2345]"; then
    ok "Backend verified: http://localhost:$BACKEND_PORT"
  else
    warn "Backend not responding yet — may need a moment to start"
  fi
}

launch_frontend() {
  step "Frontend"

  if ! submit_slurm_job "dex-frontend" "16G" "8"; then
    fail "Frontend allocation failed"
    return 1
  fi

  local jobid=$(cat "$STATE_DIR/dex-frontend_jobid")
  local node=$(cat "$STATE_DIR/dex-frontend_node")

  # Clean up stale processes on the compute node holding the port
  log "Cleaning up port $FRONTEND_PORT on $node..."
  ssh "$SSH_HOST" "srun --jobid=$jobid --overlap bash -c '/usr/sbin/fuser -k $FRONTEND_PORT/tcp 2>/dev/null; true'" 2>/dev/null || true
  sleep 1

  # Start vite with --host so it listens on all interfaces
  # This lets hendrix1 reach it directly by compute node hostname
  log "Starting dev server on $node..."
  start_persistent_srun "frontend" "$jobid" \
    bash -c "'cd ~/$PROJECT_DIR && npx vite --host --port $FRONTEND_PORT'"

  # Direct local forward: localhost → hendrix1 → compute node
  setup_local_forward "frontend" "$node" "$FRONTEND_PORT"

  # Verify end-to-end
  sleep 1
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$FRONTEND_PORT" 2>/dev/null | grep -q "[2345]"; then
    ok "Frontend verified: http://localhost:$FRONTEND_PORT"
  else
    warn "Frontend not responding yet — may need a moment to start"
  fi
}

# ======================== STOP ========================

stop_all() {
  step "Tearing down"

  # Kill persistent srun sessions
  for pidfile in "$STATE_DIR"/proc_*_pid; do
    [[ -f "$pidfile" ]] || continue
    local label=$(basename "$pidfile" _pid | sed 's/^proc_//')
    local pid=$(cat "$pidfile")
    if kill "$pid" 2>/dev/null; then
      ok "Stopped $label (PID $pid)"
    fi
    rm -f "$pidfile"
  done

  # Cancel port forwards through the master
  if check_master "$SSH_HOST" 2>/dev/null; then
    for port in $BACKEND_PORT $FRONTEND_PORT; do
      ssh -O cancel -L "$port:localhost:$port" "$SSH_HOST" 2>/dev/null || true
    done
    # Also cancel with node hostnames
    for service in backend frontend; do
      local node_file="$STATE_DIR/dex-${service}_node"
      if [[ -f "$node_file" ]]; then
        local node=$(cat "$node_file")
        local port=$BACKEND_PORT
        [[ "$service" == "frontend" ]] && port=$FRONTEND_PORT
        ssh -O cancel -L "$port:$node:$port" "$SSH_HOST" 2>/dev/null || true
      fi
    done
    ok "Cancelled port forwards"
  fi

  # Cancel SLURM jobs — reconnect if needed
  local has_jobs=false
  for jobfile in "$STATE_DIR"/*_jobid; do
    [[ -f "$jobfile" ]] && has_jobs=true && break
  done

  if $has_jobs; then
    # Reconnect if master is gone
    if ! check_master "$SSH_HOST" 2>/dev/null; then
      log "Reconnecting to $SSH_HOST to cancel SLURM jobs..."
      open_master "$SSH_HOST"
    fi

    for jobfile in "$STATE_DIR"/*_jobid; do
      [[ -f "$jobfile" ]] || continue
      local name=$(basename "$jobfile" _jobid)
      local jobid=$(cat "$jobfile")
      if ssh "$SSH_HOST" "scancel $jobid" 2>/dev/null; then
        ok "Cancelled $name (job $jobid)"
      else
        warn "Could not cancel $name (job $jobid)"
      fi
      rm -f "$jobfile"
    done
  fi

  rm -f "$STATE_DIR"/*_node
  ok "Cleaned up"

  echo ""
  read -rp "  Close SSH master connection too? [y/N] " reply
  if [[ "$reply" =~ ^[Yy]$ ]]; then
    close_master "$SSH_HOST"
  fi
}

# ======================== STATUS ========================

show_status() {
  step "Cluster Status"
  echo ""

  echo -e "  ${BOLD}SSH${RESET}"
  if check_master "$SSH_HOST" 2>/dev/null; then
    echo -e "    ${GREEN}●${RESET} $SSH_HOST — connected"
  else
    echo -e "    ${RED}●${RESET} $SSH_HOST — disconnected"
  fi

  echo ""
  echo -e "  ${BOLD}SLURM Jobs${RESET}"
  for service in backend frontend; do
    local jobfile="$STATE_DIR/dex-${service}_jobid"
    if [[ -f "$jobfile" ]] && check_master "$SSH_HOST" 2>/dev/null; then
      local jobid=$(cat "$jobfile")
      local info=$(ssh "$SSH_HOST" "squeue -j $jobid -h -o '%T  %N  %M / %l'" 2>/dev/null || echo "NOT FOUND")
      echo -e "    ${GREEN}●${RESET} $service — job $jobid — $info"
    else
      echo -e "    ${DIM}●${RESET} ${DIM}$service — not running${RESET}"
    fi
  done

  echo ""
  echo -e "  ${BOLD}Server Processes (local srun sessions)${RESET}"
  for service in backend frontend; do
    local pidfile="$STATE_DIR/proc_${service}_pid"
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo -e "    ${GREEN}●${RESET} $service — PID $(cat "$pidfile")"
    else
      echo -e "    ${RED}●${RESET} $service — not running"
    fi
  done

  echo ""
  echo -e "  ${BOLD}Port Forwards${RESET}"
  for service in backend frontend; do
    local port=$BACKEND_PORT
    [[ "$service" == "frontend" ]] && port=$FRONTEND_PORT
    if lsof -ti :"$port" &>/dev/null; then
      echo -e "    ${GREEN}●${RESET} $service — localhost:$port"
    else
      echo -e "    ${RED}●${RESET} $service — inactive"
    fi
  done

  echo ""
  echo -e "  ${BOLD}End-to-end${RESET}"
  for service in backend frontend; do
    local port=$BACKEND_PORT
    [[ "$service" == "frontend" ]] && port=$FRONTEND_PORT
    local code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port" 2>/dev/null || echo "000")
    if [[ "$code" != "000" ]]; then
      echo -e "    ${GREEN}●${RESET} $service — http://localhost:$port (HTTP $code)"
    else
      echo -e "    ${RED}●${RESET} $service — not reachable"
    fi
  done
  echo ""
}

# ======================== LOGS ========================

show_logs() {
  local service="${2:-all}"
  step "Logs"

  for svc in backend frontend; do
    [[ "$service" == "all" || "$service" == "$svc" ]] || continue
    local logfile="$LOG_DIR/${svc}.log"
    if [[ -f "$logfile" ]]; then
      echo -e "\n  ${BOLD}── $svc ──${RESET}"
      tail -30 "$logfile"
    else
      echo -e "\n  ${DIM}$svc: no logs${RESET}"
    fi
  done
}

# ======================== RESTART ========================
#
# Quick restart: only kills and re-launches the server process.
# Does NOT touch SLURM allocations or port forwards.

restart_service() {
  local service=$1

  if ! check_master "$SSH_HOST" 2>/dev/null; then
    open_master "$SSH_HOST"
  fi

  local jobid_file="$STATE_DIR/dex-${service}_jobid"
  local node_file="$STATE_DIR/dex-${service}_node"

  if [[ ! -f "$jobid_file" ]] || [[ ! -f "$node_file" ]]; then
    die "No running $service found — use '$0' to launch first"
  fi

  local jobid=$(cat "$jobid_file")
  local node=$(cat "$node_file")

  # Verify SLURM job is still running
  local state=$(ssh "$SSH_HOST" "squeue -j $jobid -h -o '%T'" 2>/dev/null || echo "")
  if [[ "$state" != "RUNNING" ]]; then
    die "SLURM job $jobid is not running — use '$0' to launch fresh"
  fi

  step "Restarting $service on $node"

  # Kill existing srun session
  local pid_file="$STATE_DIR/proc_${service}_pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    kill "$(cat "$pid_file")" 2>/dev/null || true
    sleep 1
    ok "Stopped old $service process"
  fi

  # Clean up stale port on compute node
  local port=$BACKEND_PORT
  [[ "$service" == "frontend" ]] && port=$FRONTEND_PORT
  log "Cleaning up port $port on $node..."
  ssh "$SSH_HOST" "srun --jobid=$jobid --overlap bash -c '/usr/sbin/fuser -k $port/tcp 2>/dev/null; true'" 2>/dev/null || true
  sleep 1

  # Restart the process
  if [[ "$service" == "backend" ]]; then
    log "Starting backend..."
    start_persistent_srun "backend" "$jobid" \
    bash -c "'source ~/.bashrc && conda activate gis_app && cd ~/$PROJECT_DIR && source scripts/env.sh && cd backend && uvicorn app:app --reload --host 0.0.0.0 --port $BACKEND_PORT'"
  else
    log "Starting frontend..."
    start_persistent_srun "frontend" "$jobid" \
      bash -c "'cd ~/$PROJECT_DIR && npx vite --host --port $FRONTEND_PORT'"
  fi

  # Verify
  sleep 2
  if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port" 2>/dev/null | grep -q "[2345]"; then
    ok "$service verified: http://localhost:$port"
  else
    warn "$service not responding yet — check: $0 logs $service"
  fi
}

# ======================== MAIN ========================

case "${1:-all}" in
  all)
    preflight
    launch_backend
    launch_frontend
    echo ""
    echo -e "  ${BOLD}${GREEN}🚀 Everything is up!${RESET}"
    echo ""
    echo -e "  Backend  → ${BOLD}http://localhost:${BACKEND_PORT}${RESET}"
    echo -e "  Frontend → ${BOLD}http://localhost:${FRONTEND_PORT}${RESET}"
    echo ""
    echo -e "  ${DIM}$0 restart backend${RESET}   restart backend only"
    echo -e "  ${DIM}$0 restart frontend${RESET}  restart frontend only"
    echo -e "  ${DIM}$0 status${RESET}            check health"
    echo -e "  ${DIM}$0 logs${RESET}              view logs"
    echo -e "  ${DIM}$0 stop${RESET}              tear down"
    ;;
  backend)  preflight; launch_backend ;;
  frontend) preflight; launch_frontend ;;
  restart)
    if [[ -z "${2:-}" ]]; then
      restart_service "backend"
      restart_service "frontend"
    else
      restart_service "$2"
    fi
    ;;
  stop)     stop_all ;;
  status)   show_status ;;
  logs)     show_logs "$@" ;;
  connect)  open_master "$SSH_HOST"; ok "Ready" ;;
  *)
    echo "Usage: $0 [all|backend|frontend|restart [backend|frontend]|stop|status|logs|connect]"
    exit 1
    ;;
esac