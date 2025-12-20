#!/usr/bin/env python3
"""
Example script to create a sample GeoParquet file for testing visualization.
"""

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point, Polygon
import numpy as np
from pathlib import Path

def create_sample_geoparquet():
    """Create a sample GeoParquet file with various geometry types."""
    
    # Create sample points
    n_points = 100
    points_data = {
        'id': range(n_points),
        'name': [f'Point_{i}' for i in range(n_points)],
        'value': np.random.normal(100, 20, n_points),
        'category': np.random.choice(['A', 'B', 'C'], n_points),
        'geometry': [
            Point(np.random.uniform(-180, 180), np.random.uniform(-90, 90))
            for _ in range(n_points)
        ]
    }
    
    # Create sample polygons
    n_polygons = 20
    polygons_data = {
        'id': range(n_points, n_points + n_polygons),
        'name': [f'Polygon_{i}' for i in range(n_polygons)],
        'area': np.random.uniform(1000, 10000, n_polygons),
        'type': np.random.choice(['Forest', 'Urban', 'Water'], n_polygons),
        'geometry': [
            Polygon([
                (np.random.uniform(-180, 180), np.random.uniform(-90, 90)),
                (np.random.uniform(-180, 180), np.random.uniform(-90, 90)),
                (np.random.uniform(-180, 180), np.random.uniform(-90, 90)),
                (np.random.uniform(-180, 180), np.random.uniform(-90, 90)),
            ])
            for _ in range(n_polygons)
        ]
    }
    
    # Combine data
    all_data = {**points_data, **polygons_data}
    for key in ['id', 'name', 'geometry']:
        all_data[key] = points_data[key] + polygons_data[key]
    
    # Create GeoDataFrame
    gdf = gpd.GeoDataFrame(all_data, crs='EPSG:4326')
    
    # Add some additional columns
    gdf['created_at'] = pd.Timestamp.now()
    gdf['is_active'] = np.random.choice([True, False], len(gdf))
    
    # Save as GeoParquet
    output_path = Path('sample_data.parquet')
    gdf.to_parquet(output_path)
    
    print(f"Created sample GeoParquet file: {output_path}")
    print(f"Features: {len(gdf)}")
    print(f"Columns: {list(gdf.columns)}")
    print(f"CRS: {gdf.crs}")
    print(f"Bounds: {gdf.total_bounds}")
    
    return output_path

if __name__ == "__main__":
    create_sample_geoparquet()
