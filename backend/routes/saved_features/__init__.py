"""Persistent storage for user-saved map features.

This used to be a single 2.6 kLOC `saved_features.py` module; it has been
split into focused submodules. The public surface stays unchanged — `app.py`
imports `router` and `init_saved_features_db`, and `routes/auxiliary.py`
imports `_stitch_bbox_satellite` / `_burn_scale_bar` — so existing callers
keep working without any edits.
"""

from .db import init_saved_features_db
from .routes import router
from .satellite import _burn_scale_bar, _stitch_bbox_satellite

__all__ = [
    "router",
    "init_saved_features_db",
    "_stitch_bbox_satellite",
    "_burn_scale_bar",
]
