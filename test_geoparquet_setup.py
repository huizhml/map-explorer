#!/usr/bin/env python3
"""
Test script to verify GeoParquet functionality.
Run this after installing the backend dependencies.
"""

import sys
import subprocess
from pathlib import Path

def test_imports():
    """Test if all required packages can be imported."""
    try:
        import geopandas as gpd
        import pandas as pd
        import fastapi
        print("✅ All required packages imported successfully")
        return True
    except ImportError as e:
        print(f"❌ Import error: {e}")
        return False

def test_geoparquet_creation():
    """Test creating a simple GeoParquet file."""
    try:
        import geopandas as gpd
        import pandas as pd
        from shapely.geometry import Point
        
        # Create simple test data
        data = {
            'id': [1, 2, 3],
            'name': ['Point A', 'Point B', 'Point C'],
            'geometry': [Point(0, 0), Point(1, 1), Point(2, 2)]
        }
        
        gdf = gpd.GeoDataFrame(data, crs='EPSG:4326')
        test_file = Path('test_sample.parquet')
        gdf.to_parquet(test_file)
        
        # Verify file was created
        if test_file.exists():
            print("✅ GeoParquet file created successfully")
            test_file.unlink()  # Clean up
            return True
        else:
            print("❌ GeoParquet file creation failed")
            return False
            
    except Exception as e:
        print(f"❌ GeoParquet creation error: {e}")
        return False

def main():
    """Run all tests."""
    print("Testing GeoParquet setup...")
    print("=" * 40)
    
    # Test imports
    imports_ok = test_imports()
    
    if imports_ok:
        # Test GeoParquet creation
        geoparquet_ok = test_geoparquet_creation()
        
        if geoparquet_ok:
            print("\n🎉 All tests passed! GeoParquet setup is working correctly.")
            print("\nNext steps:")
            print("1. Start the backend: cd backend && uvicorn app:app --reload --port 8006")
            print("2. Start the frontend: npm run dev")
            print("3. Open http://localhost:9020 and test GeoParquet visualization")
        else:
            print("\n❌ GeoParquet functionality test failed")
    else:
        print("\n❌ Package import test failed")
        print("Please install dependencies: pip install -r backend/requirements.txt")

if __name__ == "__main__":
    main()
