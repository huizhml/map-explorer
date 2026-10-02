"""Dump FastAPI OpenAPI schema to shared/openapi.json.

Run from repo root: `python scripts/dump_openapi.py`. Picks up the live app
without starting uvicorn, so it's safe to call from CI / npm scripts.
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
OUTPUT = REPO_ROOT / "shared" / "openapi.json"

sys.path.insert(0, str(BACKEND_DIR))

from app import app  # noqa: E402

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n")
print(f"wrote {OUTPUT.relative_to(REPO_ROOT)}")
