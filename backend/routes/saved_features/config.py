"""Filesystem paths and constants shared across the saved-features package."""

from __future__ import annotations

import os
from pathlib import Path

# `__file__` here is .../backend/routes/saved_features/config.py
# → parents[2] = .../backend
_BACKEND_DIR = Path(__file__).resolve().parents[2]

DEFAULT_DB_PATH = _BACKEND_DIR / "data" / "saved_features.db"
DB_PATH = Path(os.environ.get("SAVED_FEATURES_DB_PATH", str(DEFAULT_DB_PATH))).expanduser()

DEFAULT_IMAGE_ROOT = _BACKEND_DIR / "data" / "saved_feature_images"
IMAGE_ROOT = Path(os.environ.get("SAVED_FEATURE_IMAGES_ROOT", str(DEFAULT_IMAGE_ROOT))).expanduser()

ALLOWED_GEOMETRY_TYPES = {"Point", "LineString", "Polygon"}

JRC_TMF_CLASSES = {1:'Undisturbed', 2: 'Degraded', 3: 'Deforested', 4: 'Forest regrowth', 5: 'Water', 6:'Other'}
