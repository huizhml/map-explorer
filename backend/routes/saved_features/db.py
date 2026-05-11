"""SQLite persistence for saved map features."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from .config import ALLOWED_GEOMETRY_TYPES, DB_PATH, IMAGE_ROOT


# Single source of truth for the SELECT columns used by every read path.
FEATURE_COLUMNS = (
    "id, name, description, category, geometry_type, geometry_json, "
    "metadata_json, plot_data_json, created_at"
)


def db_connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    IMAGE_ROOT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_saved_features_db() -> None:
    with db_connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_features (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                category TEXT,
                feature_key TEXT,
                geometry_type TEXT NOT NULL,
                geometry_json TEXT NOT NULL,
                metadata_json TEXT,
                plot_data_json TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        existing_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(saved_features)").fetchall()
        }
        if "metadata_json" not in existing_columns:
            conn.execute("ALTER TABLE saved_features ADD COLUMN metadata_json TEXT")
        if "plot_data_json" not in existing_columns:
            conn.execute("ALTER TABLE saved_features ADD COLUMN plot_data_json TEXT")
        if "feature_key" not in existing_columns:
            conn.execute("ALTER TABLE saved_features ADD COLUMN feature_key TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_saved_features_feature_key "
            "ON saved_features(feature_key)"
        )
        rows = conn.execute(
            "SELECT id, geometry_type, geometry_json, metadata_json "
            "FROM saved_features WHERE feature_key IS NULL OR feature_key = ''"
        ).fetchall()
        for row in rows:
            try:
                geom = {
                    "type": row["geometry_type"],
                    "coordinates": json.loads(row["geometry_json"]),
                }
                metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else None
                feature_key = compute_feature_key(geom, metadata)
                conn.execute(
                    "UPDATE saved_features SET feature_key = ? WHERE id = ?",
                    (feature_key, row["id"]),
                )
            except Exception:
                continue
        conn.commit()


def validate_geometry(geometry: Dict[str, Any]) -> None:
    geom_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geom_type not in ALLOWED_GEOMETRY_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported geometry type")
    if coordinates is None:
        raise HTTPException(status_code=400, detail="Geometry coordinates are required")


def row_to_feature(row: sqlite3.Row) -> Dict[str, Any]:
    geometry = {
        "type": row["geometry_type"],
        "coordinates": json.loads(row["geometry_json"]),
    }
    metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else None
    plot_data = json.loads(row["plot_data_json"]) if row["plot_data_json"] else None
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "category": row["category"],
        "geometry": geometry,
        "metadata": metadata,
        "plot_data": plot_data,
        "created_at": row["created_at"],
    }


def _canonicalize_coordinates(coords: Any) -> Any:
    if isinstance(coords, (list, tuple)):
        if len(coords) == 2 and all(isinstance(v, (int, float)) for v in coords):
            return [round(float(coords[0]), 6), round(float(coords[1]), 6)]
        return [_canonicalize_coordinates(item) for item in coords]
    return coords


def compute_feature_key(
    geometry: Dict[str, Any],
    metadata: Optional[Dict[str, Any]],
) -> str:
    meta = metadata or {}
    key_payload = {
        "geometry_type": geometry.get("type"),
        "coordinates": _canonicalize_coordinates(geometry.get("coordinates")),
        "source": meta.get("source"),
        "tile_name": meta.get("tile_name"),
    }
    raw = json.dumps(key_payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def upsert_feature(
    conn: sqlite3.Connection,
    *,
    name: str,
    description: Optional[str],
    category: Optional[str],
    geometry_dict: Dict[str, Any],
    feature_key: str,
    metadata_json: Optional[str],
    plot_data_json: Optional[str],
    created_at: Optional[str] = None,
) -> sqlite3.Row:
    """Insert a new row or UPDATE the existing one keyed by `feature_key`.

    Returns the persisted row. Caller is responsible for `conn.commit()`.
    """
    if created_at is None:
        created_at = datetime.now(timezone.utc).isoformat()
    geom_coords_json = json.dumps(geometry_dict["coordinates"])
    geom_type = geometry_dict["type"]

    existing = conn.execute(
        "SELECT id FROM saved_features WHERE feature_key = ? ORDER BY id DESC LIMIT 1",
        (feature_key,),
    ).fetchone()
    if existing is not None:
        feature_id = existing["id"]
        conn.execute(
            """
            UPDATE saved_features
            SET name = ?, description = ?, category = ?, geometry_type = ?, geometry_json = ?,
                metadata_json = ?, plot_data_json = ?, created_at = ?, feature_key = ?
            WHERE id = ?
            """,
            (
                name, description, category, geom_type, geom_coords_json,
                metadata_json, plot_data_json, created_at, feature_key, feature_id,
            ),
        )
    else:
        cursor = conn.execute(
            f"""
            INSERT INTO saved_features
                (name, description, category, feature_key, geometry_type, geometry_json,
                 metadata_json, plot_data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name, description, category, feature_key, geom_type, geom_coords_json,
                metadata_json, plot_data_json, created_at,
            ),
        )
        feature_id = cursor.lastrowid

    row = conn.execute(
        f"SELECT {FEATURE_COLUMNS} FROM saved_features WHERE id = ?",
        (feature_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to load newly saved feature")
    return row
