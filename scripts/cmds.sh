  start_persistent_srun "backend" "$jobid" \
    bash -c "'source ~/.bashrc && conda activate gis_app && cd ~/$PROJECT_DIR && source scripts/env.sh && cd backend && uvicorn app:app --reload --host 0.0.0.0 --port $BACKEND_PORT'"
