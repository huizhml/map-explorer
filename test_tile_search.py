#!/usr/bin/env python3
"""
Test script for Sentinel-2 tile search endpoint
"""
import requests

# Test the tile coordinates endpoint
url = "http://localhost:8000/sentinel2/tile-coordinates"

# Test various MGRS tiles
test_tiles = [
    "32TMS",  # Copenhagen, Denmark
    "33UUP",  # Southern Sweden
    "31UDQ",  # Paris, France
    "30TXN",  # London, UK
    "INVALID",  # Should fail
]

print("Testing Sentinel-2 Tile Search Endpoint")
print("=" * 50)

for tile_name in test_tiles:
    print(f"\nTesting tile: {tile_name}")
    try:
        response = requests.get(f"{url}/{tile_name}", timeout=30)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            
            if 'error' in data:
                print(f"❌ Error: {data['error']}")
            else:
                print(f"✅ Success!")
                print(f"   Tile: {data.get('tile')}")
                print(f"   Longitude: {data.get('longitude'):.4f}")
                print(f"   Latitude: {data.get('latitude'):.4f}")
        else:
            print(f"❌ HTTP Error {response.status_code}")
            
    except requests.exceptions.ConnectionError:
        print("❌ Connection Error: Is the backend running on http://localhost:8000?")
        break
    except requests.exceptions.Timeout:
        print("❌ Timeout: Request took too long")
    except Exception as e:
        print(f"❌ Error: {e}")

print("\n" + "=" * 50)
print("Testing complete!")

