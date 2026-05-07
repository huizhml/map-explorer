#!/usr/bin/env python3
"""
Test script to verify GeoJSON functionality.
Run this after installing the backend dependencies.
"""

import sys
import subprocess
import requests
import json
from pathlib import Path

def test_imports():
    """Test if all required packages can be imported."""
    try:
        import requests
        import fastapi
        print("✅ All required packages imported successfully")
        return True
    except ImportError as e:
        print(f"❌ Import error: {e}")
        return False

def test_geojson_url():
    """Test fetching and parsing a sample GeoJSON URL."""
    try:
        # Test with a known working GeoJSON URL
        test_url = "https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson"
        
        print(f"Testing GeoJSON URL: {test_url}")
        
        response = requests.get(test_url, timeout=30)
        response.raise_for_status()
        
        geojson_data = response.json()
        
        # Validate GeoJSON structure
        if not isinstance(geojson_data, dict) or 'type' not in geojson_data:
            print("❌ Invalid GeoJSON format")
            return False
        
        if geojson_data.get('type') != 'FeatureCollection':
            print("❌ Expected FeatureCollection type")
            return False
        
        features = geojson_data.get('features', [])
        if not features:
            print("❌ No features found")
            return False
        
        print(f"✅ GeoJSON loaded successfully")
        print(f"   Type: {geojson_data.get('type')}")
        print(f"   Features: {len(features)}")
        
        # Check first feature
        first_feature = features[0]
        if 'geometry' not in first_feature or 'properties' not in first_feature:
            print("❌ Invalid feature structure")
            return False
        
        print(f"   Geometry type: {first_feature['geometry']['type']}")
        print(f"   Properties: {len(first_feature['properties'])}")
        
        return True
        
    except requests.exceptions.RequestException as e:
        print(f"❌ Network error: {e}")
        return False
    except json.JSONDecodeError as e:
        print(f"❌ JSON parsing error: {e}")
        return False
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return False

def test_backend_endpoints():
    """Test the backend GeoJSON endpoints."""
    try:
        base_url = "http://localhost:8006"
        test_url = "https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson"
        
        print(f"Testing backend endpoints at {base_url}")
        
        # Test info endpoint
        info_response = requests.post(
            f"{base_url}/geojson/info",
            json={"url": test_url},
            timeout=30
        )
        
        if info_response.status_code == 200:
            info_data = info_response.json()
            print(f"✅ Info endpoint working")
            print(f"   Features: {info_data.get('features', 'Unknown')}")
            print(f"   Geometry types: {info_data.get('geometry_types', [])}")
        else:
            print(f"❌ Info endpoint failed: {info_response.status_code}")
            return False
        
        # Test validate endpoint
        validate_response = requests.post(
            f"{base_url}/geojson/validate",
            json={"url": test_url},
            timeout=30
        )
        
        if validate_response.status_code == 200:
            validate_data = validate_response.json()
            if validate_data.get('valid'):
                print(f"✅ Validate endpoint working")
            else:
                print(f"❌ Validation failed: {validate_data.get('error')}")
                return False
        else:
            print(f"❌ Validate endpoint failed: {validate_response.status_code}")
            return False
        
        # Test sample endpoint
        sample_response = requests.post(
            f"{base_url}/geojson/sample",
            json={"url": test_url, "sample_size": 5},
            timeout=30
        )
        
        if sample_response.status_code == 200:
            sample_data = sample_response.json()
            if 'features' in sample_data:
                print(f"✅ Sample endpoint working")
                print(f"   Sampled features: {len(sample_data['features'])}")
            else:
                print(f"❌ Sample endpoint returned invalid data")
                return False
        else:
            print(f"❌ Sample endpoint failed: {sample_response.status_code}")
            return False
        
        return True
        
    except requests.exceptions.ConnectionError:
        print("❌ Backend not running. Start with: cd backend && uvicorn app:app --reload --port 8006")
        return False
    except Exception as e:
        print(f"❌ Backend test error: {e}")
        return False

def main():
    """Run all tests."""
    print("Testing GeoJSON functionality...")
    print("=" * 50)
    
    # Test imports
    imports_ok = test_imports()
    
    if imports_ok:
        # Test GeoJSON URL fetching
        geojson_ok = test_geojson_url()
        
        if geojson_ok:
            # Test backend endpoints
            backend_ok = test_backend_endpoints()
            
            if backend_ok:
                print("\n🎉 All tests passed! GeoJSON functionality is working correctly.")
                print("\nNext steps:")
                print("1. Start the backend: cd backend && uvicorn app:app --reload --port 8006")
                print("2. Start the frontend: npm run dev")
                print("3. Open http://localhost:9020 and test GeoJSON visualization")
                print("\nTry these sample URLs:")
                print("- https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson")
                print("- https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json")
            else:
                print("\n❌ Backend endpoint tests failed")
        else:
            print("\n❌ GeoJSON URL test failed")
    else:
        print("\n❌ Package import test failed")
        print("Please install dependencies: pip install -r backend/requirements.txt")

if __name__ == "__main__":
    main()
